/**
 * GraphRAG — Lightweight knowledge graph augmenting Mem0.
 *
 * Uses Graphology (in-memory directed graph) with JSON file persistence.
 * Entity extraction via fast LLM (gpt-4o-mini, Claude CLI fallback) (fire-and-forget, async).
 * Augments Mem0 context on spawn and adds MCP tools for direct queries.
 */

import Graph from 'graphology';
import { bfsFromNode } from 'graphology-traversal';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { runFastLlmJson } from './llm-client.js';
import { KNOWLEDGE_DIR, INSTANCE_ID } from './workspace.js';
import { getConfig } from './config.js';
import { getRedis, isRedisAvailable } from './redis.js';
import { shouldRejectEntity, shouldRejectRelationship, sweepGraph, type SweepResult } from './graph-autoclean.js';
import { withDistributedLock } from './distributed-lock.js';

const GRAPH_FILENAME = INSTANCE_ID ? `graph-${INSTANCE_ID}.json` : 'graph.json';
const GRAPH_PATH = path.join(KNOWLEDGE_DIR, GRAPH_FILENAME);
const GRAPH_SCHEMA_VERSION = 1;
const MAX_CONTEXT_NODES = getConfig().graphrag.maxContextNodes;
const MAX_DEPTH = getConfig().graphrag.maxDepth;
const SAVE_DEBOUNCE_MS = getConfig().graphrag.saveDebounceMs;
const ENABLED = getConfig().graphrag.enabled;

// ─── Redis Cache ───

const CACHE_PREFIX = 'cache:graphrag:';
const CACHE_TTL_QUERY = 300;       // 5 min for query results
const CACHE_TTL_DECISIONS = 300;   // 5 min for decision queries
const CACHE_TTL_STATS = 60;        // 1 min for stats (changes often)
const CACHE_TTL_PGS = 300;         // 5 min for PGS export
const CACHE_TTL_EXTRACTION = 3600; // 1 hour for entity extraction (LLM calls — gpt-4o-mini)

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function cacheGet<T>(key: string): Promise<T | null> {
  if (!isRedisAvailable()) return null;
  try {
    const cached = await getRedis().get(`${CACHE_PREFIX}${key}`);
    if (cached !== null) return JSON.parse(cached);
  } catch {}
  return null;
}

async function cacheSet(key: string, value: unknown, ttl: number): Promise<void> {
  if (!isRedisAvailable()) return;
  getRedis().set(`${CACHE_PREFIX}${key}`, JSON.stringify(value), 'EX', ttl).catch(() => {});
}

export async function invalidateGraphCache(): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    const redis = getRedis();
    const p = INSTANCE_ID ? `lain:${INSTANCE_ID}:` : 'lain:';
    const stream = redis.scanStream({ match: `${p}${CACHE_PREFIX}*`, count: 100 });
    const keysToDelete: string[] = [];
    for await (const keys of stream) {
      keysToDelete.push(...(keys as string[]));
    }
    if (keysToDelete.length > 0) {
      const pipeline = redis.pipeline();
      for (const k of keysToDelete) {
        pipeline.del(k.slice(p.length));
      }
      await pipeline.exec();
    }
    console.log(`[graphrag] Cache invalidated (${keysToDelete.length} keys)`);
  } catch (err) {
    console.error('[graphrag] Cache invalidation error:', err);
  }
}

// ─── Types ───

export type EntityType = 'Person' | 'Project' | 'Technology' | 'Company' | 'Concept' | 'Location' | 'Decision' | 'Other';

export interface EntityAttrs {
  type: EntityType;
  description?: string;
  firstSeen: number;
  lastSeen: number;
  mentions: number;
}

export interface DecisionAttrs extends EntityAttrs {
  type: 'Decision';
  options: string[];
  criteria: string[];
  chosen: string;
  reasoning: string;
  confidence: number;
}

export interface DecisionInput {
  name: string;
  description: string;
  options: string[];
  criteria: string[];
  chosen: string;
  reasoning: string;
  confidence: number;
  relatedEntities?: Array<{ name: string; type: EntityType }>;
}

