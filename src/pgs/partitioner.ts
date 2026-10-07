/**
 * Partition enrichment for PGS.
 * Computes centroids, keywords, adjacencies, summaries — no LLM calls.
 */

import type { Community, EnrichedPartition } from './defaults.js';

interface NodeData {
  id: string;
  concept: string;
  embedding?: number[] | null;
  tag?: string;
  weight?: number;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'out',
  'off', 'over', 'under', 'again', 'then', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'because',
  'but', 'and', 'or', 'if', 'while', 'that', 'this', 'these', 'those',
  'it', 'its', 'they', 'them', 'their', 'we', 'our', 'you', 'your',
  'he', 'she', 'his', 'her', 'what', 'which', 'who', 'also', 'about',
  'com', 'que', 'uma', 'para', 'por', 'dos', 'das', 'nos', 'nas',
  'ele', 'ela', 'seu', 'sua', 'como', 'mais', 'foi', 'ser', 'ter',
]);

export function enrichPartitions(communities: Community[], nodes: NodeData[], edges: Array<{ source: string | number; target: string | number; weight?: number }>): EnrichedPartition[] {
  const nodeMap = new Map<string, NodeData>();
  for (const node of nodes) nodeMap.set(String(node.id), node);

  return communities.map(comm => {
    const centroid = computeCentroid(comm.nodeIds, nodeMap);
    const keywords = extractKeywords(comm.nodeIds, nodeMap, 50);
    const adjacentPartitions = findAdjacentPartitions(comm, communities, edges);
    const summary = generateQuickSummary(comm.nodeIds, nodeMap, keywords);

    return {
      id: comm.id, nodeIds: comm.nodeIds, nodeCount: comm.nodeIds.length,
      summary, keywords: keywords.slice(0, 20), centroidEmbedding: centroid, adjacentPartitions,
    };
  });
}

export function computeCentroid(nodeIds: string[], nodeMap: Map<string, NodeData>): number[] | null {
  let count = 0;
  let centroid: number[] | null = null;
  for (const nid of nodeIds) {
    const node = nodeMap.get(nid);
    if (!node?.embedding || !Array.isArray(node.embedding)) continue;
    if (!centroid) centroid = new Array(node.embedding.length).fill(0);
    for (let i = 0; i < node.embedding.length; i++) centroid[i] += node.embedding[i];
    count++;
  }
  if (!centroid || count === 0) return null;
  for (let i = 0; i < centroid.length; i++) centroid[i] /= count;
  return centroid;
}

export function extractKeywords(nodeIds: string[], nodeMap: Map<string, NodeData>, topK = 50): string[] {
  const termFreq = new Map<string, number>();
  for (const nid of nodeIds) {
    const node = nodeMap.get(nid);
    if (!node?.concept) continue;
    const words = node.concept.toLowerCase().replace(/[^a-z0-9\u00e0-\u00ff\s-]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
    const seen = new Set<string>();
    for (const word of words) {
      if (!seen.has(word)) { termFreq.set(word, (termFreq.get(word) || 0) + 1); seen.add(word); }
    }
  }
  return [...termFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([term]) => term);
}

export function cosineSimilarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i]; }
  const denom = Math.sqrt(nA) * Math.sqrt(nB);
  return denom === 0 ? 0 : dot / denom;
}

function findAdjacentPartitions(partition: Community, allPartitions: Community[], edges: Array<{ source: string | number; target: string | number }>): Array<{ id: number; sharedEdges: number }> {
  const nodeIdSet = new Set(partition.nodeIds);
  const adjacentWeights = new Map<number, number>();
  const nodeToPartition = new Map<string, number>();
  for (const p of allPartitions) for (const nid of p.nodeIds) nodeToPartition.set(nid, p.id);

  for (const edge of edges) {
    const src = String(edge.source), tgt = String(edge.target);
    if (nodeIdSet.has(src) && !nodeIdSet.has(tgt)) {
      const tp = nodeToPartition.get(tgt);
      if (tp !== undefined && tp !== partition.id) adjacentWeights.set(tp, (adjacentWeights.get(tp) || 0) + 1);
    } else if (nodeIdSet.has(tgt) && !nodeIdSet.has(src)) {
      const tp = nodeToPartition.get(src);
      if (tp !== undefined && tp !== partition.id) adjacentWeights.set(tp, (adjacentWeights.get(tp) || 0) + 1);
    }
  }
  return [...adjacentWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([pid, count]) => ({ id: pid, sharedEdges: count }));
}

function generateQuickSummary(nodeIds: string[], nodeMap: Map<string, NodeData>, keywords: string[]): string {
  const nodesWithWeight = nodeIds.map(nid => nodeMap.get(nid)).filter((n): n is NodeData => !!n?.concept).sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const topNode = nodesWithWeight[0];
  const topKeywords = keywords.slice(0, 8).join(', ');
  if (topNode) {
    const snippet = topNode.concept.substring(0, 120).replace(/\n/g, ' ');
    return `${topKeywords}. Top: ${snippet}...`;
  }
  return topKeywords || `Partition with ${nodeIds.length} nodes`;
}
