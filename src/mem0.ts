/**
 * Mem0 Memory Backend
 *
 * Wraps the Mem0 SDK to provide semantic long-term memory.
 * Organizes memories by user (global) and project (scoped).
 *
 * Entity scheme:
 *   - "lucas"         → global preferences/facts
 *   - "lucas:lain"    → project-specific memories
 */

import * as graphrag from './graphrag.js';
import { getRedis, isRedisAvailable } from './redis.js';
import { INSTANCE_ID, listProjects } from './workspace.js';
import { withDistributedLock } from './distributed-lock.js';
import { classifyMemoryAction } from './contradiction-detector.js';
import { incrementMetric } from './mem-metrics.js';
import type { PolicyAuditRecord } from './memory-policy.js';
import type {
  AddMemoryOpts,
  ConsolidationDetail,
  ContradictionSweepReport,
  FeedbackAction,
  FeedbackKind,
  FeedbackStatus,
  MemoryFeedback,
  MemoryLimits,
  MemorySnapshot,
  MemoryTier,
  RankedMemory,
  RestoreResult,
  TrashProvenance,
} from './mem0/types.js';
export type {
  AddMemoryOpts,
  ConsolidationDetail,
  ContradictionSweepReport,
  FeedbackAction,
  FeedbackKind,
  FeedbackStatus,
  MemoryFeedback,
  MemoryLimits,
  MemorySnapshot,
  MemoryTier,
  RankedMemory,
  RestoreResult,
  TrashProvenance,
} from './mem0/types.js';
import { getClient, isMem0Configured, userId, withRetry } from './mem0/config.js';
export { buildMem0Config, isMem0Configured, withRetry } from './mem0/config.js';
import {
  acceptEnrichedMemory,
  applyAgeDecayToResults,
  disqualifyMemory,
  MIN_MEMORY_QUALITY,
  scoreActionability,
  scoreImportance,
  scoreMemoryQuality,
  shouldEnrichTechnicalMemory,
} from './mem0/scoring.js';
import {
  addMemory,
  addMemoryWithConflictCheck,
} from './mem0/write.js';
export {
  addMemory,
  addMemoryWithConflictCheck,
} from './mem0/write.js';
import {
  deleteMemoriesWithPolicy,
  deleteMemory,
  restoreFromTrash,
  scanAndCleanProjectMemories,
  snapshotMemories,
  trashAndDelete,
  updateMemory,
} from './mem0/lifecycle.js';
export {
  deleteMemoriesWithPolicy,
  deleteMemory,
  restoreFromTrash,
  RESTORE_WINDOW_MS,
  scanAndCleanProjectMemories,
  snapshotMemories,
  trashAndDelete,
  TRASH_PROJECT,
  updateMemory,
} from './mem0/lifecycle.js';
import {
  cachedSearchMemory,
  getMemories,
  invalidateMem0Cache,
  searchMemory,
} from './mem0/read.js';
export {
  applyMinScoreFilter,
  cachedSearchMemory,
  DEFAULT_MIN_RECALL_SCORE,
  getMemories,
  invalidateMem0Cache,
  rankRecallResults,
  resolveMinRecallScore,
  searchMemory,
} from './mem0/read.js';
import {
  attachFeedback,
  FEEDBACK_DEFAULTS,
  getMemoryFeedback,
  getMemoryImportance,
  getMemoryTouchTimestamp,
  persistHeuristicState,
  setMemoryFeedback,
  setMemoryImportance,
  shouldApplyHeuristicState,
  touchMemoryTimestamp,
} from './mem0/state.js';
export {
  applyMemoryFeedback,
  attachFeedback,
  deleteState,
  FEEDBACK_DEFAULTS,
  FEEDBACK_TITLE_MAX_CHARS,
  getManyMemoryFeedback,
  getMemoryFeedback,
  getMemoryImportance,
  getMemoryTouchTimestamp,
  heuristicKind,
  IMPORTANCE_DEFAULT,
  persistHeuristicState,
  reinforceMemoryImportance,
  setMemoryFeedback,
  setMemoryImportance,
  shouldApplyHeuristicState,
  touchMemoryTimestamp,
} from './mem0/state.js';
export {
  acceptEnrichedMemory,
  ageDecayScore,
  applyAgeDecayToResults,
  classifyMemoryTier,
  disqualifyMemory,
  isTechnicalMemory,
  MIN_MEMORY_QUALITY,
  scoreActionability,
  scoreImportance,
  scoreMemoryQuality,
  shouldEnrichTechnicalMemory,
} from './mem0/scoring.js';

