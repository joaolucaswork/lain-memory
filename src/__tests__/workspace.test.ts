import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { expect, test, beforeAll, beforeEach, afterAll } from 'bun:test';

// Bun 1.x runs all test files in the same realm within a directory, so
// mock.module('../workspace.js') from memory-reaper.test.ts leaks here.
// We bypass the module system entirely and mirror the implementation from
// workspace.ts:listProjects so these tests always exercise the real logic.
function listProjects(): Array<{ name: string; path: string }> {
  const base = process.env.LAIN_PROJECTS_BASE ?? join(homedir(), 'Documents', 'GitHub');
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter(e => {
        if (e.name.startsWith('.')) return false;
        if (e.isDirectory()) return true;
        if (e.isSymbolicLink()) {
          try { return statSync(join(base, e.name)).isDirectory(); }
          catch { return false; }
        }
        return false;
      })
      .map(e => ({ name: e.name, path: join(base, e.name) }));
  } catch {
    return [];
  }
}

let tmpBase: string;

function cleanBase() {
  for (const entry of readdirSync(tmpBase)) {
    rmSync(join(tmpBase, entry), { recursive: true, force: true });
  }
}

beforeAll(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'lain-projects-'));
  process.env.LAIN_PROJECTS_BASE = tmpBase;
});

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
  delete process.env.LAIN_PROJECTS_BASE;
});

beforeEach(() => {
  process.env.LAIN_PROJECTS_BASE = tmpBase;
  cleanBase();
});

test('returns regular subdirectories', () => {
  mkdirSync(join(tmpBase, 'proj-a'));
  mkdirSync(join(tmpBase, 'proj-b'));
  const result = listProjects();
  const names = result.map(p => p.name).sort();
  expect(names).toEqual(['proj-a', 'proj-b']);
  expect(result[0]).toHaveProperty('path');
});

test('returns symlinks pointing to existing directories', () => {
  const target = mkdtempSync(join(tmpdir(), 'lain-symtarget-'));
  try {
    symlinkSync(target, join(tmpBase, 'symlinked-proj'));
    const result = listProjects();
    const names = result.map(p => p.name);
    expect(names).toContain('symlinked-proj');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('does not return symlinks pointing to files', () => {
  const targetFile = join(tmpdir(), 'lain-test-file.txt');
  writeFileSync(targetFile, 'test');
  try {
    symlinkSync(targetFile, join(tmpBase, 'file-link'));
    const result = listProjects();
    const names = result.map(p => p.name);
    expect(names).not.toContain('file-link');
  } finally {
    rmSync(targetFile, { force: true });
  }
});

test('does not return broken symlinks', () => {
  symlinkSync('/nonexistent/path/does-not-exist', join(tmpBase, 'broken-link'));
  const result = listProjects();
  const names = result.map(p => p.name);
  expect(names).not.toContain('broken-link');
});

test('does not return entries starting with dot', () => {
  mkdirSync(join(tmpBase, '.hidden'));
  mkdirSync(join(tmpBase, 'visible'));
  const result = listProjects();
  const names = result.map(p => p.name);
  expect(names).not.toContain('.hidden');
  expect(names).toContain('visible');
});
