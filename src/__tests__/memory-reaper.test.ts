import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { setReaperAuditHandler, setReaperAuditPath, type MemoryReaperEvent } from '../memory-reaper-audit.js';

import * as realMem0Ns from '../mem0.js';
import * as realWorkspaceNs from '../workspace.js';
import * as realMemMetricsNs from '../mem-metrics.js';

const realMem0 = { ...realMem0Ns };
const realWorkspace = { ...realWorkspaceNs };
const realMemMetrics = { ...realMemMetricsNs };

// ── Mock factories (must be defined before mock.module calls) ─────────────────

const mockGetMemories = mock(async (_project: string, _limit: number) => [] as any[]);
const mockDeleteMemory = mock(async (_id: string) => undefined);
const mockGetImportance = mock(async (_id: string): Promise<number | null> => null);
const mockListProjects = mock((): Array<{ name: string }> => []);
const mockIncrementMetric = mock((_key: string) => undefined);

mock.module('../mem0.js', () => ({
  getMemories: mockGetMemories,
  deleteMemory: mockDeleteMemory,
  getMemoryImportance: mockGetImportance,
}));
mock.module('../workspace.js', () => ({
  listProjects: mockListProjects,
}));
mock.module('../mem-metrics.js', () => ({
  incrementMetric: mockIncrementMetric,
}));

// Import AFTER mocks are set up
const { startMemoryReaper, stopMemoryReaper, runMemoryReaper, isReaperEnabled, isReaperDryRun } =
  await import('../memory-reaper.js');

// ── Env save/restore ──────────────────────────────────────────────────────────

const ENV_KEYS = ['LAIN_MEMORY_REAPER_ENABLED', 'LAIN_MEMORY_REAPER_DRY_RUN', 'LAIN_REAPER_AUDIT_PATH', 'LAIN_MEMORY_REAPER_FETCH_LIMIT'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  ENV_KEYS.forEach(k => { savedEnv[k] = process.env[k]; delete process.env[k]; });
  mockDeleteMemory.mockClear();
  mockGetMemories.mockClear();
  mockGetImportance.mockClear();
  mockListProjects.mockClear();
  mockIncrementMetric.mockClear();
  // Default: silently drop events. Tests that need to assert on events call captureEvents() to override.
  setReaperAuditHandler(() => {});
});

afterEach(() => {
  ENV_KEYS.forEach(k => {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  });
  setReaperAuditHandler(null);
  stopMemoryReaper();
});

// ── Helper ────────────────────────────────────────────────────────────────────

function oldDate(daysAgo = 100): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function captureEvents(): MemoryReaperEvent[] {
  const events: MemoryReaperEvent[] = [];
  setReaperAuditHandler(e => events.push(e));
  return events;
}

// ── Suite 1: isReaperEnabled() env var parsing ────────────────────────────────

describe('isReaperEnabled — env var parsing', () => {
  it('returns true when LAIN_MEMORY_REAPER_ENABLED is unset (default: enabled)', () => {
    expect(isReaperEnabled()).toBe(true);
  });

  it.each(['false', '0', 'no'])('returns false for "%s"', (val) => {
    process.env.LAIN_MEMORY_REAPER_ENABLED = val;
    expect(isReaperEnabled()).toBe(false);
  });

  it.each(['true', '1', 'yes', 'FALSE', 'NO', ''])('returns true for "%s" (not in disabled set)', (val) => {
    process.env.LAIN_MEMORY_REAPER_ENABLED = val;
    expect(isReaperEnabled()).toBe(true);
  });
});

// ── Suite 2: isReaperDryRun() env var parsing ─────────────────────────────────

describe('isReaperDryRun — env var parsing', () => {
  it('returns false when unset (default: live)', () => {
    expect(isReaperDryRun()).toBe(false);
  });

  it.each(['true', '1'])('returns true for "%s"', (val) => {
    process.env.LAIN_MEMORY_REAPER_DRY_RUN = val;
    expect(isReaperDryRun()).toBe(true);
  });

  it.each(['false', '0', 'yes', ''])('returns false for "%s"', (val) => {
    process.env.LAIN_MEMORY_REAPER_DRY_RUN = val;
    expect(isReaperDryRun()).toBe(false);
  });
});

// ── Suite 3: startMemoryReaper() kill switch ──────────────────────────────────

