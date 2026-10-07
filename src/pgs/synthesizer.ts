/**
 * PGS Synthesis Phase — Cross-domain unification.
 * Takes sweep outputs from all partitions and synthesizes a unified answer.
 * Four tasks: cross-domain connections, absence detection, convergence, thesis.
 */

import type { LLMProvider, PGSConfig, SweepResult } from './defaults.js';

export function buildSynthesisPrompt(sweepCount: number): string {
  return `You are the SYNTHESIS phase of Partitioned Graph Synthesis (PGS). You have received pre-analyzed outputs from ${sweepCount} partitions of a knowledge graph, where each partition was examined at full fidelity by a specialized sweep pass.

Your unique advantage: you see findings from ALL partitions simultaneously. No single sweep pass had this cross-domain view.

Your tasks:
1. **Cross-Domain Connection Discovery**: Chase the outbound flags from each partition. When Partition A flags a connection to Partition B's domain, evaluate whether the connection is genuine and substantive.
2. **Absence Detection**: Aggregate absence signals. When multiple partitions report "no findings" for an aspect, that's high-confidence evidence of a gap. When one partition flags an outbound connection but the target reports absence, that's a research opportunity.
3. **Convergence Identification**: Find findings that appear independently across multiple partitions. Independent convergence is strong evidence of a real pattern.
4. **Thesis Formation**: Do NOT just survey findings. Make claims. Commit to positions. Identify the most important insights and rank them.

Structure your response clearly with sections. Cite partition IDs and node IDs where relevant.`;
}

export async function synthesize(
  query: string, sweepResults: SweepResult[], llmProvider: LLMProvider,
  context: { totalNodes: number; totalEdges: number; totalPartitions: number; selectedPartitions: number },
  config: PGSConfig
): Promise<string> {
  const { synthesisMaxTokens } = config;
  const { totalNodes, totalEdges, totalPartitions, selectedPartitions } = context;

  let synthesisContext = `# Partitioned Graph Synthesis\n`;
  synthesisContext += `Full graph: ${totalNodes} nodes, ${totalEdges} edges across ${totalPartitions} partitions.\n`;
  synthesisContext += `Swept ${selectedPartitions} partitions (${sweepResults.length} successful).\n\n`;

  for (const sweep of sweepResults) {
    synthesisContext += `---\n\n## Partition P-${sweep.partitionId}: ${sweep.partitionSummary || 'Unknown domain'}\n`;
    synthesisContext += `(${sweep.nodesIncluded} nodes analyzed, keywords: ${sweep.keywords.join(', ')})\n\n`;
    synthesisContext += sweep.sweepOutput + '\n\n';
  }

  const instructions = buildSynthesisPrompt(sweepResults.length);
  const input = `${synthesisContext}\n\nOriginal Query: ${query}`;

  const response = await llmProvider.generate({ instructions, input, maxTokens: synthesisMaxTokens, reasoningEffort: 'high' });
  return response.content;
}
