/**
 * Query for graphrag (graphrag split G7).
 *
 * Subgraph search (string match + fuzzy fallback + BFS), markdown
 * rendering, and decision lookup. Read-only; results are cached.
 */

import { bfsFromNode } from 'graphology-traversal';
import {
  ENABLED,
  entitySimilarity,
  getGraph,
  isNodeVisibleToProject,
  MAX_CONTEXT_NODES,
  MAX_DEPTH,
  normalize,
  normalizeProject,
  tenantScope,
} from './store.js';
import { MASTER_TENANT, normalizeTenant } from '../tenants.js';
import {
  CACHE_TTL_DECISIONS,
  CACHE_TTL_QUERY,
  cacheGet,
  cacheSet,
  hashText,
} from './cache.js';
import type {
  DecisionAttrs,
  EntityAttrs,
  GraphContext,
  RelationshipAttrs,
} from './types.js';

export async function query(
  queryText: string,
  opts?: { maxDepth?: number; maxNodes?: number; project?: string; tenant?: string }
): Promise<GraphContext> {
  if (!ENABLED || !getGraph() || getGraph().order === 0) {
    return { entities: [], relationships: [], markdown: '' };
  }

  const maxDepth = opts?.maxDepth ?? MAX_DEPTH;
  const maxNodes = opts?.maxNodes ?? MAX_CONTEXT_NODES;
  const project = opts?.project;
  const tenant = normalizeTenant(opts?.tenant) || MASTER_TENANT;
  const scopeSuffix = tenantScope(tenant, project) ?? '';
  const cacheKey = `query:${hashText(queryText)}:${maxDepth}:${maxNodes}:${tenant}:${scopeSuffix}`;

  // Check cache
  const cached = await cacheGet<GraphContext>(cacheKey);
  if (cached) return cached;

  // Find matching entities by string matching against node IDs
  const STOPWORDS = new Set([
    'como', 'para', 'que', 'com', 'esse', 'essa', 'esta', 'este', 'isso', 'isto',
    'qual', 'quem', 'mais', 'ainda', 'tambem', 'sobre', 'entre', 'depois', 'antes',
    'quando', 'onde', 'porque', 'pode', 'deve', 'seria', 'precisa', 'caso', 'nao',
    'the', 'for', 'this', 'that', 'with', 'from', 'have', 'been', 'will', 'what',
    'when', 'where', 'which', 'would', 'should', 'could', 'does', 'into', 'just',
  ]);
  const queryNorm = normalize(queryText);
  const queryWords = queryNorm.split(/\s+/).filter(w => w.length >= 4 && !STOPWORDS.has(w));

  if (queryWords.length === 0) {
    return { entities: [], relationships: [], markdown: '' };
  }

  const minMatches = queryWords.length > 1 ? 2 : 1;
  const matchingNodes: string[] = [];
  getGraph().forEachNode((nodeId) => {
    if (!isNodeVisibleToProject(nodeId, project, tenant)) return;
    const matchCount = queryWords.filter(w => nodeId.includes(w)).length;
    if (matchCount >= minMatches) {
      matchingNodes.push(nodeId);
    }
  });

  // Fallback: fuzzy match for typos/spelling variants (e.g. respiridona vs risperidone).
  // entitySimilarity is bigram Dice; >=0.65 catches single-letter variants without noise.
  if (matchingNodes.length === 0 && queryWords.length === 1) {
    const q = queryWords[0];
    getGraph().forEachNode((nodeId) => {
      if (!isNodeVisibleToProject(nodeId, project, tenant)) return;
      if (entitySimilarity(q, nodeId) >= 0.65 || nodeId.split(' ').some(tok => entitySimilarity(q, tok) >= 0.65)) {
        matchingNodes.push(nodeId);
      }
    });
  }

  if (matchingNodes.length === 0) {
    return { entities: [], relationships: [], markdown: '' };
  }

  // BFS traversal from matching nodes
  const visited = new Set<string>();
  const contextEdges: Array<{ source: string; target: string; predicate: string; weight: number }> = [];

  for (const startNode of matchingNodes) {
    if (visited.size >= maxNodes) break;

    bfsFromNode(getGraph(), startNode, (node, _attrs, depth) => {
      if (depth > maxDepth || visited.size >= maxNodes) return true;
      if (!isNodeVisibleToProject(node, project, tenant)) return true;
      visited.add(node);

      getGraph().forEachOutEdge(node, (_edge, attrs, source, target) => {
        if (!isNodeVisibleToProject(source, project, tenant) || !isNodeVisibleToProject(target, project, tenant)) return;
        const relAttrs = attrs as RelationshipAttrs;
        contextEdges.push({
          source,
          target,
          predicate: relAttrs.predicate,
          weight: relAttrs.weight,
        });
      });

      return false;
    });
  }

  const entities = Array.from(visited).map(id => ({
    id,
    ...(getGraph().getNodeAttributes(id) as EntityAttrs),
  }));

  const markdown = toMarkdown({ entities, relationships: contextEdges, markdown: '' });
  const result: GraphContext = { entities, relationships: contextEdges, markdown };

  await cacheSet(cacheKey, result, CACHE_TTL_QUERY);
  return result;
}

