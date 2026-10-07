import { describe, expect, test } from 'bun:test';
import { routeQuery } from './router.js';
import type { EnrichedPartition } from './defaults.js';
import { PGS_DEFAULTS } from './defaults.js';

describe('Router', () => {
  const config = { ...PGS_DEFAULTS };
  const makePartition = (id: number, centroid: number[] | null): EnrichedPartition => ({
    id, nodeIds: ['n1'], nodeCount: 10, summary: `Partition ${id}`,
    keywords: [], centroidEmbedding: centroid, adjacentPartitions: [],
  });

  test('returns all partitions when no query embedding', () => {
    const partitions = [makePartition(0, [1, 0]), makePartition(1, [0, 1])];
    expect(routeQuery('test', null, partitions, config).length).toBe(2);
  });

  test('ranks partitions by cosine similarity', () => {
    const partitions = [makePartition(0, [0, 1, 0]), makePartition(1, [1, 0, 0]), makePartition(2, [0.7, 0.7, 0])];
    const result = routeQuery('test', [1, 0, 0], partitions, config);
    expect(result[0].id).toBe(1);
  });

  test('filters below relevance threshold', () => {
    const partitions = [makePartition(0, [1, 0]), makePartition(1, [0, 1])];
    const result = routeQuery('test', [1, 0], partitions, config);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(0);
  });

  test('broad queries bypass routing', () => {
    const partitions = [makePartition(0, [1, 0]), makePartition(1, [0, 1])];
    expect(routeQuery('what is missing from the analysis?', [1, 0], partitions, config).length).toBe(2);
  });

  test('respects maxSweepPartitions', () => {
    const partitions = Array.from({ length: 20 }, (_, i) => makePartition(i, [Math.cos(i), Math.sin(i)]));
    expect(routeQuery('test', [1, 0], partitions, { ...config, maxSweepPartitions: 5 }).length).toBeLessThanOrEqual(5);
  });
});
