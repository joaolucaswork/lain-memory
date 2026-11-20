/**
 * Ingest for graphrag (graphrag split G6).
 *
 * Text ingest (extract → upsert → auto-decision) and pre-extracted ingest.
 * Upserts come from the store, decisions from decisions.ts.
 */

import { shouldRejectEntity, shouldRejectRelationship } from '../graph-autoclean.js';
import {
  debouncedSave,
  ENABLED,
  getGraph,
  normalize,
  scopedId,
  upsertEntity,
  upsertRelationship,
} from './store.js';
import { invalidateGraphCache } from './cache.js';
import {
  containsDecisionLanguage,
  extractDecision,
  extractEntities,
} from './extract.js';
import { addDecision } from './decisions.js';
import type { EntityType, GraphIngestOpts } from './types.js';
import { MASTER_TENANT } from '../tenants.js';

// ─── Public API ───

export async function ingest(text: string, project?: string, opts?: GraphIngestOpts): Promise<{ entities: number; relationships: number }> {
  if (!ENABLED || !getGraph()) return { entities: 0, relationships: 0 };
  const tenant = opts?.tenant ?? MASTER_TENANT;

  try {
    const result = await extractEntities(text);
    const sourceIds = opts?.sourceIds;

    for (const entity of result.entities) {
      if (shouldRejectEntity(normalize(entity.name), entity.type)) continue;
      upsertEntity(entity.name, entity.type, entity.description, project, sourceIds, tenant);
    }

    for (const rel of result.relationships) {
      if (shouldRejectRelationship(normalize(rel.subject), rel.predicate, normalize(rel.object))) continue;
      const sourceId = scopedId(rel.subject, project, tenant);
      const targetId = scopedId(rel.object, project, tenant);
      if (!getGraph().hasNode(sourceId)) upsertEntity(rel.subject, 'Other', undefined, project, sourceIds, tenant);
      if (!getGraph().hasNode(targetId)) upsertEntity(rel.object, 'Other', undefined, project, sourceIds, tenant);
      upsertRelationship(sourceId, targetId, rel.predicate, sourceIds);
    }

    debouncedSave();
    invalidateGraphCache();
    console.log(`[graphrag] Ingested ${result.entities.length} entities, ${result.relationships.length} relationships`);

    // Auto-detect decisions in text
    if (containsDecisionLanguage(text)) {
      extractDecision(text).then(decision => {
        if (decision) {
          addDecision(decision, project, sourceIds, tenant).catch(err =>
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
  relationships: Array<{ subject: string; predicate: string; object: string }>,
  project?: string,
  opts?: GraphIngestOpts
): Promise<void> {
  if (!ENABLED || !getGraph()) return;
  const sourceIds = opts?.sourceIds;
  const tenant = opts?.tenant ?? MASTER_TENANT;

  // Per-tenant graph cap (second defense layer; the HTTP handler already
  // 429s). Budgets BOTH entity nodes and relationship endpoints (which
  // auto-create nodes below) — each unique new id counted once.
  let effectiveEntities = entities;
  let effectiveRelationships = relationships;
  if (tenant !== MASTER_TENANT) {
    const { TENANT_GRAPH_NODE_CAP } = await import('../tenants.js');
    const { normalizeTenant } = await import('../tenants.js');
    const base = `tn-${normalizeTenant(tenant)}`;
    let owned = 0;
    getGraph().forEachNode((key) => {
      const idx = key.indexOf('::');
      const scope = idx <= 0 ? null : key.slice(0, idx);
      if (scope === base || (scope && scope.startsWith(`${base}--`))) owned++;
    });
    const budget = TENANT_GRAPH_NODE_CAP - owned;
    if (budget <= 0) {
      throw new Error(`graph node cap reached (${TENANT_GRAPH_NODE_CAP} nodes) — remove nodes before ingesting more`);
    }
    // Claim each unique new id once; over-budget payload is dropped
    // (fail-closed, no partial overflow). Existing nodes always pass.
    const claimed = new Set<string>();
    const claim = (id: string): boolean => {
      if (!id || getGraph().hasNode(id) || claimed.has(id)) return true;
      if (claimed.size >= budget) return false;
      claimed.add(id);
      return true;
    };
    const scopedOrNull = (rawName: unknown): string | null => {
      if (typeof rawName !== 'string' || !rawName.trim()) return null;
      try {
        return scopedId(rawName, project, tenant);
      } catch {
        return null;
      }
    };
    effectiveEntities = [];
    for (const entity of entities) {
      if (shouldRejectEntity(normalize(entity.name), entity.type)) continue;
      const id = scopedOrNull(entity.name);
      if (!id || !claim(id)) continue;
      effectiveEntities.push(entity);
    }
    effectiveRelationships = [];
    for (const rel of relationships) {
      if (shouldRejectRelationship(normalize(rel.subject), rel.predicate, normalize(rel.object))) continue;
      const sId = scopedOrNull(rel.subject);
      const tId = scopedOrNull(rel.object);
      if (!sId || !tId) continue;
      if (!claim(sId) || !claim(tId)) continue;
      effectiveRelationships.push(rel);
    }
  }

  for (const entity of effectiveEntities) {
    if (shouldRejectEntity(normalize(entity.name), entity.type)) continue;
    upsertEntity(entity.name, entity.type as EntityType, entity.description, project, sourceIds, tenant);
  }

  for (const rel of effectiveRelationships) {
    if (shouldRejectRelationship(normalize(rel.subject), rel.predicate, normalize(rel.object))) continue;
    const sourceId = scopedId(rel.subject, project, tenant);
    const targetId = scopedId(rel.object, project, tenant);
    if (!getGraph().hasNode(sourceId)) upsertEntity(rel.subject, 'Other', undefined, project, sourceIds, tenant);
    if (!getGraph().hasNode(targetId)) upsertEntity(rel.object, 'Other', undefined, project, sourceIds, tenant);
    upsertRelationship(sourceId, targetId, rel.predicate, sourceIds);
  }

  debouncedSave();
  invalidateGraphCache();
}
