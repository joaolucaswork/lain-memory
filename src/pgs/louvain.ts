/**
 * Louvain community detection — pure TypeScript, no dependencies.
 * Partitions the knowledge graph into communities for PGS sweeps.
 */

import type { Community } from './defaults.js';

interface LouvainConfig {
  minCommunitySize: number;
  targetPartitionMax: number;
}

interface NodeInput { id: string | number; }
interface EdgeInput { source: string | number; target: string | number; weight?: number; }

export function runLouvain(nodes: NodeInput[], edges: EdgeInput[], config: LouvainConfig): Community[] {
  const { minCommunitySize, targetPartitionMax } = config;

  const adj = new Map<string, Map<string, number>>();
  const nodeIds = nodes.map(n => String(n.id));
  const nodeIdSet = new Set(nodeIds);

  for (const nid of nodeIds) adj.set(nid, new Map());

  let totalWeight = 0;
  for (const edge of edges) {
    const src = String(edge.source);
    const tgt = String(edge.target);
    if (!nodeIdSet.has(src) || !nodeIdSet.has(tgt)) continue;
    if (src === tgt) continue;
    const w = edge.weight ?? 0.5;
    totalWeight += w;
    if (!adj.has(src)) adj.set(src, new Map());
    if (!adj.has(tgt)) adj.set(tgt, new Map());
    adj.get(src)!.set(tgt, (adj.get(src)!.get(tgt) || 0) + w);
    adj.get(tgt)!.set(src, (adj.get(tgt)!.get(src) || 0) + w);
  }

  if (totalWeight === 0) return [{ id: 0, nodeIds }];

  const m2 = 2 * totalWeight;
  const community = new Map<string, number>();
  const communityNodes = new Map<number, Set<string>>();

  for (let i = 0; i < nodeIds.length; i++) {
    community.set(nodeIds[i], i);
    communityNodes.set(i, new Set([nodeIds[i]]));
  }

  const strength = new Map<string, number>();
  for (const nid of nodeIds) {
    let s = 0;
    const neighbors = adj.get(nid);
    if (neighbors) for (const w of neighbors.values()) s += w;
    strength.set(nid, s);
  }

  const communityStrength = new Map<number, number>();
  for (const [cid, members] of communityNodes) {
    let total = 0;
    for (const nid of members) total += strength.get(nid) || 0;
    communityStrength.set(cid, total);
  }

  const MAX_ITERATIONS = 20;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let moved = false;
    const shuffled = [...nodeIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (const nid of shuffled) {
      const currentComm = community.get(nid)!;
      const neighbors = adj.get(nid);
      if (!neighbors || neighbors.size === 0) continue;
      const ki = strength.get(nid) || 0;

      const commWeights = new Map<number, number>();
      for (const [neighbor, w] of neighbors) {
        const neighborComm = community.get(neighbor)!;
        commWeights.set(neighborComm, (commWeights.get(neighborComm) || 0) + w);
      }

      const wCurrent = commWeights.get(currentComm) || 0;
      const sigmaCurrent = communityStrength.get(currentComm) || 0;
      const removeGain = wCurrent - (ki * (sigmaCurrent - ki)) / m2;

      let bestComm = currentComm;
      let bestGain = 0;
      for (const [targetComm, wTarget] of commWeights) {
        if (targetComm === currentComm) continue;
        const sigmaTarget = communityStrength.get(targetComm) || 0;
        const gain = wTarget - (ki * sigmaTarget) / m2;
        const netGain = gain - removeGain;
        if (netGain > bestGain) { bestGain = netGain; bestComm = targetComm; }
      }

      if (bestComm !== currentComm && bestGain > 1e-10) {
        communityNodes.get(currentComm)!.delete(nid);
        communityStrength.set(currentComm, (communityStrength.get(currentComm) || 0) - ki);
        if (communityNodes.get(currentComm)!.size === 0) {
          communityNodes.delete(currentComm);
          communityStrength.delete(currentComm);
        }
        community.set(nid, bestComm);
        if (!communityNodes.has(bestComm)) communityNodes.set(bestComm, new Set());
        communityNodes.get(bestComm)!.add(nid);
        communityStrength.set(bestComm, (communityStrength.get(bestComm) || 0) + ki);
        moved = true;
      }
    }
    if (!moved) break;
  }

  mergeSmallCommunities(communityNodes, community, adj, minCommunitySize);
  splitLargeCommunities(communityNodes, community, adj, targetPartitionMax);

  const result: Community[] = [];
  let partitionId = 0;
  for (const [, members] of communityNodes) {
    if (members.size === 0) continue;
    result.push({ id: partitionId++, nodeIds: [...members] });
  }
  return result;
}

function mergeSmallCommunities(communityNodes: Map<number, Set<string>>, community: Map<string, number>, adj: Map<string, Map<string, number>>, minSize: number): void {
  let merged = true;
  while (merged) {
    merged = false;
    for (const [cid, members] of communityNodes) {
      if (members.size >= minSize || members.size === 0) continue;
      const neighborCommWeights = new Map<number, number>();
      for (const nid of members) {
        const neighbors = adj.get(nid);
        if (!neighbors) continue;
        for (const [neighbor, w] of neighbors) {
          const nComm = community.get(neighbor)!;
          if (nComm !== cid) neighborCommWeights.set(nComm, (neighborCommWeights.get(nComm) || 0) + w);
        }
      }
      if (neighborCommWeights.size === 0) continue;
      let bestTarget: number | null = null;
      let bestWeight = -1;
      for (const [targetComm, w] of neighborCommWeights) {
        if (w > bestWeight) { bestWeight = w; bestTarget = targetComm; }
      }
      if (bestTarget === null) continue;
      for (const nid of members) {
        community.set(nid, bestTarget);
        communityNodes.get(bestTarget)!.add(nid);
      }
      members.clear();
      communityNodes.delete(cid);
      merged = true;
      break;
    }
  }
}

function splitLargeCommunities(communityNodes: Map<number, Set<string>>, community: Map<string, number>, adj: Map<string, Map<string, number>>, maxSize: number): void {
  const toSplit: number[] = [];
  for (const [cid, members] of communityNodes) {
    if (members.size > maxSize) toSplit.push(cid);
  }
  for (const cid of toSplit) {
    const members = [...communityNodes.get(cid)!];
    if (members.length <= maxSize) continue;
    const groupA = new Set<string>();
    const groupB = new Set<string>();
    groupA.add(members[0]);
    groupB.add(members[Math.floor(members.length / 2)]);
    for (let i = 1; i < members.length; i++) {
      const nid = members[i];
      if (groupA.has(nid) || groupB.has(nid)) continue;
      let wA = 0, wB = 0;
      const neighbors = adj.get(nid);
      if (neighbors) {
        for (const [neighbor, w] of neighbors) {
          if (groupA.has(neighbor)) wA += w;
          if (groupB.has(neighbor)) wB += w;
        }
      }
      const scoreA = wA - 0.1 * groupA.size;
      const scoreB = wB - 0.1 * groupB.size;
      if (scoreA >= scoreB) groupA.add(nid); else groupB.add(nid);
    }
    const existingKeys = [...communityNodes.keys()];
    const newCid = existingKeys.length > 0 ? Math.max(...existingKeys) + 1 : 0;
    communityNodes.get(cid)!.clear();
    for (const nid of groupA) { communityNodes.get(cid)!.add(nid); community.set(nid, cid); }
    communityNodes.set(newCid, new Set());
    for (const nid of groupB) { communityNodes.get(newCid)!.add(nid); community.set(nid, newCid); }
  }
}
