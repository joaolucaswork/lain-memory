/**
 * PGS Query Router — routes queries to relevant partitions.
 * Uses cosine similarity between query embedding and partition centroids.
 * Broad/open-ended queries bypass routing for full coverage.
 */

import type { EnrichedPartition, PGSConfig } from './defaults.js';
import { cosineSimilarity } from './partitioner.js';

const BROAD_PATTERNS = [
  /what.*(surpris|miss|gap|absence|unknown)/i,
  /what.*don.*t.*know/i,
  /full.*sweep/i,
  /everything/i,
  /comprehensive.*overview/i,
  /all.*partition/i,
  /o que.*(falta|ausente|desconhecido)/i,
  /tudo sobre/i,
  /visao.*geral/i,
  /analise.*completa/i,
];

export function routeQuery(
  query: string,
  queryEmbedding: number[] | null,
  partitions: EnrichedPartition[],
  config: PGSConfig
): EnrichedPartition[] {
  const { maxSweepPartitions, minSweepPartitions, partitionRelevanceThreshold } = config;

  if (!queryEmbedding) return partitions.slice(0, maxSweepPartitions);
  if (BROAD_PATTERNS.some(p => p.test(query))) return partitions.slice(0, maxSweepPartitions);

  const ranked = partitions
    .map(p => ({ ...p, similarity: p.centroidEmbedding ? cosineSimilarity(queryEmbedding, p.centroidEmbedding) : 0 }))
    .sort((a, b) => b.similarity - a.similarity);

  let selected = ranked.filter(p => p.similarity >= partitionRelevanceThreshold);
  if (minSweepPartitions > 0 && selected.length < minSweepPartitions) selected = ranked.slice(0, minSweepPartitions);
  if (selected.length > maxSweepPartitions) selected = selected.slice(0, maxSweepPartitions);

  return selected;
}
