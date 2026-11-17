/**
 * Lifecycle: policy deletes, trash/restore, update (mem0 split M7).
 *
 * deleteMemoriesWithPolicy + scanAndCleanProjectMemories (automatic
 * hygiene), deleteMemory, the trash audit trail (snapshot/trash/restore),
 * and updateMemory. Fail-closed throughout: originals are deleted only
 * after the trash copy is confirmed.
 */

import * as graphrag from '../graphrag.js';
import {
  STATE_SNAPSHOT_KEY,
  getManyState,
  deleteState as stateDeleteState,
  isDefaultState,
  parseStateSnapshot,
} from '../memory-state.js';
import { removeFromBlocklist } from '../forget-blocklist.js';
import type { PolicyAuditRecord } from '../memory-policy.js';
import { getClient } from './config.js';
import { scoreMemoryQuality } from './scoring.js';
import {
  getMemoryFeedback,
  setMemoryFeedback,
  setMemoryImportance,
} from './state.js';
import {
  getMemories,
  invalidateMem0Cache,
} from './read.js';
import { addMemory } from './write.js';
import type {
  MemoryFeedback,
  MemorySnapshot,
  RestoreResult,
  TrashProvenance,
} from './types.js';

// ─── Memory Cleanup (memoryScan) ───
// Fase 4: automatic deletions go through the shared domain policy
// (archive to trash + audit). The trash scope itself is never scanned.

/**
 * Shared domain policy for AUTOMATIC deletions (Fase 4).
 * Snapshot → trash copy with provenance → hard delete → audit record.
 * Per-item failures are collected in the report, never thrown.
 */
export async function deleteMemoriesWithPolicy(input: {
  ids: string[];
  project?: string;
  reason: string;
  trigger: string;
  replacedById?: string;
}): Promise<{
  archived: string[];
  trashIds: Record<string, string | null>;
  failed: { id: string; error: string }[];
  audit: PolicyAuditRecord[];
  auditFailed: { memoryId: string; error: string }[];
}> {
  if (input.project === TRASH_PROJECT) {
    return {
      archived: [],
      trashIds: {},
      failed: input.ids.map(id => ({ id, error: 'refusing to archive the trash scope itself' })),
      audit: [],
      auditFailed: [],
    };
  }
  const { applyDeletionPolicy } = await import('../memory-policy.js');
  const { logMaintenance } = await import('../maintenance-log.js');
  const report = await applyDeletionPolicy(
    { ...input, op: 'archive' },
    {
      snapshot: ids => snapshotMemories(ids, input.project),
      trashAndDelete: (snap, fromProject, provenance) => trashAndDelete(snap, fromProject, provenance),
      audit: record => logMaintenance('memory_policy_delete', { ...record }),
    }
  );
  try {
    await invalidateMem0Cache(input.project);
  } catch { /* non-critical */ }
  return { archived: report.archived, trashIds: report.trashIds, failed: report.failed, audit: report.audit, auditFailed: report.auditFailed };
}

/**
 * Scan project memories and archive those that are cold AND low quality.
 * Safety rules:
 *   - Only archives project-scoped memories (global memories are permanent)
 *   - Refuses the trash scope itself
 *   - Only archives memories > 90 days old (3x the cold threshold — extra safety margin)
 *   - Only archives memories with quality score < 3 (low-value content)
 *   - Archived items land in the trash scope with provenance + audit trail
 *   - Returns a report of what was archived
 */
export async function scanAndCleanProjectMemories(project: string): Promise<{
  total: number;
  deleted: number;
  deletedItems: { id: string; memory: string; daysOld: number }[];
}> {
  const memories = await getMemories(project, 200);

  // Collect hygiene candidates first; the policy archives them as one batch.
  const candidates = new Map<string, { memory: string; daysOld: number; quality: number }>();
  for (const mem of memories) {
    const createdMs = mem.created_at ? new Date(mem.created_at).getTime() : null;
    if (!createdMs || isNaN(createdMs)) continue;
    const daysOld = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
    if (daysOld < 90) continue; // extra safety margin — only 90+ days
    const quality = scoreMemoryQuality(mem.memory);
    if (quality >= 3) continue; // keep quality memories even if old
    candidates.set(mem.id, { memory: mem.memory.slice(0, 80), daysOld: Math.round(daysOld), quality });
  }

  const deletedItems: { id: string; memory: string; daysOld: number }[] = [];
  if (candidates.size > 0) {
    const report = await deleteMemoriesWithPolicy({
      ids: [...candidates.keys()],
      project,
      reason: 'stale low-quality memory (90+ days old, quality < 3)',
      trigger: 'memory_scan',
    });
    for (const id of report.archived) {
      const c = candidates.get(id);
      if (c) deletedItems.push({ id, memory: c.memory, daysOld: c.daysOld });
    }
    for (const f of report.failed) {
      console.error(`[mem0] memory_scan failed to archive ${f.id}: ${f.error}`);
    }
  }

  try {
    const { logMaintenance } = await import('../maintenance-log.js');
    logMaintenance('memory_scan', {
      project,
      total: memories.length,
      deleted: deletedItems.length,
      deletedItems: deletedItems.map(d => ({ memory: d.memory, daysOld: d.daysOld })),
    });
  } catch { /* non-critical */ }

  return { total: memories.length, deleted: deletedItems.length, deletedItems };
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const m = getClient();
  await m.delete(memoryId);
  invalidateMem0Cache().catch(() => {});
  // Fase 3: prune derived projection (best-effort, never fails the delete).
  try {
    await graphrag.removeGraphProvenance(memoryId);
  } catch (err) {
    console.error('[mem0] graph provenance prune failed:', err instanceof Error ? err.message : err);
  }
}

