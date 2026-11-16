import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectRedis, getRedis, isRedisAvailable } from './redis.js';
import {
  getMemoryFeedback,
  getMemoryImportance,
  __setBlocklistPathForTests,
} from './mem0.js';
import { getBlocklistHashes } from './forget-blocklist.js';
import { FEEDBACK_DEFAULTS } from './memory-state.js';
import { newTestPoint, deleteTestPoints } from './test-points.js';
import { runMigration } from '../scripts/migrate-state-from-redis.js';

const pointIds: string[] = [];
const redisKeys: string[] = [];
let dir: string;

const TEST_HASH = 'migration-test-hash-' + randomUUID().replace(/-/g, '').slice(0, 16);

beforeAll(async () => {
  await connectRedis();
  if (!isRedisAvailable()) throw new Error('Redis required for state-migration tests');
  dir = mkdtempSync(join(tmpdir(), 'state-migration-test-'));
  __setBlocklistPathForTests(join(dir, 'forget-blocklist.json'));
  // Qdrant probe — fail fast without the authority.
  const probe = await newTestPoint('migration-probe');
  pointIds.push(probe);
  await deleteTestPoints([probe]);
});

afterAll(async () => {
  __setBlocklistPathForTests(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  await deleteTestPoints(pointIds).catch(() => {});
  if (isRedisAvailable()) {
    if (redisKeys.length > 0) await getRedis().del(...redisKeys).catch(() => {});
    await getRedis().srem('mem0:forget-blocklist', TEST_HASH).catch(() => {});
  }
});

describe('migrate-state-from-redis (issue #11)', () => {
  it('dry-run reports counts but writes nothing', async () => {
    const base = await runMigration({ dryRun: true });

    const id = await newTestPoint('migration-src');
    pointIds.push(id);
    const ghost = randomUUID(); // valid shape, no Qdrant point
    const fbKey = `mem0:feedback:${id}`;
    const imKey = `mem0:importance:${id}`;
    redisKeys.push(fbKey, imKey, `mem0:feedback:${ghost}`, `mem0:importance:${ghost}`);
    // Junk key that can never resolve (legacy non-UUID) — must not fail the run.
    redisKeys.push('mem0:feedback:not-a-point');
    await getRedis().set(fbKey, JSON.stringify({ confidence: 1.0, correct_count: 5, title: 'mig' }), 'EX', 3600);
    await getRedis().set(imKey, '0.77', 'EX', 3600);
    await getRedis().set(`mem0:feedback:${ghost}`, JSON.stringify({ confidence: 1.0 }), 'EX', 3600);
    await getRedis().set(`mem0:importance:${ghost}`, '0.9', 'EX', 3600);
    await getRedis().set('mem0:feedback:not-a-point', JSON.stringify({ confidence: 1.0 }), 'EX', 3600);
    await getRedis().sadd('mem0:forget-blocklist', TEST_HASH);

    const r = await runMigration({ dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.errors).toEqual([]);
    // Deltas vs baseline (the dev Redis may hold unrelated junk keys).
    expect(r.feedback.copied - base.feedback.copied).toBe(1);
    expect(r.importance.copied - base.importance.copied).toBe(1);
    expect(r.blocklist.copied - base.blocklist.copied).toBe(1);
    expect(r.missingIds).toContain(ghost);
    expect(r.missingIds).toContain('not-a-point');

    // ...but wrote nothing anywhere authoritative: Qdrant untouched
    // (reads fall through to L2 by design) and the blocklist file is empty.
    const { readQdrantState } = await import('./memory-state.js');
    expect((await readQdrantState([id])).get(id)).toMatchObject({
      exists: true, feedback: null, importance: null,
    });
    expect(await getBlocklistHashes()).toEqual(new Set());
  });

  it('real run copies state + blocklist, is idempotent', async () => {
    const before = await runMigration({ dryRun: true });
    const r1 = await runMigration({ dryRun: false });
    expect(r1.errors).toEqual([]);
    // Copies exactly what dry-run reported (nothing changed in between).
    expect(r1.feedback.copied).toBe(before.feedback.copied);
    expect(r1.importance.copied).toBe(before.importance.copied);
    expect(r1.blocklist.copied).toBe(before.blocklist.copied);
    expect(r1.feedback.copied).toBeGreaterThan(0);

    const id = redisKeys[0].slice('mem0:feedback:'.length);
    const ghost = redisKeys[2].slice('mem0:feedback:'.length);
    expect(await getMemoryFeedback(id)).toMatchObject({ confidence: 1.0, correct_count: 5, title: 'mig' });
    expect(await getMemoryImportance(id)).toBe(0.77);
    expect(await getBlocklistHashes()).toContain(TEST_HASH);
    expect(r1.missingIds).toContain(ghost);

    // Second run: nothing left to copy (Qdrant wins, file already has it).
    const r2 = await runMigration({ dryRun: false });
    expect(r2.errors).toEqual([]);
    expect(r2.feedback.copied).toBe(0);
    expect(r2.importance.copied).toBe(0);
    expect(r2.blocklist.copied).toBe(0);
    expect(r2.feedback.skippedHaveState).toBeGreaterThanOrEqual(1);
    expect(r2.importance.skippedHaveState).toBeGreaterThanOrEqual(1);
    expect(r2.blocklist.alreadyHad).toBeGreaterThanOrEqual(1);
    expect(r2.missingIds).toContain(ghost);
  });
});
