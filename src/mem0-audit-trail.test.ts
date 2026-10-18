import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';

import * as realMem0aiOssNs from 'mem0ai/oss';
const realMem0aiOss = { ...realMem0aiOssNs };

import * as realMaintenanceNs from './maintenance-log.js';
const realMaintenance = { ...realMaintenanceNs };

// Must mock mem0ai/oss (it loads sqlite3 native binary) before importing mem0.ts
const calls: { getAll: unknown[]; add: unknown[]; delete: string[] } = { getAll: [], add: [], delete: [] };
let cannedGetAll: { results: unknown[] } = { results: [] };
// Fase 4 failure injection (default off — existing tests unaffected)
let failAdd = false;
const failDeleteFor = new Set<string>();
const maintenanceCalls: unknown[][] = [];

mock.module('mem0ai/oss', () => ({
  Memory: class MockMemory {
    constructor(..._args: unknown[]) {}
    async getAll(params: unknown) {
      calls.getAll.push(params);
      return cannedGetAll;
    }
    async add(messages: unknown, config: unknown) {
      if (failAdd) throw new Error('add failed');
      calls.add.push({ messages, config });
      return { results: [{ id: 'trash-id-1', memory: 'copied' }] };
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

});

afterAll(() => {
  mock.module('mem0ai/oss', () => realMem0aiOss);
  mock.module('./maintenance-log.js', () => realMaintenance);
});
