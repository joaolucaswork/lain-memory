/**
 * Graph store (graphrag split G2).
 *
 * Owns the graphology singleton, JSON persistence, id helpers (normalize,
 * scoping, visibility, similarity), and the primitive upserts. Sibling
 * modules access the graph via getGraph() — never a second instance.
 * initGraph schedules the autoclean via lazy import so the dependency stays
 * one-directional (resolve → store).
 */

import Graph from 'graphology';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { KNOWLEDGE_DIR, INSTANCE_ID } from '../workspace.js';
import { getConfig } from '../config.js';
import { withDistributedLock } from '../distributed-lock.js';
import { MASTER_TENANT, normalizeTenant } from '../tenants.js';
import type {
  EntityAttrs,
  EntityType,
  RelationshipAttrs,
} from './types.js';

const GRAPH_FILENAME = INSTANCE_ID ? `graph-${INSTANCE_ID}.json` : 'graph.json';
const GRAPH_PATH = path.join(KNOWLEDGE_DIR, GRAPH_FILENAME);
const GRAPH_SCHEMA_VERSION = 1;
export const MAX_CONTEXT_NODES = getConfig().graphrag.maxContextNodes;
export const MAX_DEPTH = getConfig().graphrag.maxDepth;
const SAVE_DEBOUNCE_MS = getConfig().graphrag.saveDebounceMs;
export const ENABLED = getConfig().graphrag.enabled;

interface GraphFile {
  version: number;
  exportedAt: number;
  graph: ReturnType<Graph['export']>;
}

// ─── State ───

let graph: Graph;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let autocleanTimer: ReturnType<typeof setInterval> | null = null;

/** The singleton. Undefined until initGraph() runs (same contract as before). */
export function getGraph(): Graph {
  return graph;
}

export function normalize(name: string): string {
  return name.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

// ─── Project scope (Fase 2) ───
//
// Policy v1 (mirrors Mem0's userId scheme `lucas` vs `lucas:project`):
// - ingest WITHOUT project → GLOBAL nodes (bare normalized ids), visible everywhere.
// - ingest WITH project P → LOCAL nodes (`p::name`), visible only to queries
//   with project P (plus global nodes, which are always visible).
// - No cross-scope edges in v1: every ingest scopes all endpoints uniformly.
// - Legacy bare ids (pre-scope data) read as GLOBAL: no rewrite, rollback-safe.
// - Promotion local→global is explicitly out of scope for v1.

export const SCOPE_SEPARATOR = '::';

/**
 * Tenant scope prefix. Master (`lucas`) has none — its nodes keep the legacy
 * `project::name` / bare shape byte-identical. Every other tenant gets
 * `tn-<slug>` so its nodes can never collide with (or leak into) another
 * scope. The `tn-` prefix is reserved: a lucas project literally named
 * `tn-...` would share that scope (documented, no such project exists).
 */
export function tenantBase(tenant: string | undefined): string | null {
  const t = normalizeTenant(tenant ?? MASTER_TENANT) || MASTER_TENANT;
  if (t === MASTER_TENANT) return null;
  return `tn-${t}`;
}

/**
 * Combined scope for a (tenant, project) pair. Master reproduces the legacy
 * scheme (`project` or undefined); other tenants get `tn-<slug>` (global) or
 * `tn-<slug>--<project>` (project-local). The `--` join keeps the scope a
 * single `::`-free segment, so nodeProject() keeps working unchanged.
 */
export function tenantScope(tenant: string | undefined, project?: string): string | undefined {
  const base = tenantBase(tenant);
  if (!base) return project ? normalizeProject(project) : undefined;
  if (!project) return base;
  return `${base}--${normalizeProject(project)}`;
}

export function normalizeProject(project: string): string {
  return normalize(project).replace(/\s+/g, '-');
}

/** Scoped node id. Preserves already-qualified ids (idempotent). */
export function scopedId(name: string, project?: string, tenant: string = MASTER_TENANT): string {
  const normalized = normalize(name);
  const scope = tenantScope(tenant, project);
  if (!scope) return normalized;
  if (normalized.startsWith(`${scope}${SCOPE_SEPARATOR}`)) return normalized;
  return `${scope}${SCOPE_SEPARATOR}${normalized}`;
}

/** Project prefix of a node id, or undefined for global/legacy nodes. */
export function nodeProject(id: string): string | undefined {
  const idx = id.indexOf(SCOPE_SEPARATOR);
  if (idx <= 0) return undefined;
  return id.slice(0, idx) || undefined;
}

/**
 * Visibility rule (explicit contract — Opção 2: compatibilidade documentada).
 * - Scoped read (project P) as master: global nodes + P's local nodes. Never
 *   another project's locals — and never another tenant's nodes (their
 *   `tn-...` scopes never equal a project name; the `tn-` prefix is reserved).
 * - Unscoped read (no project) as master: EVERYTHING (legacy/admin behavior).
 * - Non-master tenant T: only `tn-T` nodes (its global `tn-T` + its
 *   `tn-T--P` project nodes when P is given). Legacy bare globals are
 *   lucas's data — invisible. Boundary-checked (`tn-T` + `--`), so tenant
 *   `ana` never sees tenant `ana2`'s nodes.
 * - Explicit all-projects read (project '*'): same as unscoped for that tenant.
 */
export function isNodeVisibleToProject(id: string, project?: string, tenant: string = MASTER_TENANT): boolean {
  const t = normalizeTenant(tenant) || MASTER_TENANT;
  if (t === MASTER_TENANT) {
    if (!project || project === '*') return true;
    const scope = nodeProject(id);
    if (!scope) return true;
    return scope === normalizeProject(project);
  }
  const scope = nodeProject(id);
  const base = `tn-${t}`;
  if (!scope) return false;
  if (scope !== base && !scope.startsWith(`${base}--`)) return false;
  if (!project || project === '*') return true;
  return scope === base || scope === `${base}--${normalizeProject(project)}`;
}

/** Resolve user input (bare or qualified) to a stored node id. */
export function resolveNodeId(input: string, project?: string, tenant: string = MASTER_TENANT): string {
  const normalized = normalize(input);
  if (normalized.includes(SCOPE_SEPARATOR)) return normalized;
  return scopedId(normalized, project, tenant);
}

/**
 * Compute similarity between two normalized entity IDs.
 * Returns 0-1 where 1 = identical.
 */
export function entitySimilarity(a: string, b: string): number {
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

// ─── Initialization & Persistence ───

/** Autoclean runner. Lazy so store never statically imports resolve (resolve → store). */
async function scheduleAutocleanTick(): Promise<void> {
  try {
    const { runAutoclean } = (await import('./resolve.js' as string)) as {
      runAutoclean: () => Promise<unknown>;
    };
    await withDistributedLock('graphrag:autoclean', 300_000, () => runAutoclean().then(() => {}));
  } catch (err) {
    console.error(err);
  }
}

export async function initGraph(): Promise<void> {
  if (!existsSync(KNOWLEDGE_DIR)) mkdirSync(KNOWLEDGE_DIR, { recursive: true });

  graph = new Graph({ type: 'directed', multi: true });

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
  setTimeout(() => scheduleAutocleanTick().catch(console.error), 30_000);
  if (autocleanTimer) clearInterval(autocleanTimer);
  autocleanTimer = setInterval(() => scheduleAutocleanTick().catch(console.error), 6 * 60 * 60 * 1000);

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

export async function saveGraph(): Promise<void> {
  const data: GraphFile = {
    version: GRAPH_SCHEMA_VERSION,
    exportedAt: Date.now(),
    graph: graph.export(),
  };
  await Bun.write(GRAPH_PATH, JSON.stringify(data, null, 2));
}

export function debouncedSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveGraph().catch(err => console.error('[graphrag] Save error:', err));
  }, SAVE_DEBOUNCE_MS);
}

