/**
 * Pending review queue — backlog for LLM verdicts the automatic sweep
 * detects but must not action alone:
 * - kind 'merge' (UPDATE verdict): candidate fragment set for consolidation.
 * - kind 'contradiction' (DELETE verdict): conflicting pair needing a human.
 *
 * Durable JSON file under the workspace (survives restarts, unlike Redis).
 * All mutations go through the per-file async mutex + atomic rename.
 * Reads are lock-free (single atomic file, torn reads impossible via rename).
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { PENDING_REVIEW_PATH } from './workspace.js';
import { withFileLock, safeWriteFileSync, safeReadFileSync } from './file-io-lock.js';

export type PendingKind = 'merge' | 'contradiction';
export type PendingStatus = 'pending' | 'done' | 'dismissed' | 'failed';

export interface PendingRelated {
  id: string;
  memory: string;
}

export interface PendingEntry {
  id: string;
  kind: PendingKind;
  status: PendingStatus;
  /** undefined = global scope */
  scope: string | undefined;
  /** The scanned memory that triggered the verdict */
  memoryId: string;
  memory: string;
  /** Conflicting / superseded memories (text snapshots) */
  related: PendingRelated[];
  reason: string;
  verdict: 'UPDATE' | 'DELETE';
  attempts: number;
  detectedAt: string;
  updatedAt: string;
  result?: { mergedId?: string; error?: string };
}

const MAX_DONE_KEPT = 200;
const MAX_TEXT = 2000; // per-memory snapshot cap in the queue file
const MAX_ATTEMPTS = 3;

/** Env override exists for tests (`LAIN_PENDING_REVIEW_PATH`). */
export function getQueuePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LAIN_PENDING_REVIEW_PATH;
  if (override && override.trim()) return override.trim();
  return PENDING_REVIEW_PATH;
}

function readQueue(file: string): PendingEntry[] {
  const raw = safeReadFileSync(file);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingEntry[]) : [];
  } catch {
    return [];
  }
}

function prune(entries: PendingEntry[]): PendingEntry[] {
  const pending = entries.filter(e => e.status === 'pending');
  const rest = entries.filter(e => e.status !== 'pending');
  return [...pending, ...rest.slice(-MAX_DONE_KEPT)];
}

export function listQueue(status?: PendingStatus, kind?: PendingKind, file?: string): PendingEntry[] {
  const all = readQueue(file ?? getQueuePath());
  return all.filter(
    e => (status ? e.status === status : true) && (kind ? e.kind === kind : true),
  );
}

export function listPending(kind?: PendingKind, file?: string): PendingEntry[] {
  return listQueue('pending', kind, file);
}

export async function enqueueVerdict(
  input: {
    kind: PendingKind;
    verdict: 'UPDATE' | 'DELETE';
    scope: string | undefined;
    memoryId: string;
    memory: string;
    related: PendingRelated[];
    reason: string;
  },
  file?: string,
): Promise<{ entry: PendingEntry; duplicate: boolean }> {
  const target = file ?? getQueuePath();
  return withFileLock(target, () => {
    const dir = dirname(target);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const all = readQueue(target);
    const dup = all.find(
      e => e.status === 'pending' && e.memoryId === input.memoryId && e.verdict === input.verdict,
    );
    if (dup) return { entry: dup, duplicate: true };
    const now = new Date().toISOString();
    const entry: PendingEntry = {
      id: randomUUID(),
      kind: input.kind,
      status: 'pending',
      scope: input.scope,
      memoryId: input.memoryId,
      memory: input.memory.slice(0, MAX_TEXT),
      related: input.related.map(r => ({ id: r.id, memory: r.memory.slice(0, MAX_TEXT) })),
      reason: input.reason.slice(0, 500),
      verdict: input.verdict,
      attempts: 0,
      detectedAt: now,
      updatedAt: now,
    };
    all.push(entry);
    safeWriteFileSync(target, JSON.stringify(prune(all), null, 2));
    return { entry, duplicate: false };
  });
}

export async function updateEntry(
  id: string,
  patch: Partial<Pick<PendingEntry, 'status' | 'attempts' | 'result'>>,
  file?: string,
): Promise<PendingEntry | null> {
  const target = file ?? getQueuePath();
  return withFileLock(target, () => {
    const all = readQueue(target);
    const e = all.find(x => x.id === id);
    if (!e) return null;
    Object.assign(e, patch, { updatedAt: new Date().toISOString() });
    safeWriteFileSync(target, JSON.stringify(prune(all), null, 2));
    return e;
  });
}

export async function dismissEntry(id: string, file?: string): Promise<boolean> {
  return (await updateEntry(id, { status: 'dismissed' }, file)) !== null;
}

/**
 * Claim up to `max` pending merges for a scope for consolidation.
 * Attempts are bumped on claim; entries at MAX_ATTEMPTS are left for a human.
 */
export async function claimPendingMerges(
  scope: string | undefined,
  max = 5,
  file?: string,
): Promise<PendingEntry[]> {
  const target = file ?? getQueuePath();
  return withFileLock(target, () => {
    const all = readQueue(target);
    const scopeKey = scope ?? 'global';
    const claimed = all
      .filter(
        e =>
          e.status === 'pending' &&
          e.kind === 'merge' &&
          (e.scope ?? 'global') === scopeKey &&
          (e.attempts ?? 0) < MAX_ATTEMPTS,
      )
      .slice(0, max);
    if (claimed.length === 0) return [];
    const now = new Date().toISOString();
    for (const c of claimed) {
      c.attempts = (c.attempts ?? 0) + 1;
      c.updatedAt = now;
    }
    safeWriteFileSync(target, JSON.stringify(prune(all), null, 2));
    return claimed.map(c => ({ ...c }));
  });
}

export function maxAttemptsReached(entry: PendingEntry): boolean {
  return (entry.attempts ?? 0) >= MAX_ATTEMPTS;
}
