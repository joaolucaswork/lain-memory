/**
 * Memory deletion policy — Fase 4.
 *
 * Single choke point for AUTOMATIC memory deletions (dedup-sweep, reaper,
 * scans, contradiction supersedes). Manual hard deletes (forget by explicit
 * user action) stay direct and are documented as intentional.
 *
 * Domain operations (explicit, never confused):
 * - ignore:    NOOP duplicate/subset in a diagnostic context — no write.
 * - save:      ADD — genuinely new content, stored normally.
 * - supersede: UPDATE/DELETE verdict — old memory archived to trash scope
 *              (with provenance) and hard-deleted; replacement linked.
 * - archive:   automatic hygiene (stale/cold/duplicate) — trash + audit,
 *              recoverable from the trash scope by re-saving.
 * - delete:    manual hard delete by explicit operator action (no trash).
 *
 * Restore is NOT supported in v1: trash is an audit/archival scope.
 * Restoring = re-saving the text (creates a new ID by design).
 * Trash scope retention is indefinite in v1; the reaper/dedup/scan sweeps
 * never enumerate it, so archived items are stable.
 */

import type { MemoryActionType } from './contradiction-detector.js';

/** Domain operation derived from a classifier verdict. */
export type DomainOp = 'ignore' | 'save' | 'supersede' | 'archive' | 'delete';

/**
 * Explicit mapping — NOOP is NEVER deletion by itself. Archiving a NOOP
 * happens only when the caller explicitly requests op 'archive'
 * (automatic hygiene with trash + audit), never by misreading the verdict.
 */
export function domainOpForClassification(action: MemoryActionType): DomainOp {
  switch (action) {
    case 'ADD': return 'save';
    case 'UPDATE':
    case 'DELETE': return 'supersede';
    case 'NOOP':
    default: return 'ignore';
  }
}

export interface PolicySnapshot {
  id: string;
  memory: string;
  created_at?: string;
  missing?: boolean;
}

export interface PolicyProvenance {
  reason: string;
  trigger: string;
  replacedById?: string;
}

/** Injected primitives — mem0.ts wires the real ones; tests inject fakes. */
export interface PolicyDeps {
  snapshot(ids: string[]): Promise<PolicySnapshot[]>;
  /**
   * Trash copy with provenance + hard delete of the original (mirrors
   * trashAndDelete: best-effort on the copy, throws only if the original
   * could not be deleted).
   */
  trashAndDelete(
    snap: PolicySnapshot,
    fromProject: string | undefined,
    provenance: PolicyProvenance
  ): Promise<{ trashId: string | null }>;
  /** Audit sink. May throw — a throw is recorded, never silent. */
  audit(record: PolicyAuditRecord): void;
}

export interface PolicyAuditRecord {
  memoryId: string;
  project: string;
  op: 'archive' | 'supersede';
  reason: string;
  trigger: string;
  replacedById?: string;
  trashId: string | null;
  result: 'archived' | 'deleted-trash-failed' | 'failed';
  error?: string;
  ts: string;
}

export interface PolicyDeleteInput {
  ids: string[];
  project?: string;
  reason: string;
  trigger: string;
  replacedById?: string;
  /** Domain op for this batch: automatic hygiene uses 'archive'. */
  op?: 'archive' | 'supersede';
}

export interface PolicyDeleteResult {
  archived: string[];
  trashIds: Record<string, string | null>;
  failed: { id: string; error: string }[];
  audit: PolicyAuditRecord[];
  auditFailed: { memoryId: string; error: string }[];
}

/**
 * Archive a batch of memories: snapshot → trash copy (provenance) →
 * hard delete → audit record. Per-item failures are collected, never
 * thrown; only a snapshot-layer failure aborts (nothing was touched).
 * Audit-sink throws are recorded in `auditFailed`, never silent.
 */
export async function applyDeletionPolicy(
  input: PolicyDeleteInput,
  deps: PolicyDeps
): Promise<PolicyDeleteResult> {
  const op = input.op ?? 'archive';
  const fromProject = input.project ?? 'global';
  const result: PolicyDeleteResult = { archived: [], trashIds: {}, failed: [], audit: [], auditFailed: [] };

  let snaps: PolicySnapshot[];
  try {
    snaps = await deps.snapshot(input.ids);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const id of input.ids) result.failed.push({ id, error: `snapshot failed: ${message}` });
    return result;
  }

  for (const snap of snaps) {
    const record: PolicyAuditRecord = {
      memoryId: snap.id,
      project: fromProject,
      op,
      reason: input.reason,
      trigger: input.trigger,
      ...(input.replacedById ? { replacedById: input.replacedById } : {}),
      trashId: null,
      result: 'failed',
      ts: new Date().toISOString(),
    };
    try {
      const { trashId } = await deps.trashAndDelete(
        snap,
        input.project,
        { reason: input.reason, trigger: input.trigger, ...(input.replacedById ? { replacedById: input.replacedById } : {}) }
      );
      record.trashId = trashId;
      record.result = trashId ? 'archived' : 'deleted-trash-failed';
      result.trashIds[snap.id] = trashId;
      result.archived.push(snap.id);
    } catch (err) {
      record.result = 'failed';
      record.error = err instanceof Error ? err.message : String(err);
      result.failed.push({ id: snap.id, error: record.error });
    }
    result.audit.push(record);
    try {
      deps.audit(record);
    } catch (err) {
      result.auditFailed.push({ memoryId: snap.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