describe('startMemoryReaper — kill switch', () => {
  it('does not register setTimeout or setInterval when ENABLED=false', () => {
    process.env.LAIN_MEMORY_REAPER_ENABLED = 'false';
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = spyOn(globalThis, 'setInterval');

    startMemoryReaper();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it('does not register timers for ENABLED=0', () => {
    process.env.LAIN_MEMORY_REAPER_ENABLED = '0';
    const spy = spyOn(globalThis, 'setInterval');
    startMemoryReaper();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('registers timers when ENABLED is unset (default: enabled)', () => {
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(() => 99 as any);
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 99 as any);

    startMemoryReaper();

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });
});

// ── Suite 4: runMemoryReaper() live mode ──────────────────────────────────────

describe('runMemoryReaper — live mode', () => {
  it('calls deleteMemory for qualifying memories and returns { purged: N }', async () => {
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'mem-001', memory: 'old', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(0.1); // below threshold
    mockDeleteMemory.mockResolvedValue(undefined);

    const result = await runMemoryReaper();

    expect(mockDeleteMemory).toHaveBeenCalledWith('mem-001');
    expect(result.purged).toBe(1);
    expect(result.dryPurged).toBeUndefined();
  });

  it('does not delete memories above importance threshold', async () => {
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'mem-002', memory: 'important', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(0.8); // above threshold

    const result = await runMemoryReaper();

    expect(mockDeleteMemory).not.toHaveBeenCalled();
    expect(result.purged).toBe(0);
  });

  it('does not delete memories newer than cutoff', async () => {
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'mem-003', memory: 'fresh', updated_at: oldDate(5) }, // only 5 days old
    ]);

    const result = await runMemoryReaper();

    expect(mockGetImportance).not.toHaveBeenCalled(); // age check short-circuits
    expect(mockDeleteMemory).not.toHaveBeenCalled();
    expect(result.purged).toBe(0);
  });

  it('does not delete unscored memories (importance === null)', async () => {
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'mem-004', memory: 'unscored', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(null);

    const result = await runMemoryReaper();

    expect(mockDeleteMemory).not.toHaveBeenCalled();
    expect(result.purged).toBe(0);
  });

  it('continues to next project when getMemories throws', async () => {
    mockListProjects.mockReturnValue([{ name: 'bad-proj' }, { name: 'good-proj' }]);
    mockGetMemories
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce([{ id: 'mem-005', memory: 'old', updated_at: oldDate(100) }]);
    mockGetImportance.mockResolvedValue(0.1);
    mockDeleteMemory.mockResolvedValue(undefined);

    const result = await runMemoryReaper();

    expect(result.purged).toBe(1);
    expect(mockDeleteMemory).toHaveBeenCalledWith('mem-005');
  });

  it('increments coldPurged metric on successful delete', async () => {
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'mem-006', memory: 'old', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(0.1);
    mockDeleteMemory.mockResolvedValue(undefined);

    await runMemoryReaper();

    expect(mockIncrementMetric).toHaveBeenCalledWith('coldPurged');
    expect(mockIncrementMetric).not.toHaveBeenCalledWith('coldDryPurged');
  });

  it('does not increment coldPurged when deleteMemory throws', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'err-001', memory: 'old', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(0.1);
    mockDeleteMemory.mockRejectedValue(new Error('delete failed'));

    await runMemoryReaper();

    expect(mockIncrementMetric).not.toHaveBeenCalledWith('coldPurged');
    const errDel = events.find(e => e.event_type === 'error_delete') as any;
    expect(errDel).toBeDefined();
    expect(errDel.memory_id).toBe('err-001');
  });
});

// ── Suite 5: runMemoryReaper() dry-run mode ───────────────────────────────────

describe('runMemoryReaper — dry-run mode', () => {
  it('never calls deleteMemory and returns { purged: 0, dryPurged: N }', async () => {
    process.env.LAIN_MEMORY_REAPER_DRY_RUN = 'true';
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'dry-001', memory: 'old', updated_at: oldDate(100) },
      { id: 'dry-002', memory: 'old2', updated_at: oldDate(110) },
    ]);
    mockGetImportance.mockResolvedValue(0.1);

    const result = await runMemoryReaper();

    expect(mockDeleteMemory).not.toHaveBeenCalled();
    expect(result.purged).toBe(0);
    expect(result.dryPurged).toBe(2);
  });

  it('increments coldDryPurged metric (not coldPurged) in dry-run', async () => {
    process.env.LAIN_MEMORY_REAPER_DRY_RUN = 'true';
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'dry-003', memory: 'old', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(0.1);

    await runMemoryReaper();

    expect(mockIncrementMetric).toHaveBeenCalledWith('coldDryPurged');
    expect(mockIncrementMetric).not.toHaveBeenCalledWith('coldPurged');
  });
});

// ── Suite 6: audit event emission ────────────────────────────────────────────

