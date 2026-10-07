import { describe, test, expect } from 'bun:test';
import { shouldRejectEntity, shouldRejectRelationship, loadBlocklist, sweepGraph } from './graph-autoclean.js';
import Graph from 'graphology';

describe('shouldRejectEntity', () => {
  test('rejects commit hashes', () => {
    expect(shouldRejectEntity('fed76be', 'Other')).toBe(true);
    expect(shouldRejectEntity('acd05bf3c8d96d6bf366b7f3a01a8ca002', 'Other')).toBe(true);
  });

  test('rejects IP addresses', () => {
    expect(shouldRejectEntity('192.168.0.177', 'Other')).toBe(true);
  });

  test('rejects URL paths', () => {
    expect(shouldRejectEntity('get /api/vault/audit', 'Technology')).toBe(true);
    expect(shouldRejectEntity('post /signup', 'Technology')).toBe(true);
  });

  test('rejects very short entities (<=2 chars)', () => {
    expect(shouldRejectEntity('xp', 'Other')).toBe(true);
  });

  test('rejects pure numbers', () => {
    expect(shouldRejectEntity('5.1729', 'Other')).toBe(true);
    expect(shouldRejectEntity('713', 'Other')).toBe(true);
  });

  test('rejects date strings as entities', () => {
    expect(shouldRejectEntity('december 2025', 'Other')).toBe(true);
    expect(shouldRejectEntity('april 1, 1987', 'Other')).toBe(true);
  });

  test('rejects speaker/narrator labels', () => {
    expect(shouldRejectEntity('speaker 4', 'Person')).toBe(true);
    expect(shouldRejectEntity('speaker/narrator', 'Person')).toBe(true);
  });

  test('rejects phone numbers', () => {
    expect(shouldRejectEntity('558132640725', 'Other')).toBe(true);
  });

  test('rejects blocklisted entities', () => {
    loadBlocklist({ ids: ['bob esponja', 'fargo'], patterns: [] });
    expect(shouldRejectEntity('bob esponja', 'Person')).toBe(true);
    expect(shouldRejectEntity('fargo', 'Location')).toBe(true);
    // Reset blocklist
    loadBlocklist({ ids: [], patterns: [] });
  });

  test('accepts valid entities', () => {
    expect(shouldRejectEntity('lucas', 'Person')).toBe(false);
    expect(shouldRejectEntity('reino capital', 'Company')).toBe(false);
    expect(shouldRejectEntity('typescript', 'Technology')).toBe(false);
    expect(shouldRejectEntity('supabase', 'Technology')).toBe(false);
    expect(shouldRejectEntity('recife', 'Location')).toBe(false);
  });
});

describe('shouldRejectRelationship', () => {
  test('rejects if source or target would be rejected', () => {
    expect(shouldRejectRelationship('lucas', 'RELATED_TO', 'fed76be')).toBe(true);
    expect(shouldRejectRelationship('192.168.0.1', 'USES', 'typescript')).toBe(true);
  });

  test('accepts valid relationships', () => {
    expect(shouldRejectRelationship('lucas', 'USES', 'typescript')).toBe(false);
    expect(shouldRejectRelationship('lain', 'DEPENDS_ON', 'bunjs')).toBe(false);
  });
});

describe('sweepGraph', () => {
  test('removes orphan nodes (0 edges)', () => {
    const graph = new Graph({ type: 'directed', multi: false });
    graph.addNode('lucas', { type: 'Person', mentions: 100, firstSeen: Date.now(), lastSeen: Date.now() });
    graph.addNode('orphan', { type: 'Other', mentions: 1, firstSeen: Date.now(), lastSeen: Date.now() });
    graph.addNode('connected', { type: 'Technology', mentions: 5, firstSeen: Date.now(), lastSeen: Date.now() });
    graph.addEdgeWithKey('lucas-USES-connected', 'lucas', 'connected', { predicate: 'USES', weight: 1, firstSeen: Date.now(), lastSeen: Date.now() });

    const result = sweepGraph(graph);
    expect(result.orphansRemoved).toBe(1);
    expect(graph.hasNode('orphan')).toBe(false);
    expect(graph.hasNode('lucas')).toBe(true);
    expect(graph.hasNode('connected')).toBe(true);
  });

  test('removes nodes matching reject patterns', () => {
    const graph = new Graph({ type: 'directed', multi: false });
    graph.addNode('lucas', { type: 'Person', mentions: 100, firstSeen: Date.now(), lastSeen: Date.now() });
    graph.addNode('fed76be', { type: 'Other', mentions: 1, firstSeen: Date.now(), lastSeen: Date.now() });
    graph.addEdgeWithKey('lucas-RELATED_TO-fed76be', 'lucas', 'fed76be', { predicate: 'RELATED_TO', weight: 1, firstSeen: Date.now(), lastSeen: Date.now() });

    const result = sweepGraph(graph);
    expect(result.patternRemoved).toBeGreaterThan(0);
    expect(graph.hasNode('fed76be')).toBe(false);
  });

  test('removes stale low-mention nodes', () => {
    const graph = new Graph({ type: 'directed', multi: false });
    const oldDate = Date.now() - 40 * 86400000;
    graph.addNode('lucas', { type: 'Person', mentions: 100, firstSeen: Date.now(), lastSeen: Date.now() });
    graph.addNode('stale-thing', { type: 'Other', mentions: 1, firstSeen: oldDate, lastSeen: oldDate });
    graph.addEdgeWithKey('lucas-RELATED_TO-stale', 'lucas', 'stale-thing', { predicate: 'RELATED_TO', weight: 1, firstSeen: oldDate, lastSeen: oldDate });

    const result = sweepGraph(graph);
    expect(result.staleRemoved).toBeGreaterThan(0);
    expect(graph.hasNode('stale-thing')).toBe(false);
  });

  test('preserves fresh nodes even with 1 mention', () => {
    const graph = new Graph({ type: 'directed', multi: false });
    graph.addNode('lucas', { type: 'Person', mentions: 100, firstSeen: Date.now(), lastSeen: Date.now() });
    graph.addNode('fresh-thing', { type: 'Technology', mentions: 1, firstSeen: Date.now(), lastSeen: Date.now() });
    graph.addEdgeWithKey('lucas-USES-fresh', 'lucas', 'fresh-thing', { predicate: 'USES', weight: 1, firstSeen: Date.now(), lastSeen: Date.now() });

    const result = sweepGraph(graph);
    expect(graph.hasNode('fresh-thing')).toBe(true);
  });
});