// ─── Delete audit trail (snapshot-before-delete + trash) ───

/** Mem0 project scope holding deleted memories. Invisible to recall sweeps
 * (reaper/dedup/consolidation only scan workspace projects + global scope). */
export const TRASH_PROJECT = 'trash';

/** Fetch full texts for ids BEFORE deleting. Never throws — returns
 * `{id, missing:true}` entries for anything unfetchable. */
export async function snapshotMemories(ids: string[], project?: string, limit = 100): Promise<MemorySnapshot[]> {
  try {
    const all = await getMemories(project, limit);
    const byId = new Map(all.map(m => [m.id, m]));
    return ids.map(id => {
      const found = byId.get(id);
      if (!found) return { id, memory: '', missing: true as const };
      return { id, memory: found.memory ?? '', ...(found.created_at ? { created_at: found.created_at } : {}) };
    });
  } catch (err) {
    console.error('[mem0] snapshotMemories failed:', err instanceof Error ? err.message : err);
    return ids.map(id => ({ id, memory: '', missing: true as const }));
  }
}

/**
 * Copy a memory to the trash scope (with provenance metadata), then hard-delete
 * the original. Trash copies skip quality/conflict checks and graph ingestion.
 * FAIL-CLOSED: the original is deleted ONLY after the trash copy is confirmed.
 * If the copy fails (or the snapshot is missing/empty), the original is
 * preserved and the caller gets `{ trashId: null, deleted: false }` so the
 * item can be retried — an "archive" never becomes silent data loss.
 */
export async function trashAndDelete(
  snapshot: MemorySnapshot,
  fromProject: string | undefined,
  provenance: TrashProvenance,
): Promise<{ trashId: string | null; deleted: boolean }> {
  if (!snapshot.missing && snapshot.memory) {
    // Snapshot user state BEFORE deleting — the Qdrant payload (and its
    // lain_feedback/lain_importance) dies with the point. Stashed in the
    // trash copy's metadata so restoreFromTrash can reapply it in full.
    // Reads never throw; default state is simply not snapshotted.
    let stateSnapshot: { feedback: MemoryFeedback; importance: number | null } | null = null;
    try {
      const cur = (await getManyState([snapshot.id])).get(snapshot.id);
      if (cur && !isDefaultState(cur.feedback, cur.importance)) {
        stateSnapshot = { feedback: cur.feedback, importance: cur.importance };
      }
    } catch { /* defensive — the trash copy still proceeds */ }
    let trashId: string | null = null;
    try {
      const saved = await addMemory(snapshot.memory, TRASH_PROJECT, {
        inferFalse: true, // archive must be byte-identical (no LLM decomposition that can return empty)
        skipQualityCheck: true,
        skipConflictCheck: true,
        skipGraphIngest: true,
        skipBlocklistCheck: true, // trash carries forgotten text by design — see blocklist section
        metadata: {
          original_id: snapshot.id,
          deleted_from: fromProject ?? 'global',
          original_created_at: snapshot.created_at ?? null,
          reason: provenance.reason,
          trigger: provenance.trigger,
          ...(provenance.replacedById ? { replaced_by: provenance.replacedById } : {}),
          ...(stateSnapshot ? { [STATE_SNAPSHOT_KEY]: stateSnapshot } : {}),
          trashed_at: new Date().toISOString(),
        },
      });
      trashId = saved[0]?.id ?? null;
    } catch (err) {
      console.error(`[mem0] trash copy failed for ${snapshot.id} — original preserved:`, err instanceof Error ? err.message : err);
      return { trashId: null, deleted: false };
    }
    if (!trashId) {
      console.error(`[mem0] trash copy unconfirmed for ${snapshot.id} — original preserved`);
      return { trashId: null, deleted: false };
    }
    await deleteMemory(snapshot.id);
    // The point (and its payload state) is gone; evict leftovers (L2).
    // Best-effort: cleanup must not fail an otherwise complete archive.
    await stateDeleteState(snapshot.id).catch((err) =>
      console.error(`[mem0] post-delete state cleanup failed for ${snapshot.id}:`, err instanceof Error ? err.message : err));
    return { trashId, deleted: true };
  }
  console.error(`[mem0] refusing to delete ${snapshot.id} without a trash copy (missing/empty snapshot) — preserved`);
  return { trashId: null, deleted: false };
}

