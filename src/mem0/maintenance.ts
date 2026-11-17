/**
 * Maintenance (mem0 split M9b).
 *
 * Importance backfill, rotating contradiction sweep (cursor-persisted),
 * and the 2h maintenance loop (consolidation → entity resolution →
 * weekly cleanup → graph reconcile → backfill → sweep).
 */

import { listProjects } from '../workspace.js';
import { withDistributedLock } from '../distributed-lock.js';
import { isMem0Configured } from './config.js';
import { scoreImportance } from './scoring.js';
import { getMemoryImportance, setMemoryImportance } from './state.js';
import { getMemories, searchMemory } from './read.js';
import { consolidateMemories } from './consolidation.js';
import {
  deleteMemoriesWithPolicy,
  scanAndCleanProjectMemories,
} from './lifecycle.js';
import type { ContradictionSweepReport } from './types.js';

// ─── Importance Backfill ───

const BACKFILL_PROJECTS = [undefined] as const;

/**
 * Score up to `maxToScore` memories that are missing importance scores.
 * Called periodically by the maintenance loop to ensure all memories are scored.
 * Returns the number of memories scored.
 */
export async function backfillImportanceScores(maxToScore = 50): Promise<number> {
  let totalScored = 0;

  for (const project of BACKFILL_PROJECTS) {
    if (totalScored >= maxToScore) break;
    try {
      const memories = await getMemories(project, 200);
      for (const mem of memories) {
        if (totalScored >= maxToScore) break;
        if (!mem.id) continue;
        const existing = await getMemoryImportance(mem.id);
        if (existing !== null) continue; // already scored
        const score = scoreImportance(mem.memory);
        try {
          await setMemoryImportance(mem.id, score);
        } catch (err) {
          // Maintenance must not die on one bad point — retry next tick.
          console.error(`[mem0] backfillImportance failed for ${mem.id}:`, err instanceof Error ? err.message : err);
          continue;
        }
        totalScored++;
      }
    } catch { /* non-critical — skip project */ }
  }

  return totalScored;
}

// ─── Automatic Memory Maintenance ───

// ─── Rotating contradiction sweep (paraphrase hygiene) ───
// Replaces the old "always the 20 most recent globals" window with a
// round-robin cursor: each tick processes the next slice of one scope
// (global, then each project), persisting progress in-memory.

export function getContradictionFetchLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LAIN_CONTRADICTION_FETCH;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isNaN(n) || n < 1 ? 200 : Math.min(n, 500);
}

export function getContradictionSliceSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LAIN_CONTRADICTION_SLICE;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isNaN(n) || n < 1 ? 20 : Math.min(n, 100);
}

export function getContradictionMaxLlm(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LAIN_CONTRADICTION_MAX_LLM;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isNaN(n) || n < 1 ? 10 : Math.min(n, 100);
}

/** Pure wrap-around slice: returns `size` indices starting at `cursor` (mod total). */
export function nextSliceIndices(total: number, cursor: number, size: number): number[] {
  if (total <= 0 || size <= 0) return [];
  const start = ((Math.floor(cursor) % total) + total) % total;
  const out: number[] = [];
  for (let k = 0; k < Math.min(size, total); k++) out.push((start + k) % total);
  return out;
}

const contradictionCursorFallback = new Map<string, number>();
let contradictionScopeIdxFallback = 0;

function contradictionScopeKey(scope: string | undefined): string {
  return scope ?? 'global';
}

export async function getContradictionCursor(scope: string | undefined): Promise<number> {
  return contradictionCursorFallback.get(contradictionScopeKey(scope)) ?? 0;
}

export async function setContradictionCursor(scope: string | undefined, cursor: number): Promise<void> {
  const safe = Math.max(0, Math.floor(cursor));
  contradictionCursorFallback.set(contradictionScopeKey(scope), safe);
}

async function getContradictionScopeIdx(mod: number): Promise<number> {
  if (mod <= 0) return 0;
  return contradictionScopeIdxFallback % mod;
}

async function setContradictionScopeIdx(idx: number): Promise<void> {
  contradictionScopeIdxFallback = Math.max(0, Math.floor(idx));
}

