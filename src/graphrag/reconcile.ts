/**
 * Reconcile for graphrag (graphrag split G10).
 *
 * Provenance pruning, outbox drain orchestration, targeted removals,
 * node listing, and the PGS export. Closes the split — graphrag.ts
 * is now a pure barrel.
 */

import { readdirSync } from 'fs';
import { withDistributedLock } from '../distributed-lock.js';
import { incrementMetric } from '../mem-metrics.js';
import {
  getGraph,
  isNodeVisibleToProject,
  normalizeProject,
  resolveNodeId,
  saveGraph,
} from './store.js';
import {
  CACHE_TTL_PGS,
  cacheGet,
  cacheSet,
  invalidateGraphCache,
} from './cache.js';
import {
  drainGraphOutbox,
  getLastSyncError,
  outboxDir,
  outboxPath,
  readOutboxFile,
  setLastSyncError,
} from './outbox.js';
import type { EntityAttrs, RelationshipAttrs } from './types.js';

/**
 * Remove provenance for a deleted/updated Mem0 memory (Fase 3).
 * Strips the id from all sources; drops ONLY edges/nodes that had
 * provenance and are left with none. Legacy entries (sources undefined)
 * are never pruned — no deletion without evidence.
 */
export async function removeGraphProvenance(memoryId: string): Promise<{ edgesPruned: number; nodesPruned: number }> {
  if (!getGraph()) return { edgesPruned: 0, nodesPruned: 0 };
  let edgesPruned = 0;

  // Strip from every edge; drop those left with no sources.
  const deadEdges: string[] = [];
  getGraph().forEachEdge((edge, attrs) => {
    const a = attrs as RelationshipAttrs;
    if (!a.sources || !a.sources.includes(memoryId)) return;
    a.sources = a.sources.filter(s => s !== memoryId);
    if (a.sources.length === 0) {
      deadEdges.push(edge);
    } else {
      getGraph().replaceEdgeAttributes(edge, a);
    }
  });
  for (const edge of deadEdges) {
    try { getGraph().dropEdge(edge); edgesPruned++; } catch { /* already removed */ }
  }

  // Strip from every node; drop orphan nodes left with no sources.
  // Legacy nodes (sources undefined) are never dropped.
  let nodesPruned = 0;
  getGraph().forEachNode((nodeId, attrs) => {
    const a = attrs as EntityAttrs;
    if (!a.sources || !a.sources.includes(memoryId)) return;
    a.sources = a.sources.filter(s => s !== memoryId);
    if (a.sources.length === 0 && getGraph().degree(nodeId) === 0) {
      try { getGraph().dropNode(nodeId); nodesPruned++; } catch { /* already removed */ }
    } else {
      getGraph().replaceNodeAttributes(nodeId, a);
    }
  });

  if (edgesPruned > 0 || nodesPruned > 0) {
    await saveGraph();
    await invalidateGraphCache();
    incrementMetric('graphPrunedEdges');
    console.log(`[graphrag] Provenance prune for ${memoryId.slice(0, 8)}: ${edgesPruned} edges, ${nodesPruned} nodes`);
  }
  return { edgesPruned, nodesPruned };
}

/** Last successful reconcile timestamp. */
let lastReconciledAt: string | null = null;

export function getGraphSyncStatus(): {
  pending: number;
  processing: number;
  lastError: string | null;
  lastReconciledAt: string | null;
} {
  let pending = 0;
  let processing = 0;
  try {
    pending = readOutboxFile(outboxPath()).entries.length;
    processing = readdirSync(outboxDir()).filter(
      f => f.startsWith('.graph-outbox.processing-') || f.startsWith('.graph-outbox.claimed-')
    ).length;
  } catch { /* unreadable — report zeros */ }
  return { pending, processing, lastError: getLastSyncError(), lastReconciledAt };
}

/**
 * Reconcile derived projection with source of truth (Fase 3).
 * Drains the outbox (including crash-orphaned entries) and reports.
 * Idempotent: re-ingestion never duplicates (Fase 1 identity).
 */
export async function reconcileGraph(): Promise<{
  processed: number;
  failed: number;
  deadLettered: number;
  pending: number;
  graphNodes: number;
  graphEdges: number;
}> {
  const start = Date.now();
  let result = { processed: 0, failed: 0, deadLettered: 0, pending: 0 };
  await withDistributedLock('graphrag:reconcile', 300_000, async () => {
    result = await drainGraphOutbox();
  }).catch(err => {
    setLastSyncError(err instanceof Error ? err.message : String(err));
    console.error('[graphrag] Reconcile error:', getLastSyncError());
  });
  lastReconciledAt = new Date().toISOString();
  incrementMetric('graphReconciled');
  try {
    const { logMaintenance } = await import('../maintenance-log.js');
    logMaintenance('graph_reconcile', {
      ...result,
      graphNodes: getGraph()?.order ?? 0,
      graphEdges: getGraph()?.size ?? 0,
    }, Date.now() - start);
  } catch { /* non-critical */ }
  return { ...result, graphNodes: getGraph()?.order ?? 0, graphEdges: getGraph()?.size ?? 0 };
}

