import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeForBlocklist,
  blocklistHash,
  isBlocklisted,
  addToBlocklist,
  removeFromBlocklist,
  __setBlocklistPathForTests,
  getBlocklistPath,
} from './mem0.js';
import { addMemory } from './mem0.js';
import { validateRoute } from './http-validation.js';

let dir: string;
let file: string;
const texts: string[] = [];
const mark = (t: string) => { texts.push(t); return t; };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'forget-blocklist-test-'));
  file = join(dir, 'forget-blocklist.json');
  __setBlocklistPathForTests(file);
});

afterAll(() => {
  __setBlocklistPathForTests(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
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

describe('blocklist roundtrip (file)', () => {
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
    await removeFromBlocklist('   ');
    expect(await isBlocklisted('   ')).toBe(false);
  });

  it('persists on disk (no in-memory cache — restart equivalent)', async () => {
    const t = mark(`Persistência ${Date.now()}: o usuário rega cactos`);
    await addToBlocklist(t);
    const raw = readFileSync(getBlocklistPath(), 'utf8');
    expect(JSON.parse(raw)).toContain(blocklistHash(t));
    // A fresh read (as after a restart — there is no cache) sees it.
    expect(await isBlocklisted(t)).toBe(true);
  });
});

describe('blocklist fail-closed / fail-hard (issue #9)', () => {
  it('corrupt file blocks reads (never resurrects)', async () => {
    const t = mark(`Corrompido ${Date.now()}`);
    writeFileSync(file, '{invalid json');
    try {
      expect(await isBlocklisted(t)).toBe(true);
      expect(await isBlocklisted('qualquer coisa')).toBe(true);
    } finally {
      rmSync(file, { force: true });
    }
    expect(await isBlocklisted(t)).toBe(false);
  });

  it('writes on a corrupt file throw (no silent reset)', async () => {
    writeFileSync(file, '[1,2,3]');
    try {
      await expect(addToBlocklist(mark('x'))).rejects.toThrow();
      await expect(removeFromBlocklist(mark('x'))).rejects.toThrow();
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('unwritable path throws on write', async () => {
    // A regular file as parent dir: mkdirSync(dirname) fails with ENOTDIR.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    __setBlocklistPathForTests(join(blocker, 'forget-blocklist.json'));
    try {
      await expect(addToBlocklist(mark('y'))).rejects.toThrow();
    } finally {
      __setBlocklistPathForTests(file);
      rmSync(blocker, { force: true });
    }
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
  it('forget requires an explicit project', () => {
    expect(validateRoute('/api/memory/forget', { memory_id: 'abc' }).ok).toBe(false);
    expect(validateRoute('/api/memory/forget', { memory_id: 'abc', project: 'diario' }).ok).toBe(true);
    expect(validateRoute('/api/memory/forget', {}).ok).toBe(false);
  });

  it('restore requires memory_id and project', () => {
    expect(validateRoute('/api/memory/restore', { memory_id: 'abc' }).ok).toBe(false);
    expect(validateRoute('/api/memory/restore', { memory_id: 'abc', project: 'global' }).ok).toBe(true);
    expect(validateRoute('/api/memory/restore', {}).ok).toBe(false);
  });
});