export function isGraphEnabled(): boolean {
  return ENABLED;
}

export function getStats(project?: string, tenant: string = MASTER_TENANT): { nodes: number; edges: number; types: Record<string, number> } {
  if (!graph) return { nodes: 0, edges: 0, types: {} };
  const types: Record<string, number> = {};
  let nodes = 0;
  graph.forEachNode((key, attrs) => {
    if (!isNodeVisibleToProject(key, project, tenant)) return;
    nodes++;
    const t = (attrs as EntityAttrs).type || 'Other';
    types[t] = (types[t] || 0) + 1;
  });
  let edges = 0;
  graph.forEachEdge((_edge, _attrs, source, target) => {
    if (isNodeVisibleToProject(source, project, tenant) && isNodeVisibleToProject(target, project, tenant)) edges++;
  });
  return { nodes, edges, types };
}

// ─── Primitive upserts (graph ops — no LLM, no I/O) ───

export function upsertEntity(name: string, type: EntityType, description?: string, project?: string, sourceIds?: string[], tenant: string = MASTER_TENANT): string {
  const id = scopedId(name, project, tenant);
  const now = Date.now();

  if (graph.hasNode(id)) {
    const attrs = graph.getNodeAttributes(id) as EntityAttrs;
    attrs.lastSeen = now;
    attrs.mentions += 1;
    if (description && (!attrs.description || description.length > attrs.description.length)) {
      attrs.description = description;
    }
    const merged = mergeSources(attrs.sources, sourceIds);
    if (merged) attrs.sources = merged;
    graph.replaceNodeAttributes(id, attrs);
  } else {
    graph.addNode(id, {
      type,
      description,
      firstSeen: now,
      lastSeen: now,
      mentions: 1,
      ...(sourceIds && sourceIds.length > 0 ? { sources: [...new Set(sourceIds)] } : {}),
    } as EntityAttrs);
  }

  return id;
}

export function mergeSources(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  if (!existing && !incoming) return undefined;
  const set = new Set([...(existing ?? []), ...(incoming ?? [])]);
  return [...set];
}
/**
 * Identity of a relationship: source + predicate + target.
 * Same nodes with different predicates are distinct relationships
 * and must not be merged. The key format preserves existing
 * single-predicate edges so persisted graphs remain readable.
 */
export function relationshipKey(sourceId: string, targetId: string, predicate: string): string {
  return `${sourceId}-${predicate}-${targetId}`;
}

export function upsertRelationship(sourceId: string, targetId: string, predicate: string, sourceIds?: string[]): void {
  const now = Date.now();
  const edgeKey = relationshipKey(sourceId, targetId, predicate);

  if (graph.hasEdge(edgeKey)) {
    const attrs = graph.getEdgeAttributes(edgeKey) as RelationshipAttrs;
    attrs.weight += 1;
    attrs.lastSeen = now;
    const merged = mergeSources(attrs.sources, sourceIds);
    if (merged) attrs.sources = merged;
    graph.replaceEdgeAttributes(edgeKey, attrs);
  } else {
    if (!graph.hasNode(sourceId) || !graph.hasNode(targetId)) return;
    graph.addEdgeWithKey(edgeKey, sourceId, targetId, {
      predicate,
      weight: 1,
      firstSeen: now,
      lastSeen: now,
      ...(sourceIds && sourceIds.length > 0 ? { sources: [...new Set(sourceIds)] } : {}),
    } as RelationshipAttrs);
  }
}
