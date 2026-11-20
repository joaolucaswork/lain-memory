/**
 * Resolve + hygiene for graphrag (graphrag split G9).
 *
 * Duplicate-entity resolution, size-bounded pruning, and the periodic
 * autoclean sweep (delegates to graph-autoclean, persists + invalidates).
 */

import { sweepGraph, type SweepResult } from '../graph-autoclean.js';
import {
  ENABLED,
  entitySimilarity,
  getGraph,
  isNodeVisibleToProject,
  mergeSources,
  nodeProject,
  normalizeProject,
  relationshipKey,
  saveGraph,
} from './store.js';
import { MASTER_TENANT, normalizeTenant } from '../tenants.js';
import { invalidateGraphCache } from './cache.js';
import type { EntityAttrs, RelationshipAttrs } from './types.js';

// ─── Entity Resolution (Patch 3) ───

/**
 * Resolve duplicate entities in the graph.
 * Merges entities that likely refer to the same thing:
 * - Same type + high name similarity (>0.75)
 * - Transfers edges from duplicates to canonical entity
 * Returns number of entities merged.
 */
export async function resolveEntities(threshold = 0.75, project?: string, tenant: string = MASTER_TENANT): Promise<{ merged: number; pairs: string[][] }> {
  if (!ENABLED || !getGraph() || getGraph().order < 2) return { merged: 0, pairs: [] };

  const t = normalizeTenant(tenant) || MASTER_TENANT;
  const onlyScope = project ? normalizeProject(project) : undefined;

  const nodes = getGraph().mapNodes((key, attrs) => ({
    key,
    attrs: attrs as EntityAttrs,
  }));

  // Group by scope + type: never merge across scopes (Fase 2).
  // A project-scoped sweep only touches that project's group.
  // Tenant filter first: a tenant only ever sees (and merges) its own nodes.
  const byType = new Map<string, typeof nodes>();
  for (const node of nodes) {
    if (!isNodeVisibleToProject(node.key, project, t)) continue;
    const scope = nodeProject(node.key) ?? '';
    if (onlyScope && t === MASTER_TENANT && scope !== onlyScope) continue;
    const type = node.attrs.type || 'Other';
    const groupKey = `${scope}\0${type}`;
    const group = byType.get(groupKey) || [];
    group.push(node);
    byType.set(groupKey, group);
  }

  const mergedPairs: string[][] = [];
  const toRemove = new Set<string>();

  for (const [_type, group] of byType) {
    for (let i = 0; i < group.length; i++) {
      if (toRemove.has(group[i].key)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (toRemove.has(group[j].key)) continue;

        const sim = entitySimilarity(group[i].key, group[j].key);
        if (sim >= threshold) {
          // Keep the one with more mentions as canonical
          const [canonical, duplicate] = group[i].attrs.mentions >= group[j].attrs.mentions
            ? [group[i], group[j]]
            : [group[j], group[i]];

          // Merge attributes
          const cAttrs = getGraph().getNodeAttributes(canonical.key) as EntityAttrs;
          const dAttrs = getGraph().getNodeAttributes(duplicate.key) as EntityAttrs;
          cAttrs.mentions += dAttrs.mentions;
          cAttrs.firstSeen = Math.min(cAttrs.firstSeen, dAttrs.firstSeen);
          cAttrs.lastSeen = Math.max(cAttrs.lastSeen, dAttrs.lastSeen);
          if (dAttrs.description && (!cAttrs.description || dAttrs.description.length > cAttrs.description.length)) {
            cAttrs.description = dAttrs.description;
          }
          const mergedSources = mergeSources(cAttrs.sources, dAttrs.sources);
          if (mergedSources) cAttrs.sources = mergedSources;
          getGraph().replaceNodeAttributes(canonical.key, cAttrs);

          // Transfer edges from duplicate to canonical (merging sources on collision)
          getGraph().forEachEdge(duplicate.key, (edge, attrs, source, target) => {
            const newSource = source === duplicate.key ? canonical.key : source;
            const newTarget = target === duplicate.key ? canonical.key : target;
            const edgeKey = relationshipKey(newSource, newTarget, (attrs as RelationshipAttrs).predicate);
            if (newSource === newTarget) return;
            if (getGraph().hasEdge(edgeKey)) {
              try {
                const prev = getGraph().getEdgeAttributes(edgeKey) as RelationshipAttrs;
                const m = mergeSources(prev.sources, (attrs as RelationshipAttrs).sources);
                if (m) {
                  prev.sources = m;
                  getGraph().replaceEdgeAttributes(edgeKey, prev);
                }
              } catch { /* ignore */ }
            } else {
              try {
                getGraph().addEdgeWithKey(edgeKey, newSource, newTarget, attrs);
              } catch { /* edge already exists */ }
            }
          });

          toRemove.add(duplicate.key);
          mergedPairs.push([duplicate.key, canonical.key]);
        }
      }
    }
  }

  // Remove duplicates
  for (const key of toRemove) {
    try { getGraph().dropNode(key); } catch { /* already removed */ }
  }

  if (mergedPairs.length > 0) {
    await saveGraph();
    await invalidateGraphCache();
    console.log(`[graphrag] Entity resolution: merged ${mergedPairs.length} duplicates`);
  }

  return { merged: mergedPairs.length, pairs: mergedPairs };
}

// ─── Graph Maintenance ───

export async function pruneGraph(maxNodes: number = 5000): Promise<number> {
  if (!getGraph() || getGraph().order <= maxNodes) return 0;

  const nodes = getGraph().mapNodes((key, attrs) => {
    const a = attrs as EntityAttrs;
    const daysSinceLastSeen = (Date.now() - (a.lastSeen || 0)) / 86400000;
    const isTenantNode = key.startsWith('tn-');
    return {
      key,
      score: (a.mentions || 1) / (1 + daysSinceLastSeen),
      isTenantNode,
    };
  });

  // Tenant-spam protection: prune tenant nodes before master/legacy nodes,
  // so one tenant flooding the shared graph.json can never evict lucas data.
  // Within each tier, lowest score (stale, low-mention) goes first.
  nodes.sort((a, b) => {
    if (a.isTenantNode !== b.isTenantNode) return a.isTenantNode ? -1 : 1;
    return a.score - b.score;
  });
  const toRemove = nodes.slice(0, getGraph().order - maxNodes);
  for (const { key } of toRemove) getGraph().dropNode(key);
  await saveGraph();
  await invalidateGraphCache();
  return toRemove.length;
}

// ─── Autoclean ───

export async function runAutoclean(): Promise<SweepResult> {
  if (!getGraph()) return { orphansRemoved: 0, patternRemoved: 0, staleRemoved: 0, total: 0 };
  const start = Date.now();
  const result = sweepGraph(getGraph());
  const duration = Date.now() - start;
  if (result.total > 0) {
    await saveGraph();
    await invalidateGraphCache();
    console.log(`[graphrag] Autoclean: removed ${result.total} nodes (${result.orphansRemoved} orphans, ${result.patternRemoved} pattern, ${result.staleRemoved} stale)`);
  }
  try {
    const { logMaintenance } = await import('../maintenance-log.js');
    logMaintenance('graph_autoclean', {
      orphansRemoved: result.orphansRemoved,
      patternRemoved: result.patternRemoved,
      staleRemoved: result.staleRemoved,
      total: result.total,
      graphNodes: getGraph()?.order ?? 0,
    }, duration);
  } catch { /* non-critical */ }
  return result;
}
