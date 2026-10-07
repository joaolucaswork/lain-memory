import { promises as fsp } from 'fs';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';

// ── Event types ──────────────────────────────────────────────────────────────

interface ReaperEventBase {
  schema_version: 1;
  run_id: string;        // uuid4 — ties all events in one sweep together
  ts: string;            // ISO-8601 UTC
}

export interface ReaperStartEvent extends ReaperEventBase {
  event_type: 'start';
  project_count: number;
  cold_threshold_days: number;
  importance_threshold: number;
  dry_run: boolean;
}

export interface ReaperPurgeEvent extends ReaperEventBase {
  event_type: 'purge';   // live delete attempt (not guaranteed success — check error_delete)
  memory_id: string;
  project: string;
  importance: number;
  age_days: number;
}

export interface ReaperDryPurgeEvent extends ReaperEventBase {
  event_type: 'dry_purge';  // would-be delete in dry-run mode
  memory_id: string;
  project: string;
  importance: number;
  age_days: number;
}

export interface ReaperSkipAgeEvent extends ReaperEventBase {
  event_type: 'skip_age';   // memory not old enough — cutoff not met
  memory_id: string;
  project: string;
  age_days: number;          // -1 when memory has no date fields
}

export interface ReaperSkipNoImportanceEvent extends ReaperEventBase {
  event_type: 'skip_no_importance';  // old enough, but unscored (or importance fetch failed)
  memory_id: string;
  project: string;
  age_days: number;
}

export interface ReaperSkipImportanceEvent extends ReaperEventBase {
  event_type: 'skip_importance';  // old enough, but importance >= threshold
  memory_id: string;
  project: string;
  importance: number;
  age_days: number;
}

export interface ReaperErrorFetchEvent extends ReaperEventBase {
  event_type: 'error_fetch';  // getMemories(project) threw — project skipped
  project: string;
  message: string;
  stack?: string;
}

export interface ReaperErrorDeleteEvent extends ReaperEventBase {
  event_type: 'error_delete';  // deleteMemory(id) threw — memory NOT removed
  memory_id: string;
  project: string;
  message: string;
  stack?: string;
}

export interface ReaperFetchTruncatedEvent extends ReaperEventBase {
  event_type: 'fetch_truncated';
  project: string;
  fetch_limit: number;
  returned_count: number;
  hint: string;
}

export interface ReaperCompleteEvent extends ReaperEventBase {
  event_type: 'complete';
  purged: number;       // actual deletes (0 in dry-run)
  dry_purged: number;   // would-be deletes (0 in live)
  dry_run: boolean;
  duration_ms: number;
}

export type MemoryReaperEvent =
  | ReaperStartEvent
  | ReaperPurgeEvent
  | ReaperDryPurgeEvent
  | ReaperSkipAgeEvent
  | ReaperSkipNoImportanceEvent
  | ReaperSkipImportanceEvent
  | ReaperErrorFetchEvent
  | ReaperErrorDeleteEvent
  | ReaperFetchTruncatedEvent
  | ReaperCompleteEvent;

// ── Path resolution ───────────────────────────────────────────────────────────

function resolveAuditLogPath(): string {
  if (process.env.LAIN_REAPER_AUDIT_PATH) {
    return process.env.LAIN_REAPER_AUDIT_PATH;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return join(home, '.lain', 'audit', 'memory-reaper.log.jsonl');
}

const AUDIT_LOG_PATH = resolveAuditLogPath();

// ── Injectable handler (test seam) ───────────────────────────────────────────

let _testHandler: ((event: MemoryReaperEvent) => void) | null = null;
let _auditPathOverride: string | null = null;

/**
 * Override the audit log path at runtime (test seam). Pass null to restore the resolved default.
 */
export function setReaperAuditPath(path: string | null): void {
  _auditPathOverride = path;
}

function getAuditLogPath(): string {
  return _auditPathOverride ?? AUDIT_LOG_PATH;
}

/**
 * Override the default file-write behavior. Pass null to restore production mode.
 * Tests use this to capture events without filesystem I/O.
 */
export function setReaperAuditHandler(fn: ((event: MemoryReaperEvent) => void) | null): void {
  _testHandler = fn;
}

// ── Emitter ───────────────────────────────────────────────────────────────────

/**
 * Append a reaper event to the audit log. Fire-and-forget — call with `void`.
 * Never throws: all I/O errors are logged to console.error and swallowed.
 * In test mode (setReaperAuditHandler set), calls the handler synchronously and skips file I/O.
 */
export async function emitReaperEvent(event: MemoryReaperEvent): Promise<void> {
  try {
    if (_testHandler) {
      _testHandler(event);
      return;
    }
    mkdirSync(dirname(getAuditLogPath()), { recursive: true });
    await fsp.appendFile(getAuditLogPath(), JSON.stringify(event) + '\n', 'utf8');
  } catch (err) {
    console.error('[reaper-audit] Failed to emit event:', err);
  }
}