function toMarkdown(ctx: GraphContext): string {
  if (ctx.entities.length === 0) return '';

  const lines: string[] = [];

  // Group relationships by source for summary
  const relsBySource = new Map<string, Array<{ predicate: string; target: string }>>();
  for (const rel of ctx.relationships) {
    const arr = relsBySource.get(rel.source) || [];
    arr.push({ predicate: rel.predicate, target: rel.target });
    relsBySource.set(rel.source, arr);
  }

  for (const entity of ctx.entities) {
    const attrs = entity as EntityAttrs & { id: string };
    lines.push(`## ${entity.id}`);
    lines.push(`**${attrs.type}** · ${attrs.mentions ?? 0} menções`);

    // Description is the most valuable context
    if (attrs.description) {
      lines.push('');
      lines.push(attrs.description);
    }

    // Show top relationships grouped by predicate (max 5 predicates, 3 targets each)
    const rels = relsBySource.get(entity.id) || [];
    if (rels.length > 0) {
      const grouped = new Map<string, string[]>();
      for (const r of rels) {
        const arr = grouped.get(r.predicate) || [];
        arr.push(r.target);
        grouped.set(r.predicate, arr);
      }
      lines.push('');
      let predCount = 0;
      for (const [pred, targets] of grouped) {
        if (predCount++ >= 5) break;
        const shown = targets.slice(0, 3);
        const extra = targets.length > 3 ? ` +${targets.length - 3}` : '';
        lines.push(`- **${pred}:** ${shown.join(', ')}${extra}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

export async function queryDecisions(context: string, project?: string, tenant: string = MASTER_TENANT): Promise<Array<DecisionAttrs & { id: string }>> {
  if (!ENABLED || !getGraph() || getGraph().order === 0) return [];

  const t = normalizeTenant(tenant) || MASTER_TENANT;
  const cacheKey = `decisions:${hashText(context)}:${t}:${project ? normalizeProject(project) : ''}`;
  const cached = await cacheGet<Array<DecisionAttrs & { id: string }>>(cacheKey);
  if (cached) return cached;

  const contextNorm = normalize(context);
  const contextWords = contextNorm.split(/\s+/).filter(w => w.length > 2);

  const decisions: Array<DecisionAttrs & { id: string; relevance: number }> = [];

  getGraph().forEachNode((nodeId, attrs) => {
    if (!isNodeVisibleToProject(nodeId, project, t)) return;
    const a = attrs as EntityAttrs;
    if (a.type !== 'Decision') return;

    const da = attrs as DecisionAttrs;

    // Score relevance by matching context words against decision fields
    let relevance = 0;
    const searchable = [
      nodeId,
      da.description || '',
      da.chosen || '',
      da.reasoning || '',
      ...(da.options || []),
      ...(da.criteria || []),
    ].join(' ').toLowerCase();

    for (const word of contextWords) {
      if (searchable.includes(word)) relevance += 1;
    }

    // Also check connected entities
    getGraph().forEachOutNeighbor(nodeId, (neighbor) => {
      if (!isNodeVisibleToProject(neighbor, project, t)) return;
      if (contextWords.some(w => neighbor.includes(w))) relevance += 0.5;
    });

    if (relevance > 0) {
      decisions.push({ id: nodeId, ...da, relevance });
    }
  });

  // Sort by relevance descending, then by recency
  decisions.sort((a, b) => b.relevance - a.relevance || b.lastSeen - a.lastSeen);

  // Return top 10 without the relevance field
  const result = decisions.slice(0, 10).map(({ relevance: _, ...rest }) => rest);
  await cacheSet(cacheKey, result, CACHE_TTL_DECISIONS);
  return result;
}
