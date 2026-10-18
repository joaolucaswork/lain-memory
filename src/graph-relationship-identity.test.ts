import { describe, test, expect } from 'bun:test';
import Graph from 'graphology';
import { relationshipKey } from './graphrag.js';

// Fase 1 — identidade da relação: origem + predicado + destino.
// Estes testes usam grafos locais (não tocam o graph.json de produção)
// e verificam o contrato que upsertRelationship() agora implementa:
// mesma chave para a mesma tripla, chaves distintas por predicado,
// coexistência de predicados e idempotência de repetição.

function localUpsert(
  graph: Graph,
  sourceId: string,
  targetId: string,
  predicate: string
): void {
  const now = Date.now();
  const edgeKey = relationshipKey(sourceId, targetId, predicate);
  if (graph.hasEdge(edgeKey)) {
    const attrs = graph.getEdgeAttributes(edgeKey) as { weight: number; lastSeen: number };
    attrs.weight += 1;
    attrs.lastSeen = now;
    graph.replaceEdgeAttributes(edgeKey, attrs);
  } else {
    if (!graph.hasNode(sourceId) || !graph.hasNode(targetId)) return;
    graph.addEdgeWithKey(edgeKey, sourceId, targetId, {
      predicate,
      weight: 1,
      firstSeen: now,
      lastSeen: now,
    });
  }
}

function seedNodes(graph: Graph): void {
  for (const id of ['lucas', 'lain']) {
    if (!graph.hasNode(id)) {
      graph.addNode(id, { type: 'Other', firstSeen: Date.now(), lastSeen: Date.now(), mentions: 1 });
    }
  }
}

describe('relationshipKey', () => {
  test('mesma tripla gera mesma chave', () => {
    expect(relationshipKey('lucas', 'lain', 'USES')).toBe(relationshipKey('lucas', 'lain', 'USES'));
  });

  test('predicados diferentes geram chaves diferentes', () => {
    expect(relationshipKey('lucas', 'lain', 'USES')).not.toBe(relationshipKey('lucas', 'lain', 'OWNS'));
  });

  test('direção importa', () => {
    expect(relationshipKey('lucas', 'lain', 'USES')).not.toBe(relationshipKey('lain', 'lucas', 'USES'));
  });

  test('preserva formato legado source-predicate-target', () => {
    expect(relationshipKey('lucas', 'lain', 'USES')).toBe('lucas-USES-lain');
  });
});

describe('identidade de relações (multi:true + edgeKey)', () => {
  test('predicados diferentes entre os mesmos nós coexistem', () => {
    const graph = new Graph({ type: 'directed', multi: true });
    seedNodes(graph);
    localUpsert(graph, 'lucas', 'lain', 'USES');
    localUpsert(graph, 'lucas', 'lain', 'OWNS');

    expect(graph.size).toBe(2);
    expect(graph.hasEdge('lucas-USES-lain')).toBe(true);
    expect(graph.hasEdge('lucas-OWNS-lain')).toBe(true);
    expect(graph.getEdgeAttributes('lucas-USES-lain')).toMatchObject({ predicate: 'USES', weight: 1 });
    expect(graph.getEdgeAttributes('lucas-OWNS-lain')).toMatchObject({ predicate: 'OWNS', weight: 1 });
  });

  test('repetir a mesma ingestão não duplica (só incrementa peso)', () => {
    const graph = new Graph({ type: 'directed', multi: true });
    seedNodes(graph);
    localUpsert(graph, 'lucas', 'lain', 'USES');
    localUpsert(graph, 'lucas', 'lain', 'USES');

    expect(graph.size).toBe(1);
    expect(graph.getEdgeAttributes('lucas-USES-lain')).toMatchObject({ predicate: 'USES', weight: 2 });
  });

  test('remover por predicado não afeta relação distinta', () => {
    const graph = new Graph({ type: 'directed', multi: true });
    seedNodes(graph);
    localUpsert(graph, 'lucas', 'lain', 'USES');
    localUpsert(graph, 'lucas', 'lain', 'OWNS');

    const toRemove: string[] = [];
    graph.forEachOutEdge('lucas', (edge, attrs) => {
      if ((attrs as { predicate: string }).predicate === 'USES') toRemove.push(edge);
    });
    for (const e of toRemove) graph.dropEdge(e);

    expect(graph.hasEdge('lucas-USES-lain')).toBe(false);
    expect(graph.hasEdge('lucas-OWNS-lain')).toBe(true);
  });
});
