import { describe, test, expect } from 'bun:test';
import {
  domainOpForClassification,
  applyDeletionPolicy,
  type PolicyDeps,
  type PolicySnapshot,
} from './memory-policy.js';

// Fase 4 — política de domínio (puro, sem Mem0/FS: fakes injetados).

function fakes(overrides: Partial<PolicyDeps> = {}): PolicyDeps & {
  trashed: { snap: PolicySnapshot; prov: unknown }[];
  audited: unknown[];
} {
  const state = { trashed: [] as { snap: PolicySnapshot; prov: unknown }[], audited: [] as unknown[] };
  return {
    ...state,
    snapshot: async (ids) => ids.map(id => ({ id, memory: `text of ${id}` })),
    trashAndDelete: async (snap, _from, prov) => {
      state.trashed.push({ snap, prov });
      return { trashId: `trash-${snap.id}`, deleted: true };
    },
    audit: (record) => { state.audited.push(record); },
    ...overrides,
  };
}

describe('domainOpForClassification', () => {
  test('ADD→save, UPDATE/DELETE→supersede, NOOP→ignore', () => {
    expect(domainOpForClassification('ADD')).toBe('save');
    expect(domainOpForClassification('UPDATE')).toBe('supersede');
    expect(domainOpForClassification('DELETE')).toBe('supersede');
    expect(domainOpForClassification('NOOP')).toBe('ignore');
  });
});

describe('applyDeletionPolicy', () => {
  test('arquiva com trash + auditoria, sem falhar', async () => {
    const deps = fakes();
    const report = await applyDeletionPolicy(
      { ids: ['a', 'b'], project: 'lain', reason: 'test', trigger: 'test-run' },
      deps
    );
    expect(report.archived).toEqual(['a', 'b']);
    expect(report.failed).toEqual([]);
    expect(report.trashIds).toEqual({ a: 'trash-a', b: 'trash-b' });
    expect(deps.trashed.map(t => t.snap.id)).toEqual(['a', 'b']);
    expect(deps.audited).toHaveLength(2);
    expect(deps.trashed[0].prov).toMatchObject({ reason: 'test', trigger: 'test-run' });
  });

  test('cópia trash não confirmada → failed, original preservado (fail-closed)', async () => {
    const deps = fakes({
      trashAndDelete: async () => ({ trashId: null, deleted: false }),
    });
    const report = await applyDeletionPolicy({ ids: ['a'], project: 'p', reason: 'r', trigger: 't' }, deps);
    expect(report.archived).toEqual([]);
    expect(report.trashIds).toEqual({});
    expect(report.failed).toEqual([{ id: 'a', error: 'trash copy unconfirmed — original preserved, will retry' }]);
    expect(report.audit[0]).toMatchObject({ result: 'trash-failed', trashId: null });
  });

  test('deleted:false mesmo com trashId → failed (defensivo)', async () => {
    const deps = fakes({
      trashAndDelete: async () => ({ trashId: 'trash-x', deleted: false }),
    });
    const report = await applyDeletionPolicy({ ids: ['a'], project: 'p', reason: 'r', trigger: 't' }, deps);
    expect(report.archived).toEqual([]);
    expect(report.failed).toHaveLength(1);
  });

  test('snapshot missing → failed sem tocar no original', async () => {
    const deps = fakes({
      snapshot: async (ids) => ids.map(id => ({ id, memory: '', missing: true as const })),
      trashAndDelete: async () => ({ trashId: null, deleted: false }),
    });
    const report = await applyDeletionPolicy({ ids: ['gone'], project: 'p', reason: 'r', trigger: 't' }, deps);
    expect(report.archived).toEqual([]);
    expect(report.failed).toHaveLength(1);
  });

  test('falha no hard delete → failed, sem sucesso silencioso', async () => {
    const deps = fakes({
      trashAndDelete: async () => { throw new Error('qdrant down'); },
    });
    const report = await applyDeletionPolicy({ ids: ['a'], project: 'p', reason: 'r', trigger: 't' }, deps);
    expect(report.archived).toEqual([]);
    expect(report.failed).toEqual([{ id: 'a', error: 'qdrant down' }]);
    expect(report.audit[0]).toMatchObject({ result: 'failed', error: 'qdrant down' });
  });

  test('falha na camada snapshot → tudo em failed, nada tocado', async () => {
    const deps = fakes({
      snapshot: async () => { throw new Error('getAll exploded'); },
    });
    const report = await applyDeletionPolicy({ ids: ['a', 'b'], project: 'p', reason: 'r', trigger: 't' }, deps);
    expect(report.failed).toHaveLength(2);
    expect(deps.trashed).toEqual([]);
    expect(deps.audited).toEqual([]);
  });

  test('auditor que lança → registrado em auditFailed, sem silêncio', async () => {
    const deps = fakes({
      audit: () => { throw new Error('disk full'); },
    });
    const report = await applyDeletionPolicy({ ids: ['a'], project: 'p', reason: 'r', trigger: 't' }, deps);
    expect(report.archived).toEqual(['a']);
    expect(report.auditFailed).toEqual([{ memoryId: 'a', error: 'disk full' }]);
  });
});