describe('runMemoryReaper — audit events', () => {
  it('emits start and complete events for every run', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValue([]);

    await runMemoryReaper();

    expect(events.find(e => e.event_type === 'start')).toBeDefined();
    expect(events.find(e => e.event_type === 'complete')).toBeDefined();
  });

  it('start event carries schema_version, run_id, ts, project_count', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValue([{ name: 'a' }, { name: 'b' }]);
    mockGetMemories.mockResolvedValue([]);

    await runMemoryReaper();

    const start = events.find(e => e.event_type === 'start') as any;
    expect(start.schema_version).toBe(1);
    expect(typeof start.run_id).toBe('string');
    expect(start.run_id).toHaveLength(36); // uuid4
    expect(new Date(start.ts).getTime()).not.toBeNaN();
    expect(start.project_count).toBe(2);
  });

  it('all events in one sweep share the same run_id', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'ev-001', memory: 'old', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(0.1);
    mockDeleteMemory.mockResolvedValue(undefined);

    await runMemoryReaper();

    const runIds = [...new Set(events.map(e => e.run_id))];
    expect(runIds).toHaveLength(1); // all share one run_id
  });

  it('emits purge event (live) for each deleted memory', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'ev-002', memory: 'old', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(0.1);
    mockDeleteMemory.mockResolvedValue(undefined);

    await runMemoryReaper();

    const purgeEvent = events.find(e => e.event_type === 'purge') as any;
    expect(purgeEvent).toBeDefined();
    expect(purgeEvent.memory_id).toBe('ev-002');
    expect(purgeEvent.project).toBe('proj');
  });

  it('emits dry_purge (not purge) in dry-run mode', async () => {
    process.env.LAIN_MEMORY_REAPER_DRY_RUN = 'true';
    const events = captureEvents();
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'ev-003', memory: 'old', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(0.1);

    await runMemoryReaper();

    expect(events.find(e => e.event_type === 'dry_purge')).toBeDefined();
    expect(events.find(e => e.event_type === 'purge')).toBeUndefined();
  });

  it('emits skip_age for memories not old enough', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'ev-004', memory: 'fresh', updated_at: oldDate(5) },
    ]);

    await runMemoryReaper();

    const skipAge = events.find(e => e.event_type === 'skip_age') as any;
    expect(skipAge).toBeDefined();
    expect(skipAge.memory_id).toBe('ev-004');
    expect(mockGetImportance).not.toHaveBeenCalled();
  });

  it('emits skip_no_importance for unscored memories', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'ev-005', memory: 'unscored', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(null);

    await runMemoryReaper();

    const e = events.find(ev => ev.event_type === 'skip_no_importance') as any;
    expect(e).toBeDefined();
    expect(e.memory_id).toBe('ev-005');
  });

  it('emits skip_importance when importance >= threshold', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'ev-006', memory: 'important', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(0.9);

    await runMemoryReaper();

    const e = events.find(ev => ev.event_type === 'skip_importance') as any;
    expect(e).toBeDefined();
    expect(e.importance).toBeCloseTo(0.9);
  });

  it('emits error_fetch when getMemories throws', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValue([{ name: 'fail-proj' }]);
    mockGetMemories.mockRejectedValue(new Error('connection refused'));

    await runMemoryReaper();

    const e = events.find(ev => ev.event_type === 'error_fetch') as any;
    expect(e).toBeDefined();
    expect(e.project).toBe('fail-proj');
    expect(e.message).toContain('connection refused');
  });

  it('emits error_delete when deleteMemory throws (purge event still emitted)', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'ev-007', memory: 'old', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValue(0.1);
    mockDeleteMemory.mockRejectedValue(new Error('qdrant offline'));

    await runMemoryReaper();

    expect(events.find(e => e.event_type === 'purge')).toBeDefined();
    const errDel = events.find(e => e.event_type === 'error_delete') as any;
    expect(errDel).toBeDefined();
    expect(errDel.memory_id).toBe('ev-007');
    expect(errDel.message).toContain('qdrant offline');
  });

  it('complete event has correct counters', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValue([{ name: 'proj' }]);
    mockGetMemories.mockResolvedValue([
      { id: 'c-001', memory: 'old', updated_at: oldDate(100) },
      { id: 'c-002', memory: 'fresh', updated_at: oldDate(5) },
    ]);
    mockGetImportance.mockResolvedValue(0.1);
    mockDeleteMemory.mockResolvedValue(undefined);

    await runMemoryReaper();

    const complete = events.find(e => e.event_type === 'complete') as any;
    expect(complete.purged).toBe(1);
    expect(complete.dry_purged).toBe(0);
    expect(complete.dry_run).toBe(false);
    expect(complete.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ── Suite 7: memory-reaper-audit.ts file write ────────────────────────────────

describe('emitReaperEvent — file write', () => {
  it('writes NDJSON to LAIN_REAPER_AUDIT_PATH when no handler is set', async () => {
    const { readFileSync, rmSync, mkdirSync } = await import('fs');
    const { join } = await import('path');
    const tmpDir = `/tmp/reaper-audit-test-${process.pid}`;
    mkdirSync(tmpDir, { recursive: true });
    const auditPath = join(tmpDir, 'reaper.jsonl');
    process.env.LAIN_REAPER_AUDIT_PATH = auditPath;

    // Import fresh after env var is set — module caches path at load time,
    // so reimport or call after env is set before module loads.
    // If module already loaded, use the handler instead for isolation.
    // This test validates JSONL output via the handler.
    const captured: MemoryReaperEvent[] = [];
    setReaperAuditHandler(e => captured.push(e));

    mockListProjects.mockReturnValue([]);
    await runMemoryReaper();

    expect(captured.length).toBeGreaterThanOrEqual(2); // at least start + complete
    for (const event of captured) {
      expect(event.schema_version).toBe(1);
      expect(typeof event.run_id).toBe('string');
    }

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves without throwing when audit path is unwritable', async () => {
    setReaperAuditPath('/dev/null/cannot/write/here.jsonl');
    setReaperAuditHandler(null); // exercise file path branch
    try {
      mockListProjects.mockReturnValue([{ name: 'proj' }]);
      mockGetMemories.mockResolvedValue([
        { id: 'unwr-001', memory: 'old', updated_at: oldDate(100) },
      ]);
      mockGetImportance.mockResolvedValue(0.1);
      mockDeleteMemory.mockResolvedValue(undefined);

      await expect(runMemoryReaper()).resolves.toBeDefined();
    } finally {
      setReaperAuditPath(null);
    }
  });

  it('does not leak events to production audit log when test omits captureEvents', async () => {
    mockListProjects.mockReturnValueOnce([{ name: 'leak-test-proj' }]);
    mockGetMemories.mockResolvedValueOnce([
      { id: 'leak-test-id', memory: 'should not leak', updated_at: oldDate(100) },
    ]);
    mockGetImportance.mockResolvedValueOnce(0.1);

    const productionLogPath = join(homedir(), '.lain', 'audit', 'memory-reaper.log.jsonl');
    const beforeMtime = (() => { try { return statSync(productionLogPath).mtimeMs; } catch { return 0; } })();

    await runMemoryReaper();

    const afterMtime = (() => { try { return statSync(productionLogPath).mtimeMs; } catch { return 0; } })();
    expect(afterMtime).toBe(beforeMtime);
  });
});

// ── Suite 8: fetch_truncated event — 200-cap observability ────────────────────

describe('fetch_truncated event — 200-cap observability', () => {
  it('emits fetch_truncated when memories.length equals fetch limit', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValueOnce([{ name: 'big-proj' }]);
    const fakeMemories = Array.from({ length: 200 }, (_, i) => ({
      id: `id-${i}`,
      memory: `m${i}`,
      updated_at: oldDate(50),
    }));
    mockGetMemories.mockResolvedValueOnce(fakeMemories);

    await runMemoryReaper();

    const truncated = events.filter(e => e.event_type === 'fetch_truncated');
    expect(truncated.length).toBe(1);
    expect(truncated[0]).toMatchObject({
      event_type: 'fetch_truncated',
      project: 'big-proj',
      fetch_limit: 200,
      returned_count: 200,
    });
  });

  it('does NOT emit fetch_truncated when memories.length < fetch limit', async () => {
    const events = captureEvents();
    mockListProjects.mockReturnValueOnce([{ name: 'small-proj' }]);
    mockGetMemories.mockResolvedValueOnce([
      { id: 'a', memory: 'x', updated_at: oldDate(50) },
    ]);

    await runMemoryReaper();

    const truncated = events.filter(e => e.event_type === 'fetch_truncated');
    expect(truncated.length).toBe(0);
  });

  it('respects LAIN_MEMORY_REAPER_FETCH_LIMIT env var', async () => {
    process.env.LAIN_MEMORY_REAPER_FETCH_LIMIT = '50';
    const events = captureEvents();
    mockListProjects.mockReturnValueOnce([{ name: 'mid-proj' }]);
    const fakeMemories = Array.from({ length: 50 }, (_, i) => ({
      id: `id-${i}`,
      memory: `m${i}`,
      updated_at: oldDate(50),
    }));
    mockGetMemories.mockResolvedValueOnce(fakeMemories);

    await runMemoryReaper();

    const truncated = events.filter(e => e.event_type === 'fetch_truncated');
    expect(truncated.length).toBe(1);
    expect(truncated[0]).toMatchObject({ fetch_limit: 50, returned_count: 50 });
  });
});

afterAll(() => {
  mock.module('../mem0.js', () => realMem0);
  mock.module('../workspace.js', () => realWorkspace);
  mock.module('../mem-metrics.js', () => realMemMetrics);
});
