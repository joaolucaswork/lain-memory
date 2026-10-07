import { describe, expect, test } from 'bun:test';
import { PGSEngine } from './index.js';
import type { LLMProvider } from './defaults.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('PGSEngine', () => {
  const mockSweepProvider: LLMProvider = {
    generate: async () => ({
      content: '## Domain State\nTest\n## Findings\nNode n1\n## Outbound Flags\nNone\n## Absences\nNone',
    }),
  };
  const mockSynthProvider: LLMProvider = {
    generate: async () => ({ content: 'Synthesized cross-domain analysis complete.' }),
  };
  const graph = {
    nodes: [
      { id: 'n1', concept: 'Machine learning algorithms for prediction' },
      { id: 'n2', concept: 'Deep learning neural networks' },
      { id: 'n3', concept: 'Database optimization strategies' },
      { id: 'n4', concept: 'SQL query performance tuning' },
    ],
    edges: [
      { source: 'n1', target: 'n2', weight: 1 },
      { source: 'n3', target: 'n4', weight: 1 },
    ],
  };

  test('execute returns answer and metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgs-engine-test-'));
    const engine = new PGSEngine({ sweepProvider: mockSweepProvider, synthesisProvider: mockSynthProvider, sessionsDir: dir });
    const result = await engine.execute('what is the tech stack?', graph);
    expect(result.answer).toContain('Synthesized');
    expect(result.metadata.pgs.totalNodes).toBe(4);
    expect(result.metadata.pgs.totalEdges).toBe(2);
    expect(result.metadata.pgs.successfulSweeps).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('partition creates communities from graph', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgs-engine-test-'));
    const engine = new PGSEngine({ sweepProvider: mockSweepProvider, synthesisProvider: mockSynthProvider, sessionsDir: dir });
    const partitions = engine.partition(graph);
    expect(partitions.length).toBeGreaterThan(0);
    const allNodeIds = partitions.flatMap(p => p.nodeIds).sort();
    expect(allNodeIds).toEqual(['n1', 'n2', 'n3', 'n4']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('continue mode skips already-searched partitions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgs-engine-test-'));
    const engine = new PGSEngine({ sweepProvider: mockSweepProvider, synthesisProvider: mockSynthProvider, sessionsDir: dir });
    await engine.execute('test', graph, { mode: 'full', sessionId: 'continue-test' });
    const r2 = await engine.execute('test', graph, { mode: 'continue', sessionId: 'continue-test' });
    expect(r2.metadata.pgs.successfulSweeps).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
