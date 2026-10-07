import { describe, expect, test } from 'bun:test';
import { enrichPartitions, computeCentroid, extractKeywords, cosineSimilarity } from './partitioner.js';

describe('Partitioner', () => {
  const makeNode = (id: string, concept: string, embedding?: number[], weight?: number) => ({
    id, concept, embedding: embedding ?? null, tag: 'test', weight: weight ?? 0.5,
  });

  test('computeCentroid averages embeddings', () => {
    const nodes = new Map([['1', makeNode('1', 'a', [1, 0, 0])], ['2', makeNode('2', 'b', [0, 1, 0])], ['3', makeNode('3', 'c', [0, 0, 1])]]);
    const centroid = computeCentroid(['1', '2', '3'], nodes);
    expect(centroid).not.toBeNull();
    expect(centroid![0]).toBeCloseTo(1 / 3);
    expect(centroid![1]).toBeCloseTo(1 / 3);
    expect(centroid![2]).toBeCloseTo(1 / 3);
  });

  test('computeCentroid returns null when no embeddings', () => {
    const nodes = new Map([['1', makeNode('1', 'no embedding')]]);
    expect(computeCentroid(['1'], nodes)).toBeNull();
  });

  test('extractKeywords returns top terms by document frequency', () => {
    const nodes = new Map([
      ['1', makeNode('1', 'machine learning algorithms')],
      ['2', makeNode('2', 'deep learning neural networks')],
      ['3', makeNode('3', 'machine learning optimization')],
    ]);
    const keywords = extractKeywords(['1', '2', '3'], nodes, 5);
    expect(keywords[0]).toBe('learning');
    expect(keywords[1]).toBe('machine');
  });

  test('enrichPartitions produces complete partition objects', () => {
    const communities = [{ id: 0, nodeIds: ['1', '2'] }];
    const nodes = [makeNode('1', 'alpha concept test', [1, 0], 0.9), makeNode('2', 'beta concept test', [0, 1], 0.5)];
    const edges = [{ source: '1', target: '2', weight: 1 }];
    const partitions = enrichPartitions(communities, nodes, edges);
    expect(partitions.length).toBe(1);
    expect(partitions[0].id).toBe(0);
    expect(partitions[0].nodeCount).toBe(2);
    expect(partitions[0].keywords.length).toBeGreaterThan(0);
    expect(partitions[0].centroidEmbedding).not.toBeNull();
    expect(partitions[0].summary).toBeTruthy();
  });

  test('cosineSimilarity computes correctly', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity(null, [1, 0])).toBe(0);
  });
});