/** Undo window for ✕ (forget). Trash copies older than this cannot be restored. */
export const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Undo a forget: re-save the trash copy into its original scope, delete the
 * trash copy, and lift the blocklist entry. FAIL-CLOSED: the trash copy is
 * deleted only after the re-save is confirmed.
 */
export async function restoreFromTrash(trashId: string, expectedProject?: string): Promise<RestoreResult> {
  let found;
  try {
    const all = await getMemories(TRASH_PROJECT, 500);
    found = all.find(m => m.id === trashId);
  } catch (err) {
    console.error('[mem0] restore failed (trash unreadable):', err instanceof Error ? err.message : err);
    return { id: null, restored: false, reason: 'trash unreadable' };
  }
  if (!found?.memory) return { id: null, restored: false, reason: 'not found in trash' };
  const meta = (found.metadata ?? {}) as Record<string, unknown>;
  const trashedAt = typeof meta.trashed_at === 'string' ? Date.parse(meta.trashed_at) : NaN;
  if (!Number.isNaN(trashedAt) && Date.now() - trashedAt > RESTORE_WINDOW_MS) {
    return { id: null, restored: false, reason: 'restore window expired (7d)' };
  }
  const fromProject = typeof meta.deleted_from === 'string' && meta.deleted_from !== 'global'
    ? meta.deleted_from
    : undefined;
  const requestedProject = expectedProject === 'global' ? undefined : expectedProject;
  if (expectedProject !== undefined && requestedProject !== fromProject) {
    return { id: null, restored: false, reason: 'trash item outside requested scope' };
  }
  const originalId = typeof meta.original_id === 'string' ? meta.original_id : undefined;
  let savedId: string | null = null;
  try {
    const saved = await addMemory(found.memory, fromProject, {
      inferFalse: true,
      skipQualityCheck: true,
      skipConflictCheck: true,
      skipBlocklistCheck: true, // restoring a forget — text is blocklisted until lifted below
    });
    savedId = saved[0]?.id ?? null;
  } catch (err) {
    console.error(`[mem0] restore re-save failed for ${trashId} — trash preserved:`, err instanceof Error ? err.message : err);
    return { id: null, restored: false, reason: 're-save failed' };
  }
  if (!savedId) {
    console.error(`[mem0] restore re-save unconfirmed for ${trashId} — trash preserved`);
    return { id: null, restored: false, reason: 're-save unconfirmed' };
  }
  // Reapply the state snapshot stashed in the trash copy (full fidelity:
  // confidence, correct_count, title, importance...). Trash copies written
  // before snapshots fall back to the old kind-only preservation.
  const stateSnapshot = parseStateSnapshot(meta[STATE_SNAPSHOT_KEY]);
  if (stateSnapshot) {
    try {
      await setMemoryFeedback(savedId, stateSnapshot.feedback);
      if (stateSnapshot.importance !== null) await setMemoryImportance(savedId, stateSnapshot.importance);
    } catch (err) {
      console.error(`[mem0] restore state re-apply failed for ${trashId} — trash preserved:`, err instanceof Error ? err.message : err);
      return { id: savedId, restored: false, reason: 'state restore failed' };
    }
  } else if (originalId) {
    // Preserve an explicit `state` vote from before the forget (the auto
    // heuristic may not re-fire on the restored text).
    try {
      const originalFeedback = await getMemoryFeedback(originalId);
      if (originalFeedback.kind === 'state') {
        await setMemoryFeedback(savedId, { kind: 'state' });
      }
    } catch { /* keep heuristic kind */ }
  }
  await deleteMemory(trashId);
  // Evict the trash copy's leftovers (L2). Best-effort.
  await stateDeleteState(trashId).catch((err) =>
    console.error(`[mem0] post-restore state cleanup failed for ${trashId}:`, err instanceof Error ? err.message : err));
  await removeFromBlocklist(found.memory);
  return { id: savedId, restored: true };
}

// C3: Update an existing memory by ID. Uses Mem0 SDK native update.
// OSS Memory.update(id, string) takes a plain string and returns { message: string }.
// ID is preserved (in-place update). No conflict check — caller asserts intentional replacement.
export async function updateMemory(memoryId: string, newText: string, project?: string): Promise<{ id: string; memory: string }> {
  const m = getClient();
  await m.update(memoryId, newText);
  invalidateMem0Cache(project).catch(() => {});
  // Fase 3: re-derive projection — drop edges sourced only by the old content,
  // then re-ingest the new text with the same memory ID as provenance.
  try {
    await graphrag.removeGraphProvenance(memoryId);
    graphrag.queueGraphIngest(newText, project, [memoryId]);
  } catch (err) {
    console.error('[mem0] graph re-ingest after update failed:', err instanceof Error ? err.message : err);
  }
  return { id: memoryId, memory: newText };
}
