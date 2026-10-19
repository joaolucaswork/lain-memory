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

/**
 * Parse a positive-int env knob. Returns `fallback` when unset, non-numeric,
 * or <= 0 — so a bad env value can never zero-out or break the engine.
 */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const PGS_DEFAULTS: PGSConfig = {
  maxConcurrentSweeps: 5,
  minNodesForPgs: 0,
  minCommunitySize: 3,
  targetPartitionMax: 500,
  maxSweepPartitions: envPositiveInt('LAIN_PGS_MAX_SWEEPS', 5),
  minSweepPartitions: 0,
  partitionRelevanceThreshold: 0.25,
  sweepMaxTokens: envPositiveInt('LAIN_PGS_SWEEP_MAX_TOKENS', 3000),
  synthesisMaxTokens: envPositiveInt('LAIN_PGS_SYNTHESIS_MAX_TOKENS', 8000),
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
