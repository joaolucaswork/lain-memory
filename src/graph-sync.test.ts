import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import Graph from 'graphology';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendGraphOutbox,
  drainGraphOutbox,
  type GraphOutboxEntry,
} from './graphrag.js';

// Fase 3 — outbox durável + reconciliação.
// Estes testes não tocam o graph.json de produção: o outbox usa
// LAIN_GRAPH_OUTBOX_DIR (lido a cada chamada) apontado para tmp, e o drain
// usa um executor injetado (sem LLM, sem grafo global).

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lain-outbox-'));
  process.env.LAIN_GRAPH_OUTBOX_DIR = tmp;
});

afterEach(() => {
  delete process.env.LAIN_GRAPH_OUTBOX_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe('appendGraphOutbox', () => {
  test('persiste entrada com id/ts/attempts', () => {
    const entry = appendGraphOutbox({ text: 'hello', project: 'lain', sourceIds: ['m1'] });
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.attempts).toBe(0);
    expect(entry.text).toBe('hello');
    expect(entry.project).toBe('lain');
    expect(entry.sourceIds).toEqual(['m1']);
  });
});

describe('drainGraphOutbox', () => {
  test('aplica entradas e esvazia a fila', async () => {
    appendGraphOutbox({ text: 'a' });
    appendGraphOutbox({ entities: [{ name: 'X', type: 'Other', description: 'd' }], relationships: [] });
    const seen: GraphOutboxEntry[] = [];
    const result = await drainGraphOutbox(async (e) => { seen.push(e); });
    expect(result).toMatchObject({ processed: 2, failed: 0, deadLettered: 0, pending: 0 });
    expect(seen.length).toBe(2);
    const again = await drainGraphOutbox(async () => {});
    expect(again.processed).toBe(0);
  });

  test('falha re-enfileira com attempts+1; veneno vai para dead-letter', async () => {
    appendGraphOutbox({ text: 'boom' });
    const fail = async () => { throw new Error('llm down'); };
    const r1 = await drainGraphOutbox(fail);
    expect(r1).toMatchObject({ processed: 0, failed: 1, deadLettered: 0, pending: 1 });
    // Esgota tentativas: 1 inicial + 4 re-drains = 5 → dead-letter na última
    let looped = { processed: 0, failed: 0, deadLettered: 0, pending: 0 };
    for (let i = 0; i < 4; i++) looped = await drainGraphOutbox(fail);
    expect(looped.deadLettered).toBe(1);
    expect(looped.pending).toBe(0);
    const last = await drainGraphOutbox(fail);
    expect(last).toMatchObject({ processed: 0, failed: 0, deadLettered: 0, pending: 0 });
    const empty = await drainGraphOutbox(async () => {});
    expect(empty.processed).toBe(0);
  });

  test('recupera arquivos .processing órfãos (queda após claim)', async () => {
    const { appendFileSync } = await import('fs');
    appendFileSync(
      join(tmp, '.graph-outbox.processing-crash'),
      JSON.stringify({ id: 'orphan', ts: 1, attempts: 0, text: 'recovered' }) + '\n',
      'utf8'
    );
    const seen: string[] = [];
    const result = await drainGraphOutbox(async (e) => { seen.push(e.id); });
    expect(result.processed).toBe(1);
    expect(seen).toEqual(['orphan']);
  });

  test('linha corrompida não trava o drain', async () => {
    const { appendFileSync } = await import('fs');
    const { appendGraphOutbox: append } = await import('./graphrag.js');
    append({ text: 'good' });
    appendFileSync(join(tmp, 'graph-outbox.jsonl'), 'THIS IS NOT JSON\n', 'utf8');
    const seen: string[] = [];
    const result = await drainGraphOutbox(async (e) => { seen.push(e.id); });
    expect(result.processed).toBe(1);
    expect(seen.length).toBe(1);
  });
});

describe('regras de proveniência (espelho local)', () => {
  function seed(g: Graph, id: string, sources?: string[]): void {
    if (!g.hasNode(id)) {
      g.addNode(id, { type: 'Other', firstSeen: 1, lastSeen: 1, mentions: 1, ...(sources !== undefined ? { sources } : {}) });
    }
  }

  function stripSource(g: Graph, memoryId: string): { edgesPruned: number; nodesPruned: number } {
    let edgesPruned = 0;
    const dead: string[] = [];
    g.forEachEdge((edge, attrs) => {
      const a = attrs as { sources?: string[] };
      if (!a.sources || !a.sources.includes(memoryId)) return;
      a.sources = a.sources.filter(s => s !== memoryId);
      if (a.sources.length === 0) dead.push(edge);
      else g.replaceEdgeAttributes(edge, a);
    });
    for (const e of dead) { g.dropEdge(e); edgesPruned++; }
    let nodesPruned = 0;
    g.forEachNode((n, attrs) => {
      const a = attrs as { sources?: string[] };
      if (!a.sources || !a.sources.includes(memoryId)) return;
      a.sources = a.sources.filter(s => s !== memoryId);
      if (a.sources.length === 0 && g.degree(n) === 0) { g.dropNode(n); nodesPruned++; }
      else g.replaceNodeAttributes(n, a);
    });
    return { edgesPruned, nodesPruned };
  }

  test('repetição faz união de sources sem duplicar', () => {
    const g = new Graph({ type: 'directed', multi: true });
    seed(g, 'lucas', ['m1']);
    const a = g.getNodeAttributes('lucas') as { sources: string[] };
    const merged = [...new Set([...a.sources, ...['m1', 'm2']])];
    expect(merged.sort()).toEqual(['m1', 'm2']);
  });

  test('strip remove só o id; aresta cai quando fica sem sources', () => {
    const g = new Graph({ type: 'directed', multi: true });
    seed(g, 'a', ['m1', 'm2']);
    seed(g, 'b', ['m1']);
    g.addEdgeWithKey('a-R-b', 'a', 'b', { predicate: 'R', weight: 1, firstSeen: 1, lastSeen: 1, sources: ['m1'] });
    g.addEdgeWithKey('a-S-b', 'a', 'b', { predicate: 'S', weight: 1, firstSeen: 1, lastSeen: 1, sources: ['m1', 'm2'] });
    const r = stripSource(g, 'm1');
    expect(r.edgesPruned).toBe(1);
    expect(g.hasEdge('a-R-b')).toBe(false);
    expect(g.hasEdge('a-S-b')).toBe(true);
    expect((g.getEdgeAttributes('a-S-b') as { sources: string[] }).sources).toEqual(['m2']);
  });

  test('legado (sources undefined) nunca é podado', () => {
    const g = new Graph({ type: 'directed', multi: true });
    seed(g, 'old');
    seed(g, 'older');
    g.addEdgeWithKey('old-R-older', 'old', 'older', { predicate: 'R', weight: 9, firstSeen: 1, lastSeen: 1 });
    const r = stripSource(g, 'mX');
    expect(r).toEqual({ edgesPruned: 0, nodesPruned: 0 });
    expect(g.hasEdge('old-R-older')).toBe(true);
  });
});
