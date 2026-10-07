import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runReaperDoctor, formatReaperDoctorReport } from '../memory-reaper-doctor.js';
import type { ReaperDoctorCheck } from '../memory-reaper-doctor.js';

const ENV_KEYS = [
  'LAIN_MEMORY_REAPER_ENABLED',
  'LAIN_MEMORY_REAPER_DRY_RUN',
  'LAIN_MEMORY_REAPER_FETCH_LIMIT',
  'LAIN_PROJECTS_BASE',
  'LAIN_REAPER_AUDIT_PATH',
] as const;

const savedEnv: Partial<Record<typeof ENV_KEYS[number], string>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) savedEnv[k] = v;
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
    delete savedEnv[k];
  }
});

const daysAgoIso = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

function find(results: ReaperDoctorCheck[], name: string): ReaperDoctorCheck {
  const r = results.find(c => c.name === name);
  if (!r) throw new Error(`check '${name}' not found in results`);
  return r;
}

// ── 1. enabled ────────────────────────────────────────────────────────────────

describe('enabled check', () => {
  it('env unset → ok', async () => {
    const results = await runReaperDoctor();
    expect(find(results, 'enabled').status).toBe('ok');
  });

  it('env=false → warn', async () => {
    process.env.LAIN_MEMORY_REAPER_ENABLED = 'false';
    const results = await runReaperDoctor();
    expect(find(results, 'enabled').status).toBe('warn');
  });
});

// ── 2. mode ───────────────────────────────────────────────────────────────────

describe('mode check', () => {
  it('env unset → info detail contains live', async () => {
    const results = await runReaperDoctor();
    const c = find(results, 'mode');
    expect(c.status).toBe('info');
    expect(c.detail).toContain('live');
  });

  it('LAIN_MEMORY_REAPER_DRY_RUN=true → info detail contains dry-run', async () => {
    process.env.LAIN_MEMORY_REAPER_DRY_RUN = 'true';
    const results = await runReaperDoctor();
    const c = find(results, 'mode');
    expect(c.status).toBe('info');
    expect(c.detail).toContain('dry-run');
  });
});

// ── 3. fetch-limit ────────────────────────────────────────────────────────────

describe('fetch-limit check', () => {
  it('env unset → info detail mentions 200', async () => {
    const results = await runReaperDoctor();
    const c = find(results, 'fetch-limit');
    expect(c.status).toBe('info');
    expect(c.detail).toContain('200');
  });

  it('env=500 → info detail mentions 500', async () => {
    process.env.LAIN_MEMORY_REAPER_FETCH_LIMIT = '500';
    const results = await runReaperDoctor();
    const c = find(results, 'fetch-limit');
    expect(c.status).toBe('info');
    expect(c.detail).toContain('500');
  });
});

// ── 4. projects-base ──────────────────────────────────────────────────────────