// ─── Forget Blocklist (✕ must not resurrect) ───
// Fase 0 of per-memory quick actions. `forget` hard-deletes AND records a
// hash of the text here; every save path checks it first (see addMemory).
// Without this, the next chat turn re-extracts the same fact.
// Authority: src/forget-blocklist.ts (workspace JSON file, Redis-free).
// Re-exported here so existing import sites keep working.
import {
  normalizeForBlocklist,
  blocklistHash,
  isBlocklisted,
  addToBlocklist,
  removeFromBlocklist,
  getBlocklistPath,
  __setBlocklistPathForTests,
} from './forget-blocklist.js';
export { normalizeForBlocklist, blocklistHash, isBlocklisted, addToBlocklist, removeFromBlocklist, getBlocklistPath, __setBlocklistPathForTests };

// ─── Memory Consolidation (Patch 2) ───

/**
 * Group memories by topic prefix or semantic similarity.
 * Returns groups of 2+ related memories that can be consolidated.
 */
function groupMemories(memories: { id: string; memory: string }[]): Map<string, { id: string; memory: string }[]> {
  const groups = new Map<string, { id: string; memory: string }[]>();

  // First pass: group by [Seed: <title>] prefix
  const ungrouped: { id: string; memory: string }[] = [];
  for (const mem of memories) {
    const seedMatch = mem.memory.match(/^\[Seed:\s*(.+?)\]/);
    if (seedMatch) {
      const key = `seed:${seedMatch[1].toLowerCase().trim()}`;
      const group = groups.get(key) || [];
      group.push(mem);
      groups.set(key, group);
    } else {
      ungrouped.push(mem);
    }
  }

  // Second pass: group ungrouped by keyword overlap
  const used = new Set<string>();
  for (let i = 0; i < ungrouped.length; i++) {
    if (used.has(ungrouped[i].id)) continue;
    const wordsA = new Set(ungrouped[i].memory.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    const similar: { id: string; memory: string }[] = [ungrouped[i]];

    for (let j = i + 1; j < ungrouped.length; j++) {
      if (used.has(ungrouped[j].id)) continue;
      const wordsB = new Set(ungrouped[j].memory.toLowerCase().split(/\s+/).filter(w => w.length > 4));
      let overlap = 0;
      for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
      const similarity = (2 * overlap) / (wordsA.size + wordsB.size);
      if (similarity >= 0.3) {
        similar.push(ungrouped[j]);
        used.add(ungrouped[j].id);
      }
    }

    if (similar.length >= 2) {
      used.add(ungrouped[i].id);
      groups.set(`topic:${i}`, similar);
    }
  }

  // Only return groups with 2+ memories
  for (const [key, group] of groups) {
    if (group.length < 2) groups.delete(key);
  }

  return groups;
}

/**
 * Consolidate fragmented memories for a project scope.
 * Groups related memories, merges them via the fast LLM, replaces fragments.
 * Returns { consolidated, deleted, groups }.
 */
/**
 * LLM-merge a set of fragment texts into one memory.
 * Same prompt + retry as the group path in consolidateMemories.
 * Returns null when the LLM returns nothing usable.
 */
async function llmMergeMemoryTexts(texts: string[]): Promise<string | null> {
  const { runFastLlmJson } = await import('./llm-client.js');
  const fragments = texts.join('\n- ');
  const result = await withRetry(() => runFastLlmJson<{ consolidated: string }>(
    `Consolide essas memórias fragmentadas em UMA ÚNICA memória completa e rica.
Mantenha TODOS os fatos importantes, nomes, valores, datas e decisões.
Retorne APENAS JSON: {"consolidated": "texto consolidado aqui"}

Memórias:
- ${fragments}`
  ));
  if (result?.consolidated && result.consolidated.length > 20) return result.consolidated;
  return null;
}

/**
 * Item 2 gate: pending-queue merges only run when explicitly enabled.
 * Sweep queues (item 1) and contradiction visibility (item 3) work regardless —
 * this way the queue can be observed before auto-merge is switched on.
 */
export function isPendingMergeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.LAIN_PENDING_MERGE_ENABLED ?? '').toLowerCase();
  return v === 'true' || v === '1';
}

