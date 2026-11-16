import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  getMemoryFeedback,
  setMemoryFeedback,
  applyMemoryFeedback,
  getMemoryImportance,
  getManyMemoryFeedback,
  attachFeedback,
  FEEDBACK_DEFAULTS,
} from './mem0.js';
import { connectRedis, getRedis, isRedisAvailable } from './redis.js';
import { validateRoute } from './http-validation.js';

const ids: string[] = [];
const newId = () => {
  const id = `fb-test-${randomUUID()}`;
  ids.push(id);
  return id;
};

beforeAll(async () => {
  await connectRedis();
  if (!isRedisAvailable()) throw new Error('Redis required for memory-feedback tests');
});

afterAll(async () => {
  if (!isRedisAvailable()) return;
  const r = getRedis();
  const keys = ids.flatMap((id) => [`mem0:feedback:${id}`, `mem0:importance:${id}`, `mem0:touch:${id}`]);
  if (keys.length > 0) await r.del(...keys).catch(() => {});
});

describe('getMemoryFeedback — defaults', () => {
  it('unknown id returns neutral defaults (ranking unchanged)', async () => {
    expect(await getMemoryFeedback(newId())).toEqual(FEEDBACK_DEFAULTS);
  });
});

describe('setMemoryFeedback — merge + sanitize', () => {
  it('roundtrips a partial patch over defaults', async () => {
    const id = newId();
    const next = await setMemoryFeedback(id, { kind: 'state' });
    expect(next.kind).toBe('state');
    expect(next.confidence).toBe(0.5);
    expect(await getMemoryFeedback(id)).toEqual(next);
  });

  it('clamps out-of-range confidence and unknown enums', async () => {
    const id = newId();
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
    const id = newId();
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
    const id = newId();
    await applyMemoryFeedback(id, 'confirm');
    const next = await applyMemoryFeedback(id, 'confirm');
    expect(next.correct_count).toBe(2);
    expect(next.confidence).toBe(1.0);
  });

  it('accepts kind override', async () => {
    const id = newId();
    const next = await applyMemoryFeedback(id, 'confirm', { kind: 'state' });
    expect(next.kind).toBe('state');
  });
});

describe('applyMemoryFeedback — archive / unarchive', () => {
  it('archive keeps confidence but flips status', async () => {
    const id = newId();
    await applyMemoryFeedback(id, 'confirm');
    const next = await applyMemoryFeedback(id, 'archive');
    expect(next.status).toBe('archived');
    expect(next.confidence).toBe(1.0);
    expect(next.correct_count).toBe(1);
  });

  it('unarchive restores active and refreshes timestamp', async () => {
    const id = newId();
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
    const id = newId();
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
    const id = newId();
    const long = `  ${'palavra '.repeat(30)}  `;
    const next = await setMemoryFeedback(id, { title: long });
    expect(next.title!.length).toBeLessThanOrEqual(80);
    expect(next.title).toBe(long.trim().slice(0, 80));
    const nulled = await setMemoryFeedback(id, { title: 42 as never });
    expect(nulled.title).toBeNull();
  });

  it('attachFeedback carries title to list items, null by default', async () => {
    const titled = newId();
    ids.push(titled);
    await setMemoryFeedback(titled, { title: 'banana assada com batata' });
    const out = await attachFeedback([
      { id: titled, memory: 'a' },
      { id: `fb-title-fresh-${randomUUID()}`, memory: 'b' },
    ]);
    ids.push(out[1].id);
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
    const voted = `fb-batch-voted-${randomUUID()}`;
    const fresh = `fb-batch-fresh-${randomUUID()}`;
    ids.push(voted, fresh);
    await setMemoryFeedback(voted, { confidence: 1.0, kind: 'state' });
    const map = await getManyMemoryFeedback([voted, fresh, voted]);
    expect(map.get(voted)?.confidence).toBe(1.0);
    expect(map.get(voted)?.kind).toBe('state');
    expect(map.get(fresh)).toEqual(FEEDBACK_DEFAULTS);
  });

  it('attachFeedback enriches list items additively', async () => {
    const voted = `fb-attach-voted-${randomUUID()}`;
    ids.push(voted);
    await setMemoryFeedback(voted, { status: 'archived' });
    const out = await attachFeedback([
      { id: voted, memory: 'a' },
      { id: `fb-attach-fresh-${randomUUID()}`, memory: 'b' },
    ]);
    ids.push(out[1].id);
    expect(out[0].status).toBe('archived');
    expect(out[0].memory).toBe('a');
    expect(out[1].status).toBe('active');
    expect(out[1].confidence).toBe(0.5);
  });

  it('empty input returns empty without touching Redis', async () => {
    expect(await attachFeedback([])).toEqual([]);
    expect(await getManyMemoryFeedback([])).toEqual(new Map());
  });
});
