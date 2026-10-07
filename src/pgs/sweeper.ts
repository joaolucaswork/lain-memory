/**
 * PGS Sweep Phase — Parallel full-fidelity partition analysis.
 * Each partition gets its own LLM call with structured 4-section output:
 * Domain State, Findings, Outbound Flags, Absences.
 */

import type { EnrichedPartition, LLMProvider, PGSConfig, SweepResult } from './defaults.js';

const MAX_CONTEXT_CHARS = 500_000;

export function buildSweepPrompt(partitionNodeCount: number, totalPartitions: number): string {
  return `You are analyzing ONE partition of a larger knowledge graph as part of Partitioned Graph Synthesis (PGS).
This partition contains ${partitionNodeCount} nodes. The full graph has ${totalPartitions > 1 ? 'many more partitions being analyzed in parallel' : 'this single partition'}.

Your job is to extract ALL information relevant to the query from THIS partition. Be thorough — the synthesis phase will combine your output with outputs from other partitions.

Respond with EXACTLY this structure:

## Domain State
A brief (2-3 sentence) summary of what this partition covers and its current state relative to the query.

## Findings
List the key discoveries, connections, and relevant content WITHIN this partition. For each finding, cite the Node ID(s) that support it.

## Outbound Flags
List specific connections you see to content that likely exists in OTHER partitions (see adjacent partition summaries below). Be specific: "Node X's discussion of [topic] has structural parallels to [adjacent partition topic]" — not just "might relate."

## Absences
Explicitly state what was searched for and NOT found in this partition. "This partition contains no findings relevant to [aspect]" is valuable information for the synthesizer.`;
}

interface NodeData {
  id: string;
  concept: string;
  tag?: string;
  weight?: number;
}

export async function sweepPartitions(
  query: string, selectedPartitions: EnrichedPartition[], nodeMap: Map<string, NodeData>,
  edges: Array<{ source: string; target: string }>, allPartitions: EnrichedPartition[],
  llmProvider: LLMProvider, config: PGSConfig, onEvent?: (event: Record<string, unknown>) => void
): Promise<Array<{ status: string; value: SweepResult | null }>> {
  const { maxConcurrentSweeps } = config;
  const results: Array<{ status: string; value: SweepResult | null }> = [];
  const batches: EnrichedPartition[][] = [];
  const total = selectedPartitions.length;

  for (let i = 0; i < selectedPartitions.length; i += maxConcurrentSweeps) {
    batches.push(selectedPartitions.slice(i, i + maxConcurrentSweeps));
  }

  let completedCount = 0;
  for (const batch of batches) {
    const batchPromises = batch.map(async (partition) => {
      try {
        onEvent?.({ type: 'sweep_started', partitionId: partition.id, total });
        const result = await sweepPartition(query, partition, nodeMap, edges, allPartitions, llmProvider, config);
        completedCount++;
        onEvent?.({ type: 'sweep_complete', partitionId: partition.id, completed: completedCount, total });
        return result;
      } catch (error) {
        completedCount++;
        onEvent?.({ type: 'sweep_failed', partitionId: partition.id, error: (error as Error).message });
        return null;
      }
    });
    const batchResults = await Promise.allSettled(batchPromises);
    for (const r of batchResults) {
      results.push({ status: r.status, value: r.status === 'fulfilled' ? r.value : null });
    }
  }
  return results;
}

export async function sweepPartition(
  query: string, partition: EnrichedPartition, nodeMap: Map<string, NodeData>,
  edges: Array<{ source: string; target: string }>, allPartitions: EnrichedPartition[],
  llmProvider: LLMProvider, config: PGSConfig
): Promise<SweepResult> {
  const partitionNodes = partition.nodeIds
    .map(nid => nodeMap.get(nid))
    .filter((n): n is NodeData => !!n?.concept)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0));

  let nodeContext = '';
  let charCount = 0;
  for (const node of partitionNodes) {
    const nodeText = `[Node ${node.id}] (${node.tag || 'general'}, weight: ${(node.weight || 0).toFixed(2)})\n${node.concept}\n\n`;
    if (charCount + nodeText.length > MAX_CONTEXT_CHARS) break;
    nodeContext += nodeText;
    charCount += nodeText.length;
  }

  let adjacentContext = '';
  if (partition.adjacentPartitions?.length > 0) {
    adjacentContext = '\n--- ADJACENT PARTITIONS (for cross-domain awareness) ---\n';
    for (const adj of partition.adjacentPartitions) {
      const adjPartition = allPartitions.find(p => p.id === adj.id);
      if (adjPartition) {
        adjacentContext += `Partition P-${adj.id} (${adj.sharedEdges} shared edges): ${adjPartition.summary || 'No summary'}\n`;
        if (adjPartition.keywords?.length > 0) adjacentContext += `  Keywords: ${adjPartition.keywords.slice(0, 10).join(', ')}\n`;
      }
    }
  }

  const instructions = buildSweepPrompt(partitionNodes.length, allPartitions.length);
  const input = `${nodeContext}\n${adjacentContext}\n\nQuery: ${query}`;

  const response = await llmProvider.generate({ instructions, input, maxTokens: config.sweepMaxTokens, reasoningEffort: 'medium' });

  return {
    partitionId: partition.id, partitionSummary: partition.summary,
    nodeCount: partition.nodeCount, nodesIncluded: partitionNodes.length,
    keywords: partition.keywords?.slice(0, 10) || [],
    adjacentPartitions: partition.adjacentPartitions || [],
    sweepOutput: response.content,
  };
}