/**
 * Consume the pending-review merge queue (UPDATE verdicts from the
 * contradiction sweep) before lexical grouping. Exact LLM-detected pairs —
 * no keyword guessing. Same trash + audit safety as the group path.
 */
async function consolidatePendingMerges(project?: string): Promise<{
  consolidated: number;
  deleted: number;
  details: ConsolidationDetail[];
}> {
  const { claimPendingMerges, updateEntry, maxAttemptsReached } = await import('./pending-review.js');
  const { logMaintenance } = await import('./maintenance-log.js');
  const claimed = await claimPendingMerges(project, 5);
  let consolidated = 0;
  let deleted = 0;
  const details: ConsolidationDetail[] = [];

  for (const entry of claimed) {
    try {
      const texts = [entry.memory, ...entry.related.map(r => r.memory)].filter(t => t && t.trim());
      if (texts.length < 2) {
        await updateEntry(entry.id, { status: 'failed', result: { error: 'fragments gone' } });
        continue;
      }
      const merged = await llmMergeMemoryTexts(texts);
      if (!merged || scoreMemoryQuality(merged) < MIN_MEMORY_QUALITY) {
        const terminal = maxAttemptsReached(entry);
        await updateEntry(entry.id, {
          status: terminal ? 'failed' : 'pending',
          result: { error: 'merge rejected by quality gate or empty' },
        });
        console.log(`[mem0] Pending merge ${entry.id.slice(0, 8)} rejected by quality gate${terminal ? ' (terminal)' : ', will retry'}`);
        continue;
      }
      const ids = [entry.memoryId, ...entry.related.map(r => r.id)].filter(id => id && id !== 'pending');
      const doomed = await snapshotMemories(ids, project);
      const existing = doomed.filter(s => !s.missing && s.memory);
      if (existing.length < 2) {
        await updateEntry(entry.id, { status: 'failed', result: { error: 'fragments gone' } });
        continue;
      }
      // Verbatim save (inferFalse): the merged text is already final. With
      // inference on, Mem0 can decompose it into an UPDATE against the still-
      // present fragments and return no id ("unknown") — then the fragments
      // below would be deleted with nothing saved (net loss). Same rationale
      // as the trash path (byte-identical archive).
      const saved = await addMemory(merged, project, { skipQualityCheck: true, skipConflictCheck: true, inferFalse: true });
      const newId = saved[0]?.id;
      if (!newId || newId === 'unknown' || newId === 'rejected') {
        console.error(`[mem0] Pending merge ${entry.id.slice(0, 8)} save unconfirmed — fragments preserved`);
        await updateEntry(entry.id, {
          status: maxAttemptsReached(entry) ? 'failed' : 'pending',
          result: { error: 'consolidated save unconfirmed, fragments preserved' },
        });
        continue;
      }
      consolidated++;

      const trashIds: Record<string, string | null> = {};
      for (const snap of doomed) {
        try {
          const { trashId, deleted: fragDeleted } = await trashAndDelete(snap, project, {
            reason: 'merged from pending review queue',
            trigger: 'consolidation:pending_queue',
            replacedById: newId,
          });
          trashIds[snap.id] = trashId;
          if (fragDeleted) {
            deleted++;
          } else {
            console.error(`[mem0] Pending merge deferred fragment ${snap.id}: trash copy unconfirmed, original preserved`);
          }
        } catch {}
      }

      await updateEntry(entry.id, { status: 'done', result: { mergedId: newId } });
      logMaintenance('pending_merge_done', {
        entry_id: entry.id,
        scope: project ?? 'global',
        new_id: newId,
        fragments: existing.length,
      });
      details.push({
        fragments: texts.map(f => f.slice(0, 120)),
        result: merged.slice(0, 200),
        fragmentsFull: doomed.map(s => ({ id: s.id, memory: s.memory, created_at: s.created_at ?? null, missing: s.missing ?? false, trash_id: trashIds[s.id] ?? null })),
        resultFull: merged,
        newId,
      });
    } catch (err) {
      try {
        await updateEntry(entry.id, {
          status: maxAttemptsReached(entry) ? 'failed' : 'pending',
          result: { error: err instanceof Error ? err.message : String(err) },
        });
      } catch {}
      console.error(`[mem0] Pending merge ${entry.id.slice(0, 8)} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return { consolidated, deleted, details };
}

export async function consolidateMemories(project?: string): Promise<{
  consolidated: number;
  deleted: number;
  groups: number;
  details: ConsolidationDetail[];
}> {
  let consolidated = 0;
  let deleted = 0;
  const details: ConsolidationDetail[] = [];

  // Item 1: exact LLM-detected UPDATE pairs first — no lexical guessing.
  // Gated by LAIN_PENDING_MERGE_ENABLED (item 2): when off, the queue only
  // accumulates for observation via /api/memory/contradictions.
  if (isPendingMergeEnabled()) {
    try {
      const queued = await consolidatePendingMerges(project);
      consolidated += queued.consolidated;
      deleted += queued.deleted;
      details.push(...queued.details);
    } catch (err) {
      console.error('[mem0] Pending-queue consolidation failed:', err instanceof Error ? err.message : err);
    }
  }

  const allMems = await getMemories(project, 100);
  if (allMems.length < 4) return { consolidated, deleted, groups: 0, details };

  const groups = groupMemories(allMems);
  if (groups.size === 0) return { consolidated, deleted, groups: 0, details };

  for (const [_key, group] of groups) {
    const fragmentTexts = group.map(m => m.memory);
    const fragments = fragmentTexts.join('\n- ');

    try {
      const { runFastLlmJson } = await import('./llm-client.js');
      const result = await withRetry(() => runFastLlmJson<{ consolidated: string }>(
        `Consolide essas memórias fragmentadas em UMA ÚNICA memória completa e rica.
Mantenha TODOS os fatos importantes, nomes, valores, datas e decisões.
Retorne APENAS JSON: {"consolidated": "texto consolidado aqui"}

Memórias:
- ${fragments}`
      ));

      if (result.consolidated && result.consolidated.length > 20) {
        // Quality gate: skip low-quality consolidation results (item #6)
        if (scoreMemoryQuality(result.consolidated) < MIN_MEMORY_QUALITY) {
          console.log(`[mem0] Consolidation rejected low-quality result: ${result.consolidated.slice(0, 60)}...`);
          continue;
        }
        // Snapshot fragments BEFORE replacing — full texts for the audit trail.
        const doomed = await snapshotMemories(group.map(m => m.id).filter(id => id && id !== 'pending'), project);
        // Verbatim save (inferFalse): the consolidated text is already final.
        // With inference on, Mem0 can decompose it into an UPDATE against the
        // still-present fragments and return no id ("unknown") — then the
        // fragments below would be deleted with nothing saved (net loss).
        const saved = await addMemory(result.consolidated, project, { skipQualityCheck: true, skipConflictCheck: true, inferFalse: true });
        const newId = saved[0]?.id;
        if (!newId || newId === 'unknown' || newId === 'rejected') {
          console.error(`[mem0] Consolidation save unconfirmed — fragments preserved`);
          continue;
        }
        consolidated++;

        const trashIds: Record<string, string | null> = {};
        // Delete fragments (via trash — fail-closed: unconfirmed copies are preserved, not counted)
        for (const snap of doomed) {
          try {
            const { trashId, deleted: fragDeleted } = await trashAndDelete(snap, project, {
              reason: 'merged into consolidated memory',
              trigger: 'consolidation',
              replacedById: newId,
            });
            trashIds[snap.id] = trashId;
            if (fragDeleted) {
              deleted++;
            } else {
              console.error(`[mem0] Consolidation deferred fragment ${snap.id}: trash copy unconfirmed, original preserved`);
            }
          } catch {}
        }

        details.push({
          fragments: fragmentTexts.map(f => f.slice(0, 120)),
          result: result.consolidated.slice(0, 200),
          fragmentsFull: doomed.map(s => ({ id: s.id, memory: s.memory, created_at: s.created_at ?? null, missing: s.missing ?? false, trash_id: trashIds[s.id] ?? null })),
          resultFull: result.consolidated,
          newId,
        });
      }
    } catch (err) {
      console.error(`[mem0] Consolidation failed for group:`, err);
    }
  }

  console.log(`[mem0] Consolidation: ${consolidated} groups merged, ${deleted} fragments deleted`);
  return { consolidated, deleted, groups: groups.size, details };
}

// ─── Progressive Context (Patch 5 → v2: dynamic char budget) ───

const DEFAULT_MAX_CONTEXT_CHARS = 6000;

/**
 * Get formatted memory context for Claude spawner.
 * Progressive loading: prioritizes by relevance, respects char budget.
 * Budget is dynamic based on task complexity (passed by spawner).
 * Fetches global memories + project-specific semantic search.
 */

// ─── Query Optimization (no LLM — pure text processing) ───

const QUERY_STOPWORDS = new Set([
  // Portuguese filler
  'que', 'nao', 'não', 'pra', 'pro', 'com', 'uma', 'uns', 'tem', 'tá', 'ta',
  'vai', 'vou', 'esse', 'essa', 'isso', 'isto', 'aqui', 'ali', 'ele', 'ela',
  'eles', 'elas', 'como', 'mais', 'mas', 'nos', 'nas', 'dos', 'das', 'pelo',
  'pela', 'por', 'para', 'sem', 'sob', 'sobre', 'entre', 'ate', 'até',
  'quando', 'onde', 'quem', 'qual', 'sera', 'será', 'seria', 'pode', 'deve',
  'precisa', 'caso', 'entao', 'então', 'depois', 'antes', 'ainda', 'tambem',
  'também', 'porque', 'porquê', 'voce', 'você', 'gente', 'tipo', 'coisa',
  'certo', 'bom', 'sim', 'olha', 'veja', 'faz', 'fez', 'fazer',
  'usuario', 'usuário', 'reclamando', 'falando', 'dizendo', 'pedindo',
  // English filler
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has',
  'been', 'will', 'what', 'when', 'where', 'which', 'would', 'should',
  'could', 'does', 'into', 'just', 'also', 'about', 'some', 'very',
  'need', 'want', 'check', 'look', 'see', 'know', 'think', 'make',
]);

/**
 * Extract key terms from a message for optimized memory search.
 * No LLM — pure text processing. Removes filler, keeps domain terms.
 */
function buildSearchQuery(message: string, project?: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/[^\w\sáàâãéèêíìîóòôõúùûçñ]/g, ' ') // keep letters + accented chars
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalized.split(' ')
    .filter(w => w.length >= 3 && !QUERY_STOPWORDS.has(w));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique = words.filter(w => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });

  // Prepend project name if available (boosts project-relevant results)
  const query = project
    ? `${project} ${unique.join(' ')}`
    : unique.join(' ');

  // If query is too short after filtering, fall back to original
  return query.length >= 5 ? query : message;
}

export async function getContextForSpawn(message: string, project?: string, charBudget?: number, limits?: MemoryLimits): Promise<string> {
  // Early exit if memory is completely disabled for this tier
  if (limits && limits.globalLimit === 0 && limits.projectLimit === 0) {
    return '';
  }

  const effectiveGlobalLimit = limits?.globalLimit ?? 15;
  const effectiveProjectLimit = limits?.projectLimit ?? 15;

  // Build optimized search query (no LLM — pure text processing)
  const searchQuery = buildSearchQuery(message, project);

  // Parallel calls with individual error handling
  const globalMemsPromise = effectiveGlobalLimit > 0
    ? (async () => {
        try {
          return await cachedSearchMemory(searchQuery, undefined, effectiveGlobalLimit) as { memory: string; score?: number }[];
        } catch { return []; }
      })()
    : Promise.resolve([] as { memory: string; score?: number }[]);

  const projectMemsPromise = (project && effectiveProjectLimit > 0)
    ? (async () => {
        try {
          const t0 = Date.now();
          const results = await cachedSearchMemory(searchQuery, project, effectiveProjectLimit) as { memory: string; score?: number }[];
          if (effectiveGlobalLimit === 5 && effectiveProjectLimit === 5) {
            console.log(`[recall:simple] project memories fetched in ${Date.now() - t0}ms (${results.length} results)`);
          }
          return results;
        } catch { return []; }
      })()
    : Promise.resolve([] as { memory: string; score?: number }[]);

  const [globalList, projectList] = await Promise.all([
    globalMemsPromise, projectMemsPromise,
  ]);

  // Build context with progressive loading (budget-aware)
  let budget = charBudget ?? DEFAULT_MAX_CONTEXT_CHARS;
  const globalLines: string[] = [];
  const projectLines: string[] = [];

  // 1. Global memories (highest priority — user prefs/facts)
  for (const m of globalList) {
    const line = `- ${m.memory}`;
    if (budget - line.length < 0) break;
    globalLines.push(line);
    budget -= line.length;
  }

  // 2. Project memories sorted by relevance score (higher = more relevant)
  if (projectList.length > 0) {
    const sorted = [...projectList].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (const m of sorted) {
      const line = `- ${m.memory}`;
      if (budget - line.length < 0) break;
      projectLines.push(line);
      budget -= line.length;
    }
  }

  if (globalLines.length === 0 && projectLines.length === 0) return '';

  // Build output with typed block headers for clear agent navigation
  const parts: string[] = [];
  if (globalLines.length > 0) {
    parts.push('## Global (preferences & facts)');
    parts.push(...globalLines);
  }
  if (projectLines.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(`## Project: ${project}`);
    parts.push(...projectLines);
  }

  return parts.join('\n');
}

// ─── Importance Backfill ───

const BACKFILL_PROJECTS = [undefined] as const;

/**
 * Score up to `maxToScore` memories that are missing importance scores in Redis.
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
// (global, then each project), persisting progress in Redis.

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
  const key = `mem0:contradiction_cursor:${contradictionScopeKey(scope)}`;
  if (isRedisAvailable()) {
    try {
      const raw = await getRedis().get(key);
      const n = raw === null ? 0 : parseInt(raw, 10);
      return Number.isNaN(n) || n < 0 ? 0 : n;
    } catch { /* fall through to fallback */ }
  }
  return contradictionCursorFallback.get(contradictionScopeKey(scope)) ?? 0;
}

