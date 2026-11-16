#!/usr/bin/env bun
/**
 * Migrate user state out of Redis (issue #11).
 *
 * Copies every `mem0:feedback:*` / `mem0:importance:*` key and the
 * `mem0:forget-blocklist` set into the new homes:
 *   feedback/importance → Qdrant point payload (memory-state.ts)
 *   blocklist hashes    → $WORKSPACE/.knowledge/forget-blocklist.json
 *
 * Properties:
 *   - Idempotent: re-running copies nothing new (Qdrant state wins over
 *     Redis — a newer vote is never clobbered by an older Redis entry).
 *   - Read-only on Redis: NOTHING is deleted from Redis. Flush it manually
 *     after verifying the new reads (see README).
 *   - `--dry-run` writes nothing anywhere (asserted by tests).
 *   - Orphan ids (valid shape, no Qdrant point) are REPORTED, not failed:
 *     they print under "sem correspondência no Qdrant".
 *   - Exit 1 only on real write/read errors; missing points exit 0.
 *
 * Usage:
 *   bun run scripts/migrate-state-from-redis.ts [--dry-run]
 */
import { connectRedis, getRedis, isRedisAvailable } from '../src/redis.js';
import { INSTANCE_ID } from '../src/workspace.js';
import {
  readQdrantState,
  setFeedback,
  setImportance,
  sanitizeFeedback,
  isQueryableId,
  type MemoryFeedback,
} from '../src/memory-state.js';
import { getBlocklistHashes, addHashesToBlocklist } from '../src/forget-blocklist.js';

export interface AspectReport {
  found: number;
  copied: number;
  skippedHaveState: number;
  invalid: number;
}

export interface MigrationResult {
  dryRun: boolean;
  feedback: AspectReport;
  importance: AspectReport;
  blocklist: { found: number; copied: number; alreadyHad: number };
  /** Valid ids with no Qdrant point (nothing to migrate onto) — reported, not errors. */
  missingIds: string[];
  errors: Array<{ id: string; error: string }>;
}

const FEEDBACK_TAG = 'mem0:feedback:';
const IMPORTANCE_TAG = 'mem0:importance:';
const BLOCKLIST_KEY = 'mem0:forget-blocklist';

function emptyAspect(): AspectReport {
  return { found: 0, copied: 0, skippedHaveState: 0, invalid: 0 };
}

function isNotFoundMessage(msg: string): boolean {
  return /not found/i.test(msg) || /\b404\b/.test(msg);
}

/** Full-prefixed keys (ioredis keyPrefix is NOT applied to SCAN patterns — see invalidateMem0Cache). */
async function scanKeys(match: string): Promise<string[]> {
  const out: string[] = [];
  const stream = getRedis().scanStream({ match, count: 500 });
  for await (const keys of stream) {
    out.push(...(keys as string[]));
  }
  return out;
}