/**
 * Remove specific nodes (and all their edges) from the graph.
 * Returns the list of nodes actually removed.
 */
export async function removeNodes(nodeIds: string[], project?: string): Promise<string[]> {
  if (!getGraph()) return [];
  const removed: string[] = [];
  for (const id of nodeIds) {
    const key = resolveNodeId(id, project);
    if (getGraph().hasNode(key)) {
      getGraph().dropNode(key);
      removed.push(key);
    }
  }
  if (removed.length > 0) {
    await saveGraph();
    await invalidateGraphCache();
    console.log(`[graphrag] Removed ${removed.length} nodes: ${removed.slice(0, 10).join(', ')}${removed.length > 10 ? '...' : ''}`);
  }
  return removed;
}

/**
 * Remove specific edges/relationships from a source node.
 * Returns count of edges removed.
 */
export async function removeRelationships(
  source: string,
  predicates?: string[],
  targets?: string[],
  project?: string
): Promise<number> {
  if (!getGraph()) return 0;
  const srcKey = resolveNodeId(source, project);
  if (!getGraph().hasNode(srcKey)) return 0;

  const scopedTargets = targets?.map(t => resolveNodeId(t, project));
  const toRemove: string[] = [];
  getGraph().forEachOutEdge(srcKey, (edge, attrs, _src, tgt) => {
    const relAttrs = attrs as RelationshipAttrs;
    if (predicates && !predicates.includes(relAttrs.predicate)) return;
    if (scopedTargets && !scopedTargets.includes(tgt)) return;
    toRemove.push(edge);
  });

  for (const edge of toRemove) {
    try { getGraph().dropEdge(edge); } catch { /* already removed */ }
  }

  if (toRemove.length > 0) {
    await saveGraph();
    await invalidateGraphCache();
    console.log(`[graphrag] Removed ${toRemove.length} edges from ${srcKey}`);
  }
  return toRemove.length;
}

/**
 * List all nodes in the graph with basic info.
 * With project: only nodes visible to that project (global + its scope).
 */
export function listAllNodes(project?: string): Array<{ id: string; type: string; mentions: number; edgeCount: number }> {
  if (!getGraph()) return [];
  const out: Array<{ id: string; type: string; mentions: number; edgeCount: number }> = [];
  getGraph().forEachNode((key, attrs) => {
    if (!isNodeVisibleToProject(key, project)) return;
    const a = attrs as EntityAttrs;
    out.push({
      id: key,
      type: a.type || 'Other',
      mentions: a.mentions || 0,
      edgeCount: getGraph()!.degree(key),
    });
  });
  return out;
}

// ─── PGS Integration ───

/**
 * Export graph data in PGS-compatible format.
 * Maps entity descriptions to `concept` field for PGS consumption.
 */
export async function cachedGetGraphForPGS(project?: string): Promise<ReturnType<typeof getGraphForPGS>> {
  const scopeSuffix = project ? normalizeProject(project) : '';
  const cached = await cacheGet<ReturnType<typeof getGraphForPGS>>(`pgs:${scopeSuffix}`);
  if (cached) return cached;
  const result = getGraphForPGS(project);
  await cacheSet(`pgs:${scopeSuffix}`, result, CACHE_TTL_PGS);
  return result;
}

export function getGraphForPGS(project?: string): {
  nodes: Array<{ id: string; concept: string; tag: string; weight: number }>;
  edges: Array<{ source: string; target: string; weight: number }>;
} {
  if (!getGraph() || getGraph().order === 0) {
    return { nodes: [], edges: [] };
  }

  const nodes: Array<{ id: string; concept: string; tag: string; weight: number }> = [];
  getGraph().forEachNode((nodeId, attrs) => {
    if (!isNodeVisibleToProject(nodeId, project)) return;
    const a = attrs as EntityAttrs;
    nodes.push({
      id: nodeId,
      concept: a.description || nodeId,
      tag: a.type || 'Other',
      weight: Math.min(1, (a.mentions || 1) / 10),
    });
  });

  const edges: Array<{ source: string; target: string; weight: number }> = [];
  getGraph().forEachEdge((_edge, attrs, source, target) => {
    if (!isNodeVisibleToProject(source, project) || !isNodeVisibleToProject(target, project)) return;
    const a = attrs as RelationshipAttrs;
    edges.push({
      source,
      target,
      weight: a.weight || 1,
    });
  });

  return { nodes, edges };
}
