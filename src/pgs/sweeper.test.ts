import { describe, expect, test } from 'bun:test';
import { buildSweepPrompt, sweepPartition } from './sweeper.js';
import type { EnrichedPartition, LLMProvider } from './defaults.js';
import { PGS_DEFAULTS } from './defaults.js';

describe('Sweeper', () => {
  test('buildSweepPrompt includes partition count and 4 sections', () => {
    const prompt = buildSweepPrompt(10, 5);
    expect(prompt).toContain('10 nodes');
    expect(prompt).toContain('## Domain State');
    expect(prompt).toContain('## Findings');
    expect(prompt).toContain('## Outbound Flags');
    expect(prompt).toContain('## Absences');
  });

  test('sweepPartition calls provider and returns structured result', async () => {
    const mockProvider: LLMProvider = {
      generate: async ({ instructions, input }) => {
        expect(instructions).toContain('Domain State');
        expect(input).toContain('Query: test query');
        return { content: '## Domain State\nTest domain\n## Findings\nNone\n## Outbound Flags\nNone\n## Absences\nNothing missing' };
      },
    };
    const partition: EnrichedPartition = {
      id: 0, nodeIds: ['n1', 'n2'], nodeCount: 2, summary: 'Test partition',
      keywords: ['test'], centroidEmbedding: null, adjacentPartitions: [],
    };
    const nodeMap = new Map([
      ['n1', { id: 'n1', concept: 'Node one content', tag: 'test', weight: 0.8 }],
      ['n2', { id: 'n2', concept: 'Node two content', tag: 'test', weight: 0.5 }],
    ]);
    const result = await sweepPartition('test query', partition, nodeMap, [], [partition], mockProvider, PGS_DEFAULTS);
    expect(result.partitionId).toBe(0);
    expect(result.sweepOutput).toContain('Domain State');
    expect(result.nodesIncluded).toBe(2);
  });
});
