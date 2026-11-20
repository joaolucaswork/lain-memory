/**
 * Memory write routes (server split S1).
 *
 * remember, add, forget, restore, feedback, update, bundle.
 * Each handler takes validated body data and returns a Response.
 */

import {
  addMemory,
  addMemoryWithConflictCheck,
  applyMemoryFeedback,
  restoreFromTrash,
  snapshotMemories,
  trashAndDelete,
  updateMemory,
  addToBlocklist,
} from '../../mem0.js';
import { rememberChatTurn } from '../../chat-extract.js';
import { MASTER_TENANT, enforceTenantCap, recordTenantProject } from '../../tenants.js';
import { json, tenantOf, type Handler } from '../http.js';

/** Internal Mem0 metadata keys tenants must never set directly. */
const RESERVED_METADATA_KEYS = new Set([
  'lain_feedback',
  'lain_importance',
  'lain_relevance',
  'lain_state_snapshot',
  'deleted_from',
  'original_id',
  'trashed_at',
]);

/**
 * Strip internal Mem0 metadata keys from a caller-supplied opts object.
 * Non-master only; master keeps the legacy passthrough. Mutates in place.
 */
export function stripReservedMetadata(opts: unknown, tenant: string): void {
  if (tenant === MASTER_TENANT) return;
  if (typeof opts !== 'object' || opts === null) return;
  const rec = opts as Record<string, unknown>;
  const meta = rec['metadata'];
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return;
  for (const k of RESERVED_METADATA_KEYS) {
    if (k in (meta as Record<string, unknown>)) delete (meta as Record<string, unknown>)[k];
  }
}

function sanitizeMetadata(opts: unknown, tenant: string): void {
  stripReservedMetadata(opts, tenant);
}

export const handleRemember: Handler = async (data) => {
  const tenant = tenantOf(data);
  const cap = await enforceTenantCap(tenant, data.project);
  if (!cap.ok) return json({ error: cap.error }, 429);
  if (data.mode === 'chat') {
    const result = await rememberChatTurn({
      user: data.text,
      assistant: data.assistant,
      project: data.project,
      date: data.date,
      tenant,
    });
    await recordTenantProject(tenant, data.project);
    return json(result);
  }
  const memOpts: { skipConflictCheck?: boolean; bundleMode?: boolean; inferFalse?: boolean; skipQualityCheck?: boolean } = {};
  if (data.mode === 'index') memOpts.skipConflictCheck = true;
  else if (data.mode === 'bundle') memOpts.bundleMode = true;
  else if (data.mode === 'raw') memOpts.inferFalse = true;
  if (data.skipQualityCheck) memOpts.skipQualityCheck = true;
  const result = await addMemoryWithConflictCheck(data.text, data.project, memOpts, tenant);
  await recordTenantProject(tenant, data.project);
  return json(result);
};

export const handleAdd: Handler = async (data) => {
  // Direct addMemory (no conflict check). Used by notes/file ingests
  // that pre-filter. Same AddMemoryOpts shape as in-process calls.
  const tenant = tenantOf(data);
  sanitizeMetadata(data.opts, tenant);
  const cap = await enforceTenantCap(tenant, data.project);
  if (!cap.ok) return json({ error: cap.error }, 429);
  const result = await addMemory(data.text, data.project, data.opts, tenant);
  await recordTenantProject(tenant, data.project);
  return json(result);
};

export const handleForget: Handler = async (data) => {
  // ✕ Esquecer: trash copy (7d undo) → hard delete → blocklist.
  // Delete always succeeds when the id exists; trash+blocklist are
  // best-effort (snapshot may miss project-scoped ids without `project`).
  const tenant = tenantOf(data);
  const project = data.project === 'global' ? undefined : data.project;
  const snapshots = await snapshotMemories([data.memory_id], project, 500, tenant);
  const snap = snapshots[0];
  if (!snap || snap.missing || !snap.memory) {
    return json({ error: 'memory not found in scope' }, 404);
  }
  const { trashId, deleted } = await trashAndDelete(snap, project, {
    reason: 'user forget vote',
    trigger: 'api/memory/forget',
  }, tenant);
  if (deleted) {
    await addToBlocklist(snap.memory, tenant);
    return json({ success: true, trashId, blocked: true, project: data.project ?? 'global' });
  }
  return json({ error: 'could not archive before delete — original preserved' }, 500);
};

export const handleRestore: Handler = async (data) => {
  const result = await restoreFromTrash(data.memory_id, data.project, tenantOf(data));
  if (!result.restored) {
    const gone = result.reason === 'restore window expired (7d)';
    return json({ error: result.reason ?? 'restore failed' }, gone ? 410 : 404);
  }
  return json({ success: true, id: result.id });
};

export const handleFeedback: Handler = async (data) => {
  const kind = data.kind === 'state' || data.kind === 'fact' ? data.kind : undefined;
  try {
    const tenant = tenantOf(data);
    const project = data.project === 'global' ? undefined : data.project;
    const [snapshot] = await snapshotMemories([data.id], project, 500, tenant);
    if (!snapshot || snapshot.missing || !snapshot.memory) {
      return json({ error: 'memory not found in scope' }, 404);
    }
    const feedback = await applyMemoryFeedback(data.id, data.action, kind ? { kind } : undefined);
    return json({ id: data.id, ...feedback });
  } catch (err) {
    // Fail-hard: the vote was NOT persisted (Qdrant unavailable, unknown
    // id, ...). Surface 500 so callers never assume a silent success.
    console.error(`[lain-memory] /api/memory/feedback failed for ${data.id}:`, err instanceof Error ? err.message : err);
    return json({ error: 'feedback not persisted' }, 500);
  }
};

export const handleUpdate: Handler = async (data) => {
  const tenant = tenantOf(data);
  const project = data.project === 'global' ? undefined : data.project;
  const [snapshot] = await snapshotMemories([data.id], project, 500, tenant);
  if (!snapshot || snapshot.missing || !snapshot.memory) {
    return json({ error: 'memory not found in scope' }, 404);
  }
  const updated = await updateMemory(data.id, data.memory, data.project, tenant);
  await recordTenantProject(tenant, data.project);
  return json(updated);
};

export const handleBundle: Handler = async (data) => {
  const { runBundleSweep } = await import('../../bundle-sweep.js');
  const tenant = tenantOf(data);
  if (!data.dry_run) {
    const cap = await enforceTenantCap(tenant, 'diario');
    if (!cap.ok) return json({ error: cap.error }, 429);
  }
  const result = await runBundleSweep(data.dry_run ? { dryRun: true, tenant } : { tenant });
  await recordTenantProject(tenant, 'diario');
  return json(result);
};