export async function runMigration(opts: { dryRun: boolean }): Promise<MigrationResult> {
  const { dryRun } = opts;
  const result: MigrationResult = {
    dryRun,
    feedback: emptyAspect(),
    importance: emptyAspect(),
    blocklist: { found: 0, copied: 0, alreadyHad: 0 },
    missingIds: [],
    errors: [],
  };

  await connectRedis();
  if (!isRedisAvailable()) {
    throw new Error('migrate-state: Redis unavailable — aborting, no writes made');
  }
  const prefix = INSTANCE_ID ? `lain:${INSTANCE_ID}:` : 'lain:';
  const strip = (key: string, tag: string) => key.slice((prefix + tag).length);

  // ── Feedback ──
  const feedbackKeys = await scanKeys(`${prefix}${FEEDBACK_TAG}*`);
  const feedbackIds = feedbackKeys.map((k) => strip(k, FEEDBACK_TAG));
  result.feedback.found = feedbackIds.length;
  const feedbackValues = new Map<string, string | null>();
  if (feedbackIds.length > 0) {
    const pipe = getRedis().pipeline();
    for (const id of feedbackIds) pipe.get(FEEDBACK_TAG + id);
    const rows = await pipe.exec();
    feedbackIds.forEach((id, i) => {
      feedbackValues.set(id, (rows?.[i]?.[1] as string | null) ?? null);
    });
  }
  const feedbackToCheck = feedbackIds.filter((id) => {
    const raw = feedbackValues.get(id);
    if (!raw) { result.feedback.invalid++; return false; }
    try {
      JSON.parse(raw);
    } catch { result.feedback.invalid++; return false; }
    return true;
  });
  const feedbackQ = await readQdrantState(feedbackToCheck);
  const unqueryableFb = feedbackToCheck.filter((id) => !isQueryableId(id));
  for (const id of unqueryableFb) {
    // Legacy/test keys that can never resolve to a point — report, don't fail.
    if (!result.missingIds.includes(id)) result.missingIds.push(id);
  }
  for (const id of feedbackToCheck) {
    if (!isQueryableId(id)) continue;
    const raw = feedbackValues.get(id)!;
    const q = feedbackQ.get(id);
    if (!q || !q.answered) {
      result.errors.push({ id, error: 'Qdrant read failed (transport)' });
      continue;
    }
    if (!q.exists) {
      if (!result.missingIds.includes(id)) result.missingIds.push(id);
      continue;
    }
    if (q.feedback !== null) {
      result.feedback.skippedHaveState++; // Qdrant already voted — never clobber
      continue;
    }
    if (dryRun) {
      result.feedback.copied++;
      continue;
    }
    try {
      const parsed = sanitizeFeedback(JSON.parse(raw) as Partial<MemoryFeedback>);
      await setFeedback(id, parsed);
      result.feedback.copied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isNotFoundMessage(msg)) {
        if (!result.missingIds.includes(id)) result.missingIds.push(id);
      } else {
        result.errors.push({ id, error: msg });
      }
    }
  }

  // ── Importance ──
  const importanceKeys = await scanKeys(`${prefix}${IMPORTANCE_TAG}*`);
  const importanceIds = importanceKeys.map((k) => strip(k, IMPORTANCE_TAG));
  result.importance.found = importanceIds.length;
  const importanceValues = new Map<string, number | null>();
  if (importanceIds.length > 0) {
    const pipe = getRedis().pipeline();
    for (const id of importanceIds) pipe.get(IMPORTANCE_TAG + id);
    const rows = await pipe.exec();
    importanceIds.forEach((id, i) => {
      const raw = rows?.[i]?.[1] as string | null;
      const score = raw === null ? NaN : parseFloat(raw);
      importanceValues.set(id, isNaN(score) ? null : score);
    });
  }
  const importanceToCheck = importanceIds.filter((id) => {
    if (importanceValues.get(id) === null) { result.importance.invalid++; return false; }
    return true;
  });
  const importanceQ = await readQdrantState(importanceToCheck);
  for (const id of importanceToCheck.filter((id) => !isQueryableId(id))) {
    if (!result.missingIds.includes(id)) result.missingIds.push(id);
  }
  for (const id of importanceToCheck) {
    if (!isQueryableId(id)) continue;
    const q = importanceQ.get(id);
    if (!q || !q.answered) {
      result.errors.push({ id, error: 'Qdrant read failed (transport)' });
      continue;
    }
    if (!q.exists) {
      if (!result.missingIds.includes(id)) result.missingIds.push(id);
      continue;
    }
    if (q.importance !== null) {
      result.importance.skippedHaveState++;
      continue;
    }
    if (dryRun) {
      result.importance.copied++;
      continue;
    }
    try {
      await setImportance(id, importanceValues.get(id)!);
      result.importance.copied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isNotFoundMessage(msg)) {
        if (!result.missingIds.includes(id)) result.missingIds.push(id);
      } else {
        result.errors.push({ id, error: msg });
      }
    }
  }

  // ── Blocklist ──
  const hashes = await getRedis().smembers(BLOCKLIST_KEY);
  result.blocklist.found = hashes.length;
  const clean = [...new Set(hashes.filter((h) => typeof h === 'string' && h.trim()))];
  if (clean.length > 0) {
    const current = await getBlocklistHashes();
    const toAdd = clean.filter((h) => !current.has(h));
    result.blocklist.alreadyHad = clean.length - toAdd.length;
    if (!dryRun && toAdd.length > 0) {
      await addHashesToBlocklist(toAdd);
    }
    result.blocklist.copied = toAdd.length;
  }

  return result;
}

function printReport(r: MigrationResult): void {
  const tag = r.dryRun ? '[dry-run] ' : '';
  console.log(`${tag}feedback:   found=${r.feedback.found} copied=${r.feedback.copied} skipped(have-state)=${r.feedback.skippedHaveState} invalid=${r.feedback.invalid}`);
  console.log(`${tag}importance: found=${r.importance.found} copied=${r.importance.copied} skipped(have-state)=${r.importance.skippedHaveState} invalid=${r.importance.invalid}`);
  console.log(`${tag}blocklist:  found=${r.blocklist.found} copied=${r.blocklist.copied} already-had=${r.blocklist.alreadyHad}`);
  if (r.missingIds.length > 0) {
    console.log(`sem correspondência no Qdrant (${r.missingIds.length}):`);
    for (const id of r.missingIds.slice(0, 50)) console.log(`  - ${id}`);
    if (r.missingIds.length > 50) console.log(`  ... +${r.missingIds.length - 50} more`);
  } else {
    console.log('sem correspondência no Qdrant: none');
  }
  if (r.errors.length > 0) {
    console.log(`ERRORS (${r.errors.length}):`);
    for (const e of r.errors.slice(0, 20)) console.log(`  - ${e.id}: ${e.error}`);
  }
}

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const result = await runMigration({ dryRun });
    printReport(result);
    process.exit(result.errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.error('migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
