import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  getMemoryFeedback,
  setMemoryFeedback,
  applyMemoryFeedback,
  getMemoryImportance,
  setMemoryImportance,
  getManyMemoryFeedback,
  attachFeedback,
  FEEDBACK_DEFAULTS,
} from './mem0.js';
import { connectRedis, disconnectRedis, getRedis, isRedisAvailable } from './redis.js';
import { clearImportance, readQdrantState } from './memory-state.js';
import { validateRoute } from './http-validation.js';
import { newTestPoint, deleteTestPoints } from './test-points.js';

const ids: string[] = [];
const newId = async () => {
  const id = await newTestPoint('fb-test');
  ids.push(id);
  return id;
};

beforeAll(async () => {
  await connectRedis();
  if (!isRedisAvailable()) throw new Error('Redis required for memory-feedback tests');
  // Qdrant must answer (it is the authority now) — fail fast otherwise.
  await newTestPoint('fb-probe').then(async (id) => {
    ids.push(id);
    await deleteTestPoints([id]);
  }).catch(() => { throw new Error('Qdrant required for memory-feedback tests'); });
});

afterAll(async () => {
  await deleteTestPoints(ids).catch(() => {});
  if (!isRedisAvailable()) return;
  const r = getRedis();
  const keys = ids.flatMap((id) => [`mem0:feedback:${id}`, `mem0:importance:${id}`, `mem0:touch:${id}`]);
  if (keys.length > 0) await r.del(...keys).catch(() => {});
});

describe('getMemoryFeedback — defaults', () => {
  it('unknown id returns neutral defaults (ranking unchanged)', async () => {
    expect(await getMemoryFeedback(await newId())).toEqual(FEEDBACK_DEFAULTS);
  });
});

describe('setMemoryFeedback — merge + sanitize', () => {
  it('roundtrips a partial patch over defaults', async () => {
    const id = await newId();
    const next = await setMemoryFeedback(id, { kind: 'state' });
    expect(next.kind).toBe('state');
    expect(next.confidence).toBe(0.5);
    expect(await getMemoryFeedback(id)).toEqual(next);
  });

  it('clamps out-of-range confidence and unknown enums', async () => {
    const id = await newId();
    const next = await setMemoryFeedback(id, {
      confidence: 5,
      status: 'deleted' as never,
      kind: 'mood' as never,
      correct_count: -3,
    });
    expect(next.confidence).toBe(1);
    expect(next.status).toBe('active');
    expect(next.kind).toBe('fact');
    expect(next.correct_count).toBe(0);
  });
});

describe('applyMemoryFeedback — confirm', () => {
  it('sets full confidence, timestamp, count and importance floor', async () => {
    const id = await newId();
    const before = new Date().toISOString();
    const next = await applyMemoryFeedback(id, 'confirm');
    expect(next.confidence).toBe(1.0);
    expect(next.status).toBe('active');
    expect(next.correct_count).toBe(1);
    expect(next.last_confirmed_at).not.toBeNull();
    expect(next.last_confirmed_at! >= before).toBe(true);
    // Importance floor 0.85 (180d half-life protection); touch reinforce may add +0.05.
    expect(await getMemoryImportance(id)).toBeGreaterThanOrEqual(0.85);
  });

  it('second confirm bumps correct_count', async () => {
    const id = await newId();
    await applyMemoryFeedback(id, 'confirm');
    const next = await applyMemoryFeedback(id, 'confirm');
    expect(next.correct_count).toBe(2);
    expect(next.confidence).toBe(1.0);
  });

  it('accepts kind override', async () => {
    const id = await newId();
    const next = await applyMemoryFeedback(id, 'confirm', { kind: 'state' });
    expect(next.kind).toBe('state');
  });
});

describe('applyMemoryFeedback — archive / unarchive', () => {
  it('archive keeps confidence but flips status', async () => {
    const id = await newId();
    await applyMemoryFeedback(id, 'confirm');
    const next = await applyMemoryFeedback(id, 'archive');
    expect(next.status).toBe('archived');
    expect(next.confidence).toBe(1.0);
    expect(next.correct_count).toBe(1);
  });

  it('unarchive restores active and refreshes timestamp', async () => {
    const id = await newId();
    await applyMemoryFeedback(id, 'archive');
    const before = new Date().toISOString();
    const next = await applyMemoryFeedback(id, 'unarchive');
    expect(next.status).toBe('active');
    expect(next.last_confirmed_at).not.toBeNull();
    expect(next.last_confirmed_at! >= before).toBe(true);
  });
});

describe('setMemoryFeedback — title', () => {
  it('roundtrips a title and merges with votes without clobbering', async () => {
    const id = await newId();
    await setMemoryFeedback(id, { title: 'dor pulsante na têmpora' });
    expect((await getMemoryFeedback(id)).title).toBe('dor pulsante na têmpora');
    // vote merge (e.g. confirm after title) preserves the title
    const next = await applyMemoryFeedback(id, 'confirm');
    expect(next.title).toBe('dor pulsante na têmpora');
    expect(next.confidence).toBe(1.0);
    // kind patch (e.g. state tagging after title) preserves it too
    const kinded = await setMemoryFeedback(id, { kind: 'state' });
    expect(kinded.title).toBe('dor pulsante na têmpora');
    expect(kinded.kind).toBe('state');
  });

  it('sanitizes title: trims, caps at 80 chars, non-string becomes null', async () => {
    const id = await newId();
    const long = `  ${'palavra '.repeat(30)}  `;
    const next = await setMemoryFeedback(id, { title: long });
    expect(next.title!.length).toBeLessThanOrEqual(80);
    expect(next.title).toBe(long.trim().slice(0, 80));
    const nulled = await setMemoryFeedback(id, { title: 42 as never });
    expect(nulled.title).toBeNull();
  });

  it('attachFeedback carries title to list items, null by default', async () => {
    const titled = await newId();
    await setMemoryFeedback(titled, { title: 'banana assada com batata' });
    const fresh = await newId();
    const out = await attachFeedback([
      { id: titled, memory: 'a' },
      { id: fresh, memory: 'b' },
    ]);
    expect(out[0].title).toBe('banana assada com batata');
    expect(out[1].title).toBeNull();
  });
});

