import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { PGSSessionManager } from './session.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('PGS Session Manager', () => {
  let dir: string;
  let mgr: PGSSessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pgs-session-test-'));
    mgr = new PGSSessionManager(dir);
  });

  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  test('load returns null for nonexistent session', async () => {
    expect(await mgr.load('nonexistent')).toBeNull();
  });

  test('save and load roundtrip', async () => {
    await mgr.save('test-session', {
      query: 'test query', mode: 'full',
      searchedPartitionIds: [0, 1, 2], totalPartitions: 5,
      timestamp: new Date().toISOString(),
    });
    const loaded = await mgr.load('test-session');
    expect(loaded).not.toBeNull();
    expect(loaded!.query).toBe('test query');
    expect(loaded!.searchedPartitionIds).toEqual([0, 1, 2]);
  });

  test('getCoverage returns correct percentage', async () => {
    await mgr.save('cov-session', {
      query: 'q', mode: 'full',
      searchedPartitionIds: [0, 1], totalPartitions: 4,
      timestamp: new Date().toISOString(),
    });
    const loaded = await mgr.load('cov-session');
    expect(loaded!.searchedPartitionIds.length / loaded!.totalPartitions).toBe(0.5);
  });
});