export interface RelationshipAttrs {
  predicate: string;
  weight: number;
  firstSeen: number;
  lastSeen: number;
}

interface GraphFile {
  version: number;
  exportedAt: number;
  graph: ReturnType<Graph['export']>;
}

export interface GraphContext {
  entities: Array<EntityAttrs & { id: string }>;
  relationships: Array<{ source: string; target: string; predicate: string; weight: number }>;
  markdown: string;
}

interface ExtractionResult {
  entities: Array<{ name: string; type: EntityType; description: string }>;
  relationships: Array<{ subject: string; predicate: string; object: string }>;
}

// ─── State ───

let graph: Graph;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function normalize(name: string): string {
  return name.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

// ─── Initialization & Persistence ───

export async function initGraph(): Promise<void> {
  if (!existsSync(KNOWLEDGE_DIR)) mkdirSync(KNOWLEDGE_DIR, { recursive: true });

  graph = new Graph({ type: 'directed', multi: false });

  if (existsSync(GRAPH_PATH)) {
    try {
      const file = await Bun.file(GRAPH_PATH).json() as GraphFile;
      if (file.version !== GRAPH_SCHEMA_VERSION) {
        console.warn(`[graphrag] Schema version mismatch: ${file.version} vs ${GRAPH_SCHEMA_VERSION}`);
      }
      graph.import(file.graph);
      console.log(`[graphrag] Loaded graph: ${graph.order} nodes, ${graph.size} edges`);
    } catch (err) {
      console.error('[graphrag] Failed to load graph, starting fresh:', err);
    }
  } else {
    console.log('[graphrag] No existing graph, starting fresh');
  }

  // Run autoclean on startup and every 6 hours
  setTimeout(() => withDistributedLock('graphrag:autoclean', 300_000, () => runAutoclean().then(() => {})).catch(console.error), 30_000);
  if (autocleanTimer) clearInterval(autocleanTimer);
  autocleanTimer = setInterval(() => withDistributedLock('graphrag:autoclean', 300_000, () => runAutoclean().then(() => {})).catch(console.error), 6 * 60 * 60 * 1000);

  // Graceful shutdown: flush pending saves before exit
  const gracefulShutdown = async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try { await saveGraph(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

async function saveGraph(): Promise<void> {
  const data: GraphFile = {
    version: GRAPH_SCHEMA_VERSION,
    exportedAt: Date.now(),
    graph: graph.export(),
  };
  await Bun.write(GRAPH_PATH, JSON.stringify(data, null, 2));
}

function debouncedSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveGraph().catch(err => console.error('[graphrag] Save error:', err));
  }, SAVE_DEBOUNCE_MS);
}

export function isGraphEnabled(): boolean {
  return ENABLED;
}

export async function cachedGetStats(): Promise<{ nodes: number; edges: number; types: Record<string, number> }> {
  const cached = await cacheGet<{ nodes: number; edges: number; types: Record<string, number> }>('stats');
  if (cached) return cached;
  const result = getStats();
  await cacheSet('stats', result, CACHE_TTL_STATS);
  return result;
}

export function getStats(): { nodes: number; edges: number; types: Record<string, number> } {
  if (!graph) return { nodes: 0, edges: 0, types: {} };
  const types: Record<string, number> = {};
  graph.forEachNode((_, attrs) => {
    const t = (attrs as EntityAttrs).type || 'Other';
    types[t] = (types[t] || 0) + 1;
  });
  return { nodes: graph.order, edges: graph.size, types };
}

// ─── Entity Extraction ───

const EXTRACTION_PROMPT = `Extract entities and relationships from this text about a user's work context.
Return ONLY valid JSON matching this schema:
{
  "entities": [{"name": "string", "type": "Person|Project|Technology|Company|Concept|Location|Other", "description": "string"}],
  "relationships": [{"subject": "string", "predicate": "string", "object": "string"}]
}

RULES — INCLUDE:
- Real people (colleagues, founders, users)
- Software projects, products, companies
- Tools, frameworks, libraries (e.g. "React", "Prisma", "Redis")
- High-level concepts (e.g. "Open Finance", "PIX", "GraphRAG")
- Locations, organizations

RULES — SKIP (do NOT extract these):
- Function names: getElapsed(), hasActiveWork(), handleVaultRequest()
- CLI flags: --dangerously-skip-permissions, --effort, cwd=/tmp
- Field names: memory_id, event_id, id_field
- Port numbers: port 3334, port 3333
- Git commits/branches: commit 89b569a, endurance, gabriel_changes
- Version strings: v8.0, v1.2.3
- Fictional characters, TV/movie/game content
- URL fragments, file paths, timestamps, IP addresses
- Vague meta-labels: "humanos (temporariamente)", "response format change", "documentation examples"
- Type "Other" unless clearly a real entity with lasting relevance
- System UI elements (menu bars, notifications, window titles)

Entity names must be human-readable. If unsure, skip it.
Description must be non-empty and explain WHY this entity matters to the user's work.

Predicate vocabulary: WORKS_ON, USES, OWNS, MANAGES, DEPENDS_ON, RELATED_TO, LOCATED_IN, PART_OF, CREATED, PREFERS, DECIDED_FOR, DECIDED_AGAINST

Text: `;

async function extractEntities(text: string): Promise<ExtractionResult> {
  const cacheKey = `extraction:${hashText(text)}`;

  // Check cache first (OpenAI calls are billed per token)
  const cached = await cacheGet<ExtractionResult>(cacheKey);
  if (process.env.LAIN_BENCH === '1') {
    console.log(JSON.stringify({
      tag: '[bench]', ts: Date.now(), file: 'graphrag',
      func: 'extractEntities', cache_hit: !!cached,
    }));
  }
  if (cached) return cached;

  try {
    // Bounded generation: entity JSON is small; the cap bounds worst-case
    // latency on the remember path (truncation falls through to empty below).
    const result = await runFastLlmJson<ExtractionResult>(EXTRACTION_PROMPT + text, { maxTokens: 2048 });
    await cacheSet(cacheKey, result, CACHE_TTL_EXTRACTION);
    return result;
  } catch (err) {
    console.error('[graphrag] Entity extraction failed:', err instanceof Error ? err.message : err);
    return { entities: [], relationships: [] };
  }
}

// ─── Graph Mutations ───

function upsertEntity(name: string, type: EntityType, description?: string): string {
  const id = normalize(name);
  const now = Date.now();

  if (graph.hasNode(id)) {
    const attrs = graph.getNodeAttributes(id) as EntityAttrs;
    attrs.lastSeen = now;
    attrs.mentions += 1;
    if (description && (!attrs.description || description.length > attrs.description.length)) {
      attrs.description = description;
    }
    graph.replaceNodeAttributes(id, attrs);
  } else {
    graph.addNode(id, {
      type,
      description,
      firstSeen: now,
      lastSeen: now,
      mentions: 1,
    } as EntityAttrs);
  }

  return id;
}

function upsertRelationship(sourceId: string, targetId: string, predicate: string): void {
  const now = Date.now();
  const edgeKey = `${sourceId}-${predicate}-${targetId}`;

  if (graph.hasEdge(edgeKey)) {
    const attrs = graph.getEdgeAttributes(edgeKey) as RelationshipAttrs;
    attrs.weight += 1;
    attrs.lastSeen = now;
    graph.replaceEdgeAttributes(edgeKey, attrs);
  } else {
    if (!graph.hasNode(sourceId) || !graph.hasNode(targetId)) return;
    // Non-multi graph: check if any edge already links these nodes (different predicate)
    if (graph.hasEdge(sourceId, targetId)) {
      const existingEdge = graph.edge(sourceId, targetId)!;
      const attrs = graph.getEdgeAttributes(existingEdge) as RelationshipAttrs;
      attrs.weight += 1;
      attrs.lastSeen = now;
      graph.replaceEdgeAttributes(existingEdge, attrs);
      return;
    }
    graph.addEdgeWithKey(edgeKey, sourceId, targetId, {
      predicate,
      weight: 1,
      firstSeen: now,
      lastSeen: now,
    } as RelationshipAttrs);
  }
}

// ─── Public API ───

export async function ingest(text: string, _project?: string): Promise<{ entities: number; relationships: number }> {
  if (!ENABLED || !graph) return { entities: 0, relationships: 0 };

  try {
    const result = await extractEntities(text);

    for (const entity of result.entities) {
      if (shouldRejectEntity(normalize(entity.name), entity.type)) continue;
      upsertEntity(entity.name, entity.type, entity.description);
    }

    for (const rel of result.relationships) {
      const sourceId = normalize(rel.subject);
      const targetId = normalize(rel.object);
      if (shouldRejectRelationship(sourceId, rel.predicate, targetId)) continue;
      if (!graph.hasNode(sourceId)) upsertEntity(rel.subject, 'Other');
      if (!graph.hasNode(targetId)) upsertEntity(rel.object, 'Other');
      upsertRelationship(sourceId, targetId, rel.predicate);
    }

    debouncedSave();
    invalidateGraphCache();
    console.log(`[graphrag] Ingested ${result.entities.length} entities, ${result.relationships.length} relationships`);

    // Auto-detect decisions in text
    if (containsDecisionLanguage(text)) {
      extractDecision(text).then(decision => {
        if (decision) {
          addDecision(decision).catch(err =>
            console.error('[graphrag] Auto-decision extraction error:', err)
          );
        }
      }).catch(err => {
        console.error('[graphrag] Decision extraction error:', err);
      });
    }

    return { entities: result.entities.length, relationships: result.relationships.length };
  } catch (err) {
    console.error('[graphrag] Extraction error:', err);
    return { entities: 0, relationships: 0 };
  }
}

export async function ingestExtracted(
  entities: Array<{ name: string; type: string; description: string }>,
  relationships: Array<{ subject: string; predicate: string; object: string }>
): Promise<void> {
  if (!ENABLED || !graph) return;

  for (const entity of entities) {
    if (shouldRejectEntity(normalize(entity.name), entity.type)) continue;
    upsertEntity(entity.name, entity.type as EntityType, entity.description);
  }

  for (const rel of relationships) {
    const sourceId = normalize(rel.subject);
    const targetId = normalize(rel.object);
    if (shouldRejectRelationship(sourceId, rel.predicate, targetId)) continue;
    if (!graph.hasNode(sourceId)) upsertEntity(rel.subject, 'Other');
    if (!graph.hasNode(targetId)) upsertEntity(rel.object, 'Other');
    upsertRelationship(sourceId, targetId, rel.predicate);
  }

  debouncedSave();
  invalidateGraphCache();
}

export async function query(
  queryText: string,
  opts?: { maxDepth?: number; maxNodes?: number }
): Promise<GraphContext> {
  if (!ENABLED || !graph || graph.order === 0) {
    return { entities: [], relationships: [], markdown: '' };
  }

  const maxDepth = opts?.maxDepth ?? MAX_DEPTH;
  const maxNodes = opts?.maxNodes ?? MAX_CONTEXT_NODES;
  const cacheKey = `query:${hashText(queryText)}:${maxDepth}:${maxNodes}`;

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
  graph.forEachNode((nodeId) => {
    const matchCount = queryWords.filter(w => nodeId.includes(w)).length;
    if (matchCount >= minMatches) {
      matchingNodes.push(nodeId);
    }
  });

  if (matchingNodes.length === 0) {
    return { entities: [], relationships: [], markdown: '' };
  }

  // BFS traversal from matching nodes
  const visited = new Set<string>();
  const contextEdges: Array<{ source: string; target: string; predicate: string; weight: number }> = [];

  for (const startNode of matchingNodes) {
    if (visited.size >= maxNodes) break;

    bfsFromNode(graph, startNode, (node, _attrs, depth) => {
      if (depth > maxDepth || visited.size >= maxNodes) return true;
      visited.add(node);

      graph.forEachOutEdge(node, (_edge, attrs, source, target) => {
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
    ...(graph.getNodeAttributes(id) as EntityAttrs),
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

// ─── Decision Framework ───

export async function addDecision(decision: DecisionInput): Promise<string> {
  if (!ENABLED || !graph) return '';

  const id = normalize(decision.name);
  const now = Date.now();

  const attrs: DecisionAttrs = {
    type: 'Decision',
    description: decision.description,
    options: decision.options,
    criteria: decision.criteria,
    chosen: decision.chosen,
    reasoning: decision.reasoning,
    confidence: Math.max(0, Math.min(1, decision.confidence)),
    firstSeen: now,
    lastSeen: now,
    mentions: 1,
  };

  if (graph.hasNode(id)) {
    graph.replaceNodeAttributes(id, attrs);
  } else {
    graph.addNode(id, attrs);
  }

  // Create DECIDED_FOR edge to the chosen option
  const chosenId = upsertEntity(decision.chosen, 'Concept');
  upsertRelationship(id, chosenId, 'DECIDED_FOR');

  // Create DECIDED_AGAINST edges to rejected options
  for (const option of decision.options) {
    if (option !== decision.chosen) {
      const optionId = upsertEntity(option, 'Concept');
      upsertRelationship(id, optionId, 'DECIDED_AGAINST');
    }
  }

  // Link to related entities
  if (decision.relatedEntities) {
    for (const related of decision.relatedEntities) {
      const relatedId = upsertEntity(related.name, related.type);
      upsertRelationship(id, relatedId, 'RELATED_TO');
    }
  }

  debouncedSave();
  invalidateGraphCache();
  console.log(`[graphrag] Added decision: ${decision.name} → chose "${decision.chosen}"`);
  return id;
}

export async function queryDecisions(context: string): Promise<Array<DecisionAttrs & { id: string }>> {
  if (!ENABLED || !graph || graph.order === 0) return [];

  const cacheKey = `decisions:${hashText(context)}`;
  const cached = await cacheGet<Array<DecisionAttrs & { id: string }>>(cacheKey);
  if (cached) return cached;

  const contextNorm = normalize(context);
  const contextWords = contextNorm.split(/\s+/).filter(w => w.length > 2);

  const decisions: Array<DecisionAttrs & { id: string; relevance: number }> = [];

  graph.forEachNode((nodeId, attrs) => {
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
    graph.forEachOutNeighbor(nodeId, (neighbor) => {
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

// ─── Decision Auto-Detection ───

const DECISION_PATTERNS = [
  /\b(decidimos|decidiu|decidi)\b/i,
  /\b(escolhemos|escolheu|escolhi)\b/i,
  /\b(optamos|optou|optei)\b/i,
  /\b(we decided|i decided|decided to)\b/i,
  /\b(we chose|i chose|chose to)\b/i,
  /\b(we opted|i opted|opted for)\b/i,
  /\b(went with|going with)\b/i,
  /\b(picked|selected)\b/i,
];

const DECISION_EXTRACTION_PROMPT = `Extract the decision from this text. Return ONLY valid JSON:
{
  "name": "short decision title",
  "description": "what was being decided",
  "options": ["option1", "option2"],
  "criteria": ["criterion1", "criterion2"],
  "chosen": "the chosen option",
  "reasoning": "why this was chosen",
  "confidence": 0.8,
  "relatedEntities": [{"name": "entity", "type": "Person|Project|Technology|Company|Concept|Location|Other"}]
}

If you cannot extract a clear decision, return {"skip": true}.

Text: `;

function containsDecisionLanguage(text: string): boolean {
  return DECISION_PATTERNS.some(pattern => pattern.test(text));
}

async function extractDecision(text: string): Promise<DecisionInput | null> {
  try {
    const result = await runFastLlmJson<DecisionInput & { skip?: boolean }>(DECISION_EXTRACTION_PROMPT + text, { maxTokens: 2048 });
    if ('skip' in result && result.skip) return null;
    if (!result.name || !result.chosen) return null;
    return {
      name: result.name,
      description: result.description || '',
      options: result.options || [result.chosen],
      criteria: result.criteria || [],
      chosen: result.chosen,
      reasoning: result.reasoning || '',
      confidence: result.confidence ?? 0.5,
      relatedEntities: result.relatedEntities,
    };
  } catch (err) {
    console.error('[graphrag] Extract decision error:', err);
    return null;
  }
}

// ─── Entity Resolution (Patch 3) ───

/**
 * Compute similarity between two normalized entity IDs.
 * Returns 0-1 where 1 = identical.
 */
function entitySimilarity(a: string, b: string): number {
  if (a === b) return 1;
  // One contains the other (e.g., "lucas" and "lucas tomaz")
  if (a.includes(b) || b.includes(a)) return 0.8;
  // Bigram overlap (Dice coefficient)
  const bigramsA = new Set<string>();
  const bigramsB = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
  let intersection = 0;
  for (const bg of bigramsA) { if (bigramsB.has(bg)) intersection++; }
  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/**
 * Resolve duplicate entities in the graph.
 * Merges entities that likely refer to the same thing:
 * - Same type + high name similarity (>0.75)
 * - Transfers edges from duplicates to canonical entity
 * Returns number of entities merged.
 */
export async function resolveEntities(threshold = 0.75): Promise<{ merged: number; pairs: string[][] }> {
  if (!ENABLED || !graph || graph.order < 2) return { merged: 0, pairs: [] };

  const nodes = graph.mapNodes((key, attrs) => ({
    key,
    attrs: attrs as EntityAttrs,
  }));

  // Group by type for faster comparison
  const byType = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const type = node.attrs.type || 'Other';
    const group = byType.get(type) || [];
    group.push(node);
    byType.set(type, group);
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
          const cAttrs = graph.getNodeAttributes(canonical.key) as EntityAttrs;
          const dAttrs = graph.getNodeAttributes(duplicate.key) as EntityAttrs;
          cAttrs.mentions += dAttrs.mentions;
          cAttrs.firstSeen = Math.min(cAttrs.firstSeen, dAttrs.firstSeen);
          cAttrs.lastSeen = Math.max(cAttrs.lastSeen, dAttrs.lastSeen);
          if (dAttrs.description && (!cAttrs.description || dAttrs.description.length > cAttrs.description.length)) {
            cAttrs.description = dAttrs.description;
          }
          graph.replaceNodeAttributes(canonical.key, cAttrs);

          // Transfer edges from duplicate to canonical
          graph.forEachEdge(duplicate.key, (edge, attrs, source, target) => {
            const newSource = source === duplicate.key ? canonical.key : source;
            const newTarget = target === duplicate.key ? canonical.key : target;
            const edgeKey = `${newSource}-${(attrs as RelationshipAttrs).predicate}-${newTarget}`;
            if (!graph.hasEdge(edgeKey) && newSource !== newTarget) {
              try {
                graph.addEdgeWithKey(edgeKey, newSource, newTarget, attrs);
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
    try { graph.dropNode(key); } catch { /* already removed */ }
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
  if (!graph || graph.order <= maxNodes) return 0;

  const nodes = graph.mapNodes((key, attrs) => {
    const a = attrs as EntityAttrs;
    const daysSinceLastSeen = (Date.now() - (a.lastSeen || 0)) / 86400000;
    return {
      key,
      score: (a.mentions || 1) / (1 + daysSinceLastSeen),
    };
  });

  nodes.sort((a, b) => a.score - b.score);
  const toRemove = nodes.slice(0, graph.order - maxNodes);
  for (const { key } of toRemove) graph.dropNode(key);
  await saveGraph();
  await invalidateGraphCache();
  return toRemove.length;
}

// ─── Autoclean ───

let autocleanTimer: ReturnType<typeof setInterval> | null = null;

export async function runAutoclean(): Promise<SweepResult> {
  if (!graph) return { orphansRemoved: 0, patternRemoved: 0, staleRemoved: 0, total: 0 };
  const start = Date.now();
  const result = sweepGraph(graph);
  const duration = Date.now() - start;
  if (result.total > 0) {
    await saveGraph();
    await invalidateGraphCache();
    console.log(`[graphrag] Autoclean: removed ${result.total} nodes (${result.orphansRemoved} orphans, ${result.patternRemoved} pattern, ${result.staleRemoved} stale)`);
  }
  try {
    const { logMaintenance } = await import('./maintenance-log.js');
    logMaintenance('graph_autoclean', {
      orphansRemoved: result.orphansRemoved,
      patternRemoved: result.patternRemoved,
      staleRemoved: result.staleRemoved,
      total: result.total,
      graphNodes: graph?.order ?? 0,
    }, duration);
  } catch { /* non-critical */ }
  return result;
}

/**
 * Remove specific nodes (and all their edges) from the graph.
 * Returns the list of nodes actually removed.
 */
export async function removeNodes(nodeIds: string[]): Promise<string[]> {
  if (!graph) return [];
  const removed: string[] = [];
  for (const id of nodeIds) {
    const key = normalize(id);
    if (graph.hasNode(key)) {
      graph.dropNode(key);
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
  targets?: string[]
): Promise<number> {
  if (!graph) return 0;
  const srcKey = normalize(source);
  if (!graph.hasNode(srcKey)) return 0;

  const toRemove: string[] = [];
  graph.forEachOutEdge(srcKey, (edge, attrs, _src, tgt) => {
    const relAttrs = attrs as RelationshipAttrs;
    if (predicates && !predicates.includes(relAttrs.predicate)) return;
    if (targets && !targets.includes(tgt)) return;
    toRemove.push(edge);
  });

  for (const edge of toRemove) {
    try { graph.dropEdge(edge); } catch { /* already removed */ }
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
 */
export function listAllNodes(): Array<{ id: string; type: string; mentions: number; edgeCount: number }> {
  if (!graph) return [];
  return graph.mapNodes((key, attrs) => {
    const a = attrs as EntityAttrs;
    return {
      id: key,
      type: a.type || 'Other',
      mentions: a.mentions || 0,
      edgeCount: graph!.degree(key),
    };
  });
}

// ─── PGS Integration ───

/**
 * Export graph data in PGS-compatible format.
 * Maps entity descriptions to `concept` field for PGS consumption.
 */
export async function cachedGetGraphForPGS(): Promise<ReturnType<typeof getGraphForPGS>> {
  const cached = await cacheGet<ReturnType<typeof getGraphForPGS>>('pgs');
  if (cached) return cached;
  const result = getGraphForPGS();
  await cacheSet('pgs', result, CACHE_TTL_PGS);
  return result;
}

export function getGraphForPGS(): {
  nodes: Array<{ id: string; concept: string; tag: string; weight: number }>;
  edges: Array<{ source: string; target: string; weight: number }>;
} {
  if (!graph || graph.order === 0) {
    return { nodes: [], edges: [] };
  }

  const nodes: Array<{ id: string; concept: string; tag: string; weight: number }> = [];
  graph.forEachNode((nodeId, attrs) => {
    const a = attrs as EntityAttrs;
    nodes.push({
      id: nodeId,
      concept: a.description || nodeId,
      tag: a.type || 'Other',
      weight: Math.min(1, (a.mentions || 1) / 10),
    });
  });

  const edges: Array<{ source: string; target: string; weight: number }> = [];
  graph.forEachEdge((_edge, attrs, source, target) => {
    const a = attrs as RelationshipAttrs;
    edges.push({
      source,
      target,
      weight: a.weight || 1,
    });
  });

  return { nodes, edges };
}
