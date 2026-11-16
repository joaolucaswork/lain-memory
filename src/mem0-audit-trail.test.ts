import { describe, it, expect, mock, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';

import * as realMem0aiOssNs from 'mem0ai/oss';
const realMem0aiOss = { ...realMem0aiOssNs };

import * as realMaintenanceNs from './maintenance-log.js';
const realMaintenance = { ...realMaintenanceNs };

// Must mock mem0ai/oss (it loads sqlite3 native binary) before importing mem0.ts
const calls: { getAll: unknown[]; add: unknown[]; delete: string[] } = { getAll: [], add: [], delete: [] };
let cannedGetAll: { results: unknown[] } = { results: [] };
// Controllable per-test doubles for trash/restore state tests (issue #10).
// Defaults reproduce the original mock exactly (fixed trash id, no trash scope).
let cannedAddId = 'trash-id-1';
let cannedTrashList: unknown[] | null = null;
// Fase 4 failure injection (default off — existing tests unaffected)
let failAdd = false;
const failDeleteFor = new Set<string>();
const maintenanceCalls: unknown[][] = [];

mock.module('mem0ai/oss', () => ({
  Memory: class MockMemory {
    constructor(..._args: unknown[]) {}
    async getAll(params: unknown) {
      calls.getAll.push(params);
      if (cannedTrashList !== null && (params as any)?.filters?.user_id === 'lucas:trash') {
        return { results: cannedTrashList };
      }
      return cannedGetAll;
    }
    async add(messages: unknown, config: unknown) {
      if (failAdd) throw new Error('add failed');
      calls.add.push({ messages, config });
      return { results: [{ id: cannedAddId, memory: 'copied' }] };
    }
    async delete(id: string) {
      if (failDeleteFor.has(id)) throw new Error('delete failed');
      calls.delete.push(id);
      return { message: 'deleted' };
    }
  },
  OpenAILLM: class MockOpenAILLM {},
  OpenAIEmbedder: class MockOpenAIEmbedder {},
}));

// Redirect the audit sink to a recorder — never touches prod maintenance logs.
mock.module('./maintenance-log.js', () => ({
  ...realMaintenance,
  logMaintenance: (...args: unknown[]) => { maintenanceCalls.push(args); },
}));

// Dynamic import AFTER mocks are set up
const mem0 = await import('./mem0.js');

describe('delete audit trail (snapshot-before-delete + trash)', () => {
  const savedKey = process.env.LAIN_OPENAI_API_KEY;

  beforeEach(() => {
    process.env.LAIN_OPENAI_API_KEY = 'sk-test-audit';
    calls.getAll.length = 0;
    calls.add.length = 0;
    calls.delete.length = 0;
    maintenanceCalls.length = 0;
    failAdd = false;
    failDeleteFor.clear();
    cannedAddId = 'trash-id-1';
    cannedTrashList = null;
    cannedGetAll = {
      results: [
        { id: 'aaa', memory: 'Full text of memory A with details worth keeping verbatim.', created_at: '2026-10-01T00:00:00.000Z' },
        { id: 'bbb', memory: 'Full text of memory B.', created_at: '2026-10-02T00:00:00.000Z' },
      ],
    };
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.LAIN_OPENAI_API_KEY = savedKey;
    else delete process.env.LAIN_OPENAI_API_KEY;
  });

  it('TRASH_PROJECT is trash', () => {
    expect((mem0 as any).TRASH_PROJECT).toBe('trash');
  });

  it('snapshotMemories returns full texts and flags unknown ids', async () => {
    const snaps = await (mem0 as any).snapshotMemories(['aaa', 'zzz'], undefined);
    expect(snaps).toHaveLength(2);
    expect(snaps[0]).toEqual({ id: 'aaa', memory: 'Full text of memory A with details worth keeping verbatim.', created_at: '2026-10-01T00:00:00.000Z' });
    expect(snaps[1]).toEqual({ id: 'zzz', memory: '', missing: true });
  });

  it('trashAndDelete copies full text to trash with provenance, then deletes original', async () => {
    const { trashAndDelete, snapshotMemories } = mem0 as any;
    const [snap] = await snapshotMemories(['aaa'], undefined);
    const addSpy = calls.add;
    const delSpy = calls.delete;
    const result = await trashAndDelete(snap, undefined, {
      reason: 'test supersede',
      trigger: 'conflict_check:UPDATE',
      replacedById: 'new-id',
    });
    expect(result).toEqual({ trashId: 'trash-id-1', deleted: true });
    // Trash copy went to lucas:trash with provenance metadata
    expect(addSpy).toHaveLength(1);
    const cfg = (addSpy[0] as any).config;
    expect(cfg.userId).toBe('lucas:trash');
    expect(cfg.metadata.original_id).toBe('aaa');
    expect(cfg.metadata.deleted_from).toBe('global');
    expect(cfg.metadata.reason).toBe('test supersede');
    expect(cfg.metadata.replaced_by).toBe('new-id');
    expect(typeof cfg.metadata.trashed_at).toBe('string');
    const msgs = (addSpy[0] as any).messages;
    expect(msgs[0].content).toBe('Full text of memory A with details worth keeping verbatim.');
    // Original deleted
    expect(delSpy).toEqual(['aaa']);
  });

  it('trashAndDelete preserves the original when the snapshot is missing', async () => {
    const { trashAndDelete } = mem0 as any;
    const result = await trashAndDelete({ id: 'gone', memory: '', missing: true }, 'proj', {
      reason: 'r',
      trigger: 't',
    });
    expect(result).toEqual({ trashId: null, deleted: false });
    expect(calls.add).toHaveLength(0); // nothing to copy
    expect(calls.delete).toEqual([]); // ...and nothing deleted
  });

  describe('deleteMemoriesWithPolicy (Fase 4 wiring)', () => {
  it('archives via trash with provenance + audit, then hard-deletes', async () => {
    const { deleteMemoriesWithPolicy } = mem0 as any;
    const report = await deleteMemoriesWithPolicy({
      ids: ['aaa'],
      project: undefined,
      reason: 'test hygiene',
      trigger: 'test-run',
    });
    expect(report.archived).toEqual(['aaa']);
    expect(report.failed).toEqual([]);
    expect(report.trashIds).toEqual({ aaa: 'trash-id-1' });
    // Trash copy carried provenance
    const cfg = (calls.add[0] as any).config;
    expect(cfg.userId).toBe('lucas:trash');
    expect(cfg.metadata.trigger).toBe('test-run');
    // Original hard-deleted (which also prunes graph provenance — best-effort)
    expect(calls.delete).toEqual(['aaa']);
    // Audit recorded
    expect(maintenanceCalls.length).toBeGreaterThan(0);
    const auditAction = (maintenanceCalls[0] as any[])[0];
    expect(auditAction).toBe('memory_policy_delete');
  });

  it('refuses the trash scope itself', async () => {
    const { deleteMemoriesWithPolicy } = mem0 as any;
    const report = await deleteMemoriesWithPolicy({
      ids: ['x'],
      project: 'trash',
      reason: 'r',
      trigger: 't',
    });
    expect(report.archived).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(calls.add).toHaveLength(0);
    expect(calls.delete).toHaveLength(0);
  });

  it('trash copy failure preserves the original and reports failed', async () => {
    failAdd = true;
    const { deleteMemoriesWithPolicy } = mem0 as any;
    const report = await deleteMemoriesWithPolicy({
      ids: ['aaa'],
      project: undefined,
      reason: 'r',
      trigger: 't',
    });
    expect(report.archived).toEqual([]);
    expect(report.trashIds).toEqual({});
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].id).toBe('aaa');
    expect(calls.delete).toEqual([]); // original preserved for retry
    // Audit trail is visible to the caller (no silent audit loss)
    expect(report.audit).toHaveLength(1);
    expect(report.audit[0]).toMatchObject({ result: 'trash-failed', trashId: null });
    expect(report.auditFailed).toEqual([]);
  });

  it('hard delete failure lands in failed, no silent success', async () => {
    failDeleteFor.add('aaa');
    const { deleteMemoriesWithPolicy } = mem0 as any;
    const report = await deleteMemoriesWithPolicy({
      ids: ['aaa'],
      project: undefined,
      reason: 'r',
      trigger: 't',
    });
    expect(report.archived).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].id).toBe('aaa');
    expect(report.failed[0].error).toContain('delete failed');
  });
});

