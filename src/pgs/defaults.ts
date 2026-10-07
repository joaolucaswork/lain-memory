/**
 * PGS Engine — Configuration defaults.
 * Adapted from pgs-engine for Lain's smaller graph scale.
 */

export interface PGSConfig {
  maxConcurrentSweeps: number;
  minNodesForPgs: number;
  minCommunitySize: number;
  targetPartitionMax: number;
  maxSweepPartitions: number;
  minSweepPartitions: number;
  partitionRelevanceThreshold: number;
  sweepMaxTokens: number;
  synthesisMaxTokens: number;
  sweepFraction: number | null;
}

export const PGS_DEFAULTS: PGSConfig = {
  maxConcurrentSweeps: 5,
  minNodesForPgs: 0,
  minCommunitySize: 3,
  targetPartitionMax: 500,
  maxSweepPartitions: 15,
  minSweepPartitions: 0,
  partitionRelevanceThreshold: 0.25,
  sweepMaxTokens: 6000,
  synthesisMaxTokens: 16000,
  sweepFraction: null,
};

export interface LLMProvider {
  generate(params: {
    instructions: string;
    input: string;
    maxTokens: number;
    reasoningEffort: 'low' | 'medium' | 'high';
  }): Promise<{ content: string }>;
}

export interface EnrichedPartition {
  id: number;
  nodeIds: string[];
  nodeCount: number;
  summary: string;
  keywords: string[];
  centroidEmbedding: number[] | null;
  adjacentPartitions: Array<{ id: number; sharedEdges: number }>;
  similarity?: number;
}

export interface Community {
  id: number;
  nodeIds: string[];
}

export interface SweepResult {
  partitionId: number;
  partitionSummary: string;
  nodeCount: number;
  nodesIncluded: number;
  keywords: string[];
  adjacentPartitions: Array<{ id: number; sharedEdges: number }>;
  sweepOutput: string;
}

export interface PGSResult {
  answer: string;
  metadata: {
    mode: string;
    pgs: {
      totalNodes: number;
      totalEdges: number;
      totalPartitions: number;
      sweptPartitions: number;
      successfulSweeps: number;
      elapsed: string;
      sessionMode: string;
      sessionId: string;
      searched: number;
      remaining: number;
    };
    timestamp: string;
  };
}