/** Process one slice of one scope. Never throws on per-memory errors. */
export async function runContradictionSweepForScope(
  scope: string | undefined,
  opts?: { fetchLimit?: number; sliceSize?: number; maxLlm?: number; cursor?: number },
): Promise<ContradictionSweepReport> {
  const fetchLimit = opts?.fetchLimit ?? getContradictionFetchLimit();
  const sliceSize = opts?.sliceSize ?? getContradictionSliceSize();
  const maxLlm = opts?.maxLlm ?? getContradictionMaxLlm();
  const memories = await getMemories(scope, fetchLimit);
  const total = memories.length;
  if (total === 0) {
    return { scope, total: 0, checked: 0, removed: 0, llmCalls: 0, nextCursor: 0, queuedMerges: 0, queuedContradictions: 0 };
  }

  const cursor = opts?.cursor ?? await getContradictionCursor(scope);
  const indices = nextSliceIndices(total, cursor, sliceSize);
  const slice = indices.map(i => memories[i]);

  const { classifyMemoryAction } = await import('../contradiction-detector.js');
  const { logMaintenance } = await import('../maintenance-log.js');
  const { enqueueVerdict } = await import('../pending-review.js');
  let removed = 0;
  let llmCalls = 0;
  let queuedMerges = 0;
  let queuedContradictions = 0;
  const queuedMergeIds: string[] = [];
  const queuedContradictionIds: string[] = [];

  for (const mem of slice) {
    const createdMs = mem.created_at ? new Date(mem.created_at).getTime() : Date.now();
    if (Date.now() - createdMs < 60 * 60 * 1000) continue;

    let others: { id: string; memory: string; score: number }[] = [];
    try {
      const similar = await searchMemory(mem.memory, scope, 5);
      others = similar
        .filter(s => s.id !== mem.id && (s.score ?? 0) > 0.6)
        .map(s => ({ id: s.id, memory: s.memory, score: s.score ?? 0 }));
    } catch {
      continue;
    }
    if (others.length === 0) continue;
    if (llmCalls >= maxLlm) break;

    let classification;
    try {
      classification = await classifyMemoryAction(mem.memory, others);
    } catch {
      continue;
    }
    llmCalls++;

    if (classification.action === 'NOOP' && classification.supersedes.length === 0) {
      try {
        const report = await deleteMemoriesWithPolicy({
          ids: [mem.id],
          project: scope,
          reason: classification.reason,
          trigger: 'maintenance:contradiction_scan',
        });
        if (report.archived.includes(mem.id)) {
          removed++;
          console.log(`[mem0] Maintenance: archived duplicate ${mem.id} (trash: ${report.trashIds[mem.id] ?? 'copy-failed'})`);
          logMaintenance('memory_duplicate_purge', {
            trigger: 'maintenance:contradiction_scan',
            reason: classification.reason,
            deleted: [{ id: mem.id, memory: mem.memory, created_at: mem.created_at ?? null, trash_id: report.trashIds[mem.id] ?? null }],
          });
        }
      } catch { /* per-memory failure never fails the sweep */ }
    } else if (classification.action === 'UPDATE' || classification.action === 'DELETE') {
      // Item 1+3: verdicts the auto-flow must not action alone go to the
      // pending-review queue instead of being dropped. UPDATE → merge
      // candidates for consolidation; DELETE → contradictions for a human.
      try {
        const kind = classification.action === 'UPDATE' ? 'merge' as const : 'contradiction' as const;
        const { entry, duplicate } = await enqueueVerdict({
          kind,
          verdict: classification.action,
          scope,
          memoryId: mem.id,
          memory: mem.memory,
          related: others.map(o => ({ id: o.id, memory: o.memory })),
          reason: classification.reason,
        });
        if (!duplicate) {
          if (kind === 'merge') {
            queuedMerges++;
            queuedMergeIds.push(entry.id);
          } else {
            queuedContradictions++;
            queuedContradictionIds.push(entry.id);
          }
          logMaintenance('pending_review_queued', {
            kind,
            scope: scope ?? 'global',
            memory_id: mem.id,
            entry_id: entry.id,
            reason: classification.reason,
          });
        }
      } catch { /* queue failure never fails the sweep */ }
    }
  }

  const nextCursor = total > 0 ? ((((Math.floor(cursor) % total) + total) % total) + slice.length) % total : 0;
  await setContradictionCursor(scope, nextCursor);
  return { scope, total, checked: slice.length, removed, llmCalls, nextCursor, queuedMerges, queuedContradictions };
}

/** Round-robin over [global, ...projects]: one scope per maintenance tick. */
export async function runRotatingContradictionSweep(): Promise<ContradictionSweepReport> {
  let scopes: (string | undefined)[] = [undefined];
  try {
    for (const p of listProjects()) scopes.push(p.name);
  } catch { /* projects unavailable — global only */ }
  const idx = await getContradictionScopeIdx(scopes.length);
  const scope = scopes[idx % scopes.length];
  const report = await runContradictionSweepForScope(scope);
  await setContradictionScopeIdx((idx + 1) % scopes.length);
  return report;
}

