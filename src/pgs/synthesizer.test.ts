import { describe, expect, test } from 'bun:test';
import { buildSynthesisPrompt, synthesize } from './synthesizer.js';
import type { LLMProvider, SweepResult } from './defaults.js';
import { PGS_DEFAULTS } from './defaults.js';

describe('Synthesizer', () => {
  test('buildSynthesisPrompt includes 4 synthesis tasks', () => {
    const prompt = buildSynthesisPrompt(3);
    expect(prompt).toContain('Cross-Domain Connection Discovery');
    expect(prompt).toContain('Absence Detection');
    expect(prompt).toContain('Convergence Identification');
    expect(prompt).toContain('Thesis Formation');
  });

  test('synthesize calls provider with all sweep outputs', async () => {
    const sweeps: SweepResult[] = [
      { partitionId: 0, partitionSummary: 'Tech stack', nodeCount: 5, nodesIncluded: 5, keywords: ['typescript'], adjacentPartitions: [],
        sweepOutput: '## Domain State\nTS stuff\n## Findings\nNode 1\n## Outbound Flags\nNone\n## Absences\nNo Python' },
      { partitionId: 1, partitionSummary: 'Infrastructure', nodeCount: 3, nodesIncluded: 3, keywords: ['docker'], adjacentPartitions: [],
        sweepOutput: '## Domain State\nInfra\n## Findings\nNode 4\n## Outbound Flags\nRelates to P-0\n## Absences\nNo K8s' },
    ];
    const mockProvider: LLMProvider = {
      generate: async ({ instructions, input }) => {
        expect(instructions).toContain('SYNTHESIS phase');
        expect(input).toContain('Partition P-0');
        expect(input).toContain('Partition P-1');
        return { content: 'Synthesized answer across both partitions.' };
      },
    };
    const result = await synthesize('what is the stack?', sweeps, mockProvider,
      { totalNodes: 8, totalEdges: 10, totalPartitions: 2, selectedPartitions: 2 }, PGS_DEFAULTS);
    expect(result).toContain('Synthesized answer');
  });
});