describe('trash state snapshot + restore (issue #10)', () => {
  // Real Qdrant points (no LLM — direct upsert via test-points helper).
  // Mocked Memory above handles the mem0 calls; memory-state hits Qdrant.
  let dir: string;
  const statePointIds: string[] = [];

  beforeAll(async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    dir = mkdtempSync(join(tmpdir(), 'trash-state-test-'));
    (mem0 as any).__setBlocklistPathForTests(join(dir, 'forget-blocklist.json'));
    const { newTestPoint, deleteTestPoints } = await import('./test-points.js');
    const probe = await newTestPoint('trash-state-probe');
    await deleteTestPoints([probe]);
  });

  afterAll(async () => {
    (mem0 as any).__setBlocklistPathForTests(null);
    const { rmSync } = await import('node:fs');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    const { deleteTestPoints } = await import('./test-points.js');
    await deleteTestPoints(statePointIds).catch(() => {});
  });

  it('trashAndDelete stashes state in the trash copy and cleans the original', async () => {
    const { trashAndDelete, setMemoryFeedback, setMemoryImportance, getMemoryFeedback, getMemoryImportance } = mem0 as any;
    const { newTestPoint } = await import('./test-points.js');
    const { STATE_SNAPSHOT_KEY, FEEDBACK_DEFAULTS } = await import('./memory-state.js');
    const originalId = await newTestPoint('trash-orig');
    statePointIds.push(originalId);
    calls.add.length = 0;
    calls.delete.length = 0;

    const voted = await setMemoryFeedback(originalId, {
      confidence: 1.0, correct_count: 2, title: 'titulo x', kind: 'state',
    });
    await setMemoryImportance(originalId, 0.9);

    const result = await trashAndDelete(
      { id: originalId, memory: 'texto original neutro para o trash' },
      undefined,
      { reason: 'test forget', trigger: 'test' },
    );
    expect(result).toEqual({ trashId: 'trash-id-1', deleted: true });

    // Trash copy carried the full state snapshot in its metadata.
    expect(calls.add).toHaveLength(1);
    expect((calls.add[0] as any).config.metadata.original_id).toBe(originalId);
    expect((calls.add[0] as any).config.metadata[STATE_SNAPSHOT_KEY]).toEqual({
      feedback: voted,
      importance: 0.9,
    });

    // Original point deleted (mock) and its state cleaned (real Qdrant+L2).
    expect(calls.delete).toEqual([originalId]);
    expect(await getMemoryFeedback(originalId)).toEqual(FEEDBACK_DEFAULTS);
    expect(await getMemoryImportance(originalId)).toBeNull();
  });

  it('trashAndDelete skips the snapshot when state is default', async () => {
    const { trashAndDelete } = mem0 as any;
    const { newTestPoint } = await import('./test-points.js');
    const { STATE_SNAPSHOT_KEY } = await import('./memory-state.js');
    const originalId = await newTestPoint('trash-plain');
    statePointIds.push(originalId);
    calls.add.length = 0;

    const result = await trashAndDelete(
      { id: originalId, memory: 'texto sem nenhum voto' },
      undefined,
      { reason: 't', trigger: 't' },
    );
    expect(result.deleted).toBe(true);
    expect((calls.add[0] as any).config.metadata[STATE_SNAPSHOT_KEY]).toBeUndefined();
  });

  it('restoreFromTrash reapplies feedback + importance from the snapshot', async () => {
    const { restoreFromTrash, getMemoryFeedback, getMemoryImportance, scoreImportance, addToBlocklist, isBlocklisted } = mem0 as any;
    const { newTestPoint } = await import('./test-points.js');
    const { STATE_SNAPSHOT_KEY } = await import('./memory-state.js');
    const TEXT = 'o usuario prefere bun para tooling javascript';
    // Race-proof by construction: addMemory's fire-and-forget scoring writes
    // scoreImportance(TEXT) to the new point concurrently — the snapshot
    // carries exactly that value, so write order is irrelevant. Feedback is
    // only ever written by the restore path (TEXT is not state-heuristic).
    const importance = scoreImportance(TEXT);
    const snapshotFeedback = {
      confidence: 1.0, last_confirmed_at: null, status: 'active',
      kind: 'fact', sensitive: false, correct_count: 3, title: 'titulo y',
    };
    const { newTestPoint: mk } = await import('./test-points.js');
    const trashId = await mk('trash-copy');
    const restoredId = await mk('restore-target');
    statePointIds.push(trashId, restoredId);

    cannedTrashList = [{
      id: trashId,
      memory: TEXT,
      created_at: new Date().toISOString(),
      metadata: {
        original_id: 'original-gone',
        deleted_from: 'global',
        trashed_at: new Date().toISOString(),
        [STATE_SNAPSHOT_KEY]: { feedback: snapshotFeedback, importance },
      },
    }];
    cannedAddId = restoredId;
    calls.add.length = 0;
    calls.delete.length = 0;

    await addToBlocklist(TEXT);
    expect(await isBlocklisted(TEXT)).toBe(true);

    const result = await restoreFromTrash(trashId);
    expect(result).toEqual({ id: restoredId, restored: true });

    // Full-fidelity state came back (the IIFE never writes feedback for this text).
    expect(await getMemoryFeedback(restoredId)).toEqual(snapshotFeedback);
    expect(await getMemoryImportance(restoredId)).toBe(importance);
    // Trash copy gone and blocklist lifted.
    expect(calls.delete).toContain(trashId);
    expect(await isBlocklisted(TEXT)).toBe(false);
  });

  it('deleteState evicts feedback + importance without touching the point', async () => {
    const { setMemoryFeedback, setMemoryImportance, getMemoryFeedback, getMemoryImportance, deleteState } = mem0 as any;
    const { newTestPoint } = await import('./test-points.js');
    const { FEEDBACK_DEFAULTS } = await import('./memory-state.js');
    const id = await newTestPoint('delete-state');
    statePointIds.push(id);
    await setMemoryFeedback(id, { confidence: 1.0 });
    await setMemoryImportance(id, 0.9);
    await deleteState(id);
    expect(await getMemoryFeedback(id)).toEqual(FEEDBACK_DEFAULTS);
    expect(await getMemoryImportance(id)).toBeNull();
  });
});

});

afterAll(() => {
  mock.module('mem0ai/oss', () => realMem0aiOss);
  mock.module('./maintenance-log.js', () => realMaintenance);
});