let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
const MAINTENANCE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function startMemoryMaintenance(): void {
  if (maintenanceTimer) return;
  if (!isMem0Configured()) return;

  maintenanceTimer = setInterval(async () => {
    await withDistributedLock('mem0:maintenance', 7_200_000, async () => {
    try {
      const { logMaintenance } = await import('../maintenance-log.js');

      const consolStart = Date.now();
      const result = await consolidateMemories();
      const consolDuration = Date.now() - consolStart;
      if (result.consolidated > 0) {
        console.log(`[mem0] Auto-consolidation: ${result.consolidated} groups merged, ${result.deleted} fragments deleted`);
      }
      logMaintenance('memory_consolidation', {
        consolidated: result.consolidated,
        deleted: result.deleted,
        groups: result.groups,
        details: result.details,
      }, consolDuration);

      const { resolveEntities } = await import('../graphrag.js');
      const resolveStart = Date.now();
      const resolved = await resolveEntities();
      const resolveDuration = Date.now() - resolveStart;
      if (resolved.merged > 0) {
        console.log(`[graphrag] Auto-resolve: ${resolved.merged} duplicate entities merged`);
      }
      logMaintenance('entity_resolution', {
        merged: resolved.merged,
        total: resolved.pairs.length,
      }, resolveDuration);

      // ── Weekly auto-cleanup: runs on Sundays before 6am ──
      const now = new Date();
      if (now.getDay() === 0 && now.getHours() < 6) {
        let weeklyDeleted = 0;
        let weeklyTotal = 0;
        const projects = listProjects().map(p => p.name);
        for (const proj of projects) {
          try {
            const scanStart = Date.now();
            const scanResult = await scanAndCleanProjectMemories(proj);
            const scanDuration = Date.now() - scanStart;
            weeklyDeleted += scanResult.deleted;
            weeklyTotal += scanResult.total;
            if (scanResult.deleted > 0) {
              console.log(`[mem0] Auto-cleanup ${proj}: ${scanResult.deleted}/${scanResult.total} deleted`);
            }
            logMaintenance('auto_cleanup', {
              project: proj,
              total: scanResult.total,
              deleted: scanResult.deleted,
            }, scanDuration);
          } catch (err) {
            console.error(`[mem0] Auto-cleanup error for ${proj}:`, err);
          }
        }
        console.log(`[mem0] Weekly auto-cleanup: ${weeklyDeleted}/${weeklyTotal} deleted across ${projects.length} projects`);
      }

      // ── Graph reconcile (Fase 3): drain outbox, heal derived projection ──
      try {
        const { reconcileGraph } = await import('../graphrag.js');
        const reconciled = await reconcileGraph();
        if (reconciled.processed > 0 || reconciled.failed > 0) {
          console.log(`[graphrag] Maintenance reconcile: ${reconciled.processed} processed, ${reconciled.failed} failed, ${reconciled.pending} pending`);
        }
      } catch (err) {
        console.error('[graphrag] Maintenance reconcile error:', err);
      }

      // ── Importance backfill: score memories missing importance scores ──
      try {
        const backfillStart = Date.now();
        const scored = await backfillImportanceScores(50);
        if (scored > 0) {
          const backfillDuration = Date.now() - backfillStart;
          console.log(`[mem0] Importance backfill: ${scored} memories scored`);
          logMaintenance('importance_backfill', { scored }, backfillDuration);
        }
      } catch (err) {
        console.error('[mem0] Importance backfill error:', err);
      }

      // ── Periodic contradiction scan: rotating slice (1 scope/tick, cursor-persisted) ──
      try {
        const sweepStart = Date.now();
        const sweep = await runRotatingContradictionSweep();
        const sweepDuration = Date.now() - sweepStart;
        if (sweep.removed > 0 || sweep.checked > 0) {
          logMaintenance('contradiction_scan', {
            scope: sweep.scope ?? 'global',
            total: sweep.total,
            checked: sweep.checked,
            removed: sweep.removed,
            llmCalls: sweep.llmCalls,
            nextCursor: sweep.nextCursor,
            queuedMerges: sweep.queuedMerges,
            queuedContradictions: sweep.queuedContradictions,
          }, sweepDuration);
        }
      } catch (err) {
        console.error('[mem0] Contradiction scan error:', err);
      }
    } catch (err) {
      console.error('[mem0] Maintenance error:', err);
    }
    }); // end withDistributedLock
  }, MAINTENANCE_INTERVAL_MS);

  console.log('[mem0] Memory maintenance scheduled (every 2h)');
}

export function stopMemoryMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}