describe('/api/memory/feedback — validation', () => {
  it('accepts confirm/archive/unarchive with optional kind', () => {
    for (const action of ['confirm', 'archive', 'unarchive']) {
      const r = validateRoute('/api/memory/feedback', { id: 'abc', action });
      expect(r.ok).toBe(true);
    }
    const r = validateRoute('/api/memory/feedback', { id: 'abc', action: 'confirm', kind: 'state' });
    expect(r.ok).toBe(true);
  });

  it('rejects bad action, bad kind, missing id', () => {
    expect(validateRoute('/api/memory/feedback', { id: 'abc', action: 'forget' }).ok).toBe(false);
    expect(validateRoute('/api/memory/feedback', { id: 'abc', action: 'confirm', kind: 'mood' }).ok).toBe(false);
    expect(validateRoute('/api/memory/feedback', { action: 'confirm' }).ok).toBe(false);
  });
});

describe('getManyMemoryFeedback + attachFeedback', () => {
  it('batch fetch returns stored votes and defaults for the rest', async () => {
    const voted = await newId();
    const fresh = await newId();
    await setMemoryFeedback(voted, { confidence: 1.0, kind: 'state' });
    const map = await getManyMemoryFeedback([voted, fresh, voted]);
    expect(map.get(voted)?.confidence).toBe(1.0);
    expect(map.get(voted)?.kind).toBe('state');
    expect(map.get(fresh)).toEqual(FEEDBACK_DEFAULTS);
  });

  it('attachFeedback enriches list items additively', async () => {
    const voted = await newId();
    await setMemoryFeedback(voted, { status: 'archived' });
    const fresh = await newId();
    const out = await attachFeedback([
      { id: voted, memory: 'a' },
      { id: fresh, memory: 'b' },
    ]);
    expect(out[0].status).toBe('archived');
    expect(out[0].memory).toBe('a');
    expect(out[1].status).toBe('active');
    expect(out[1].confidence).toBe(0.5);
  });

  it('empty input returns empty without touching backends', async () => {
    expect(await attachFeedback([])).toEqual([]);
    expect(await getManyMemoryFeedback([])).toEqual(new Map());
  });
});

describe('memory-state — Qdrant authority (issue #8)', () => {
  it('survives an L2 eviction (flush equivalent): falls through to Qdrant', async () => {
    const id = await newId();
    await setMemoryFeedback(id, { confidence: 1.0, title: 'sobrevive flush' });
    await setMemoryImportance(id, 0.9);
    // Evict exactly this id's L2 entries (same code path as a full flush,
    // without wiping other tests' keys).
    await getRedis().del(`mem0:feedback:${id}`, `mem0:importance:${id}`);
    expect((await getMemoryFeedback(id)).confidence).toBe(1.0);
    expect((await getMemoryFeedback(id)).title).toBe('sobrevive flush');
    expect(await getMemoryImportance(id)).toBe(0.9);
  });

  it('works with Redis unavailable (Qdrant authority)', async () => {
    const id = await newId();
    await setMemoryFeedback(id, { confidence: 1.0 });
    await disconnectRedis();
    try {
      // Reads degrade to Qdrant, not to defaults.
      expect((await getMemoryFeedback(id)).confidence).toBe(1.0);
      // Writes go to Qdrant (L2 skipped), merging — not resetting — state.
      const next = await setMemoryFeedback(id, { kind: 'state' });
      expect(next.kind).toBe('state');
      expect(next.confidence).toBe(1.0);
      // Confirmed-missing importance reads null (not the unreachable default).
      expect(await getMemoryImportance(id)).toBeNull();
    } finally {
      const { connectRedis: reconnect } = await import('./redis.js');
      await reconnect();
    }
    expect((await getMemoryFeedback(id)).kind).toBe('state');
  });

  it('write to a missing point throws (never silent success)', async () => {
    const ghost = randomUUID(); // valid UUID, no Qdrant point
    ids.push(ghost);
    await expect(setMemoryFeedback(ghost, { confidence: 1 })).rejects.toThrow();
    await expect(setMemoryImportance(ghost, 0.9)).rejects.toThrow();
  });

  it('reads on missing/garbage ids degrade to defaults (never throw)', async () => {
    const ghost = randomUUID();
    ids.push(ghost);
    await expect(getMemoryFeedback(ghost)).resolves.toEqual(FEEDBACK_DEFAULTS);
    await expect(getMemoryImportance(ghost)).resolves.toBeNull();
    await expect(getMemoryFeedback('not-a-point')).resolves.toEqual(FEEDBACK_DEFAULTS);
  });
});

describe('clearImportance — rollback path', () => {
  it('set → clear volta a null sem tocar no feedback', async () => {
    const id = await newId();
    await setMemoryImportance(id, 0.8);
    expect(await getMemoryImportance(id)).toBe(0.8);
    await clearImportance(id);
    expect((await readQdrantState([id])).get(id)).toMatchObject({ exists: true, importance: null });
    expect(await getMemoryImportance(id)).toBeNull();
    expect(await getMemoryFeedback(id)).toEqual(FEEDBACK_DEFAULTS);
  });
});