describe('projects-base check', () => {
  it('nonexistent path → fail', async () => {
    process.env.LAIN_PROJECTS_BASE = '/nonexistent/path/xyz-dr-test-99999';
    const results = await runReaperDoctor();
    expect(find(results, 'projects-base').status).toBe('fail');
  });

  it('empty string → warn detail mentions empty string', async () => {
    process.env.LAIN_PROJECTS_BASE = '';
    const results = await runReaperDoctor();
    const c = find(results, 'projects-base');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('empty string');
  });

  it('existing dir → ok detail contains path', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dr-base-'));
    try {
      process.env.LAIN_PROJECTS_BASE = tmp;
      const results = await runReaperDoctor();
      const c = find(results, 'projects-base');
      expect(c.status).toBe('ok');
      expect(c.detail).toContain(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 5. projects-found ─────────────────────────────────────────────────────────

describe('projects-found check', () => {
  it('empty dir → warn', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dr-proj-'));
    try {
      process.env.LAIN_PROJECTS_BASE = tmp;
      const results = await runReaperDoctor();
      expect(find(results, 'projects-found').status).toBe('warn');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('2 subdirs → ok detail mentions both', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dr-proj-'));
    try {
      mkdirSync(join(tmp, 'project-alpha'));
      mkdirSync(join(tmp, 'project-beta'));
      process.env.LAIN_PROJECTS_BASE = tmp;
      const results = await runReaperDoctor();
      const c = find(results, 'projects-found');
      expect(c.status).toBe('ok');
      expect(c.detail).toContain('project-alpha');
      expect(c.detail).toContain('project-beta');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 6. audit-log-path ─────────────────────────────────────────────────────────

describe('audit-log-path check', () => {
  it('nonexistent path → info detail mentions exists:no', async () => {
    process.env.LAIN_REAPER_AUDIT_PATH = '/tmp/no-such-reaper-log-xyzabc.jsonl';
    const results = await runReaperDoctor();
    const c = find(results, 'audit-log-path');
    expect(c.status).toBe('info');
    expect(c.detail).toContain('exists: no');
  });
});

// ── 7. audit-log-size ─────────────────────────────────────────────────────────

describe('audit-log-size check', () => {
  it('small file → info shows bytes', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dr-audit-'));
    const path = join(tmp, 'test.jsonl');
    try {
      writeFileSync(path, 'hello world\n');
      process.env.LAIN_REAPER_AUDIT_PATH = path;
      const results = await runReaperDoctor();
      const c = find(results, 'audit-log-size');
      expect(c.status).toBe('info');
      expect(c.detail).toMatch(/\d+(\.\d+)?\s*(B|KB|MB|GB)/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 8. last-sweep ─────────────────────────────────────────────────────────────

describe('last-sweep check', () => {
  it('missing file → info detail mentions no sweeps', async () => {
    process.env.LAIN_REAPER_AUDIT_PATH = '/tmp/no-sweep-log-xyzabc.jsonl';
    const results = await runReaperDoctor();
    const c = find(results, 'last-sweep');
    expect(c.status).toBe('info');
    expect(c.detail).toContain('no sweeps');
  });

  it('complete event 1 day ago → info detail mentions days ago', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dr-sweep-'));
    const path = join(tmp, 'sweep.jsonl');
    try {
      const event = {
        schema_version: 1, run_id: 'r1', ts: daysAgoIso(1),
        event_type: 'complete', purged: 3, dry_purged: 0, dry_run: false, duration_ms: 1234,
      };
      writeFileSync(path, JSON.stringify(event) + '\n');
      process.env.LAIN_REAPER_AUDIT_PATH = path;
      const results = await runReaperDoctor();
      const c = find(results, 'last-sweep');
      expect(c.status).toBe('info');
      expect(c.detail).toContain('days ago');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('complete event 30 days ago → warn detail prefixed STALE', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dr-sweep-'));
    const path = join(tmp, 'sweep.jsonl');
    try {
      const event = {
        schema_version: 1, run_id: 'r2', ts: daysAgoIso(30),
        event_type: 'complete', purged: 5, dry_purged: 0, dry_run: false, duration_ms: 2000,
      };
      writeFileSync(path, JSON.stringify(event) + '\n');
      process.env.LAIN_REAPER_AUDIT_PATH = path;
      const results = await runReaperDoctor();
      const c = find(results, 'last-sweep');
      expect(c.status).toBe('warn');
      expect(c.detail).toMatch(/^STALE:/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('malformed line before valid complete event → info detail mentions corrupted', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dr-sweep-'));
    const path = join(tmp, 'sweep.jsonl');
    try {
      const event = {
        schema_version: 1, run_id: 'r3', ts: daysAgoIso(1),
        event_type: 'complete', purged: 2, dry_purged: 0, dry_run: false, duration_ms: 500,
      };
      writeFileSync(path, 'not-valid-json\n' + JSON.stringify(event) + '\n');
      process.env.LAIN_REAPER_AUDIT_PATH = path;
      const results = await runReaperDoctor();
      const c = find(results, 'last-sweep');
      expect(c.status).toBe('info');
      expect(c.detail).toContain('corrupted');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 18. SMOKE ─────────────────────────────────────────────────────────────────

it('smoke: runReaperDoctor returns exactly 8 checks with correct names in order', async () => {
  // provide a real path so projects-base doesn't fail noisily
  const tmp = mkdtempSync(join(tmpdir(), 'dr-smoke-'));
  try {
    process.env.LAIN_PROJECTS_BASE = tmp;
    const results = await runReaperDoctor();
    expect(results).toHaveLength(8);
    expect(results.map(r => r.name)).toEqual([
      'enabled',
      'mode',
      'fetch-limit',
      'projects-base',
      'projects-found',
      'audit-log-path',
      'audit-log-size',
      'last-sweep',
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 19. format ────────────────────────────────────────────────────────────────

it('format: mixed statuses produce report with all 4 icons and correct summary', () => {
  const results: ReaperDoctorCheck[] = [
    { name: 'a', status: 'ok' },
    { name: 'b', status: 'warn', detail: 'something' },
    { name: 'c', status: 'fail', detail: 'bad thing' },
    { name: 'd', status: 'info', detail: 'details' },
  ];
  const report = formatReaperDoctorReport(results);
  expect(report).toContain('✓');
  expect(report).toContain('⚠');
  expect(report).toContain('✗');
  expect(report).toContain('ℹ');
  expect(report).toContain('4 checks — 1 ok  1 warn  1 fail  1 info');
});
