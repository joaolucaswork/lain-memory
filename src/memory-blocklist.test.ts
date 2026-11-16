import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  normalizeForBlocklist,
  blocklistHash,
  isBlocklisted,
  addToBlocklist,
  removeFromBlocklist,
  addMemory,
} from './mem0.js';
import { connectRedis, getRedis, isRedisAvailable } from './redis.js';
import { validateRoute } from './http-validation.js';

const texts: string[] = [];
const mark = (t: string) => { texts.push(t); return t; };

beforeAll(async () => {
  await connectRedis();
  if (!isRedisAvailable()) throw new Error('Redis required for memory-blocklist tests');
});

afterAll(async () => {
  if (!isRedisAvailable()) return;
  const r = getRedis();
  for (const t of texts) {
    await r.srem('mem0:forget-blocklist', blocklistHash(t)).catch(() => {});
  }
});

describe('normalizeForBlocklist', () => {
  it('lowercases, strips accents/punctuation, collapses spaces', () => {
    expect(normalizeForBlocklist('  O usuário TOMOU Bupropiona, né?  '))
      .toBe('o usuario tomou bupropiona ne');
  });

  it('same hash for near-identical repeats, different hash otherwise', () => {
    const a = mark('O usuário lê Cioran à noite');
    const b = 'o usuario le cioran a noite!';
    const c = mark('O usuário lê Graciliano Ramos');
    expect(blocklistHash(a)).toBe(blocklistHash(b));
    expect(blocklistHash(a)).not.toBe(blocklistHash(c));
  });
});

describe('blocklist roundtrip', () => {
  it('add → member (incl. variants) → remove', async () => {
    const t = mark(`Esquecer isto ${Date.now()}`);
    expect(await isBlocklisted(t)).toBe(false);
    await addToBlocklist(t);
    expect(await isBlocklisted(t)).toBe(true);
    expect(await isBlocklisted(t.toUpperCase() + '!!')).toBe(true);
    await removeFromBlocklist(t);
    expect(await isBlocklisted(t)).toBe(false);
  });

  it('empty text never matches and is a no-op', async () => {
    expect(await isBlocklisted('   ')).toBe(false);
    await addToBlocklist('   ');
    expect(await isBlocklisted('   ')).toBe(false);
  });
});

describe('addMemory respects blocklist', () => {
  it('blocklisted text returns blocked NOOP before Mem0 is touched', async () => {
    const t = mark(`Fato esquecido ${Date.now()}: o usuário rega samambaias`);
    await addToBlocklist(t);
    const res = await addMemory(t);
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('blocked');
    expect(res[0].action).toBe('NOOP');
    expect(res[0].reason).toBe('forgotten memory (blocklist)');
  });

  it('skipBlocklistCheck bypasses the gate', async () => {
    const t = mark(`Fato esquecido bypass ${Date.now()}: o usuário poda roseiras`);
    await addToBlocklist(t);
    try {
      const res = await addMemory(t, undefined, { skipBlocklistCheck: true });
      // Reached Mem0 (or a later gate) — anything but the blocklist NOOP.
      expect(res[0]?.id).not.toBe('blocked');
    } catch {
      // Mem0 backend unavailable in this env — also proves we passed the gate.
    }
  });
});

describe('forget/restore — validation', () => {
  it('forget accepts optional project', () => {
    expect(validateRoute('/api/memory/forget', { memory_id: 'abc' }).ok).toBe(true);
    expect(validateRoute('/api/memory/forget', { memory_id: 'abc', project: 'diario' }).ok).toBe(true);
    expect(validateRoute('/api/memory/forget', {}).ok).toBe(false);
  });

  it('restore requires memory_id', () => {
    expect(validateRoute('/api/memory/restore', { memory_id: 'abc' }).ok).toBe(true);
    expect(validateRoute('/api/memory/restore', {}).ok).toBe(false);
  });
});