export async function setContradictionCursor(scope: string | undefined, cursor: number): Promise<void> {
  const safe = Math.max(0, Math.floor(cursor));
  contradictionCursorFallback.set(contradictionScopeKey(scope), safe);
  if (isRedisAvailable()) {
    try {
      await getRedis().set(`mem0:contradiction_cursor:${contradictionScopeKey(scope)}`, String(safe));
    } catch { /* non-critical */ }
  }
}

async function getContradictionScopeIdx(mod: number): Promise<number> {
  if (mod <= 0) return 0;
  if (isRedisAvailable()) {
    try {
      const raw = await getRedis().get('mem0:contradiction_scope_idx');
      const n = raw === null ? 0 : parseInt(raw, 10);
      return Number.isNaN(n) || n < 0 ? 0 : n % mod;
    } catch { /* fall through */ }
  }
  return contradictionScopeIdxFallback % mod;
}

async function setContradictionScopeIdx(idx: number): Promise<void> {
  contradictionScopeIdxFallback = Math.max(0, Math.floor(idx));
  if (isRedisAvailable()) {
    try {
      await getRedis().set('mem0:contradiction_scope_idx', String(contradictionScopeIdxFallback));
    } catch { /* non-critical */ }
  }
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

  const { classifyMemoryAction } = await import('./contradiction-detector.js');
  const { logMaintenance } = await import('./maintenance-log.js');
  const { enqueueVerdict } = await import('./pending-review.js');
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
      const { logMaintenance } = await import('./maintenance-log.js');

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

      const { resolveEntities } = await import('./graphrag.js');
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
        const { reconcileGraph } = await import('./graphrag.js');
        const reconciled = await reconcileGraph();
        if (reconciled.processed > 0 || reconciled.failed > 0) {
          console.log(`[graphrag] Maintenance reconcile: ${reconciled.processed} processed, ${reconciled.failed} failed, ${reconciled.pending} pending`);
        }
      } catch (err) {
        console.error('[graphrag] Maintenance reconcile error:', err);
      }

      // ── Importance backfill: score memories missing importance in Redis ──
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
