import { describe, expect, test } from 'bun:test';
import { runLouvain } from './louvain.js';

describe('Louvain Community Detection', () => {
  test('single node returns one community', () => {
    const result = runLouvain([{ id: '1' }], [], { minCommunitySize: 1, targetPartitionMax: 100 });
    expect(result.length).toBe(1);
    expect(result[0].nodeIds).toEqual(['1']);
  });

  test('two disconnected clusters form two communities', () => {
    const nodes = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }, { id: '6' }];
    const edges = [
      { source: '1', target: '2', weight: 1 }, { source: '2', target: '3', weight: 1 }, { source: '1', target: '3', weight: 1 },
      { source: '4', target: '5', weight: 1 }, { source: '5', target: '6', weight: 1 }, { source: '4', target: '6', weight: 1 },
    ];
    const result = runLouvain(nodes, edges, { minCommunitySize: 1, targetPartitionMax: 100 });
    expect(result.length).toBe(2);
    const sizes = result.map(c => c.nodeIds.length).sort();
    expect(sizes).toEqual([3, 3]);
  });

  test('merges small communities into neighbors', () => {
    const nodes = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }];
    const edges = [
      { source: '1', target: '2', weight: 5 }, { source: '2', target: '3', weight: 5 },
      { source: '1', target: '3', weight: 5 }, { source: '3', target: '4', weight: 0.1 },
    ];
    const result = runLouvain(nodes, edges, { minCommunitySize: 3, targetPartitionMax: 100 });
    expect(result.length).toBe(1);
    expect(result[0].nodeIds.length).toBe(4);
  });

  test('no edges returns single community', () => {
    const result = runLouvain([{ id: '1' }, { id: '2' }, { id: '3' }], [], { minCommunitySize: 1, targetPartitionMax: 100 });
    expect(result.length).toBe(1);
  });

  test('community IDs are sequential from 0', () => {
    const nodes = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }, { id: '6' }];
    const edges = [
      { source: '1', target: '2', weight: 1 }, { source: '2', target: '3', weight: 1 },
      { source: '4', target: '5', weight: 1 }, { source: '5', target: '6', weight: 1 },
    ];
    const result = runLouvain(nodes, edges, { minCommunitySize: 1, targetPartitionMax: 100 });
    const ids = result.map(c => c.id).sort();
    for (let i = 0; i < ids.length; i++) expect(ids[i]).toBe(i);
  });

  test('all nodes appear exactly once across communities', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
    const edges: { source: string; target: string; weight: number }[] = [];
    for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) edges.push({ source: String(i), target: String(j), weight: 1 });
    for (let i = 10; i < 20; i++) for (let j = i + 1; j < 20; j++) edges.push({ source: String(i), target: String(j), weight: 1 });
    const result = runLouvain(nodes, edges, { minCommunitySize: 1, targetPartitionMax: 100 });
    const allNodeIds = result.flatMap(c => c.nodeIds).sort((a, b) => Number(a) - Number(b));
    expect(allNodeIds).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
  });
});
