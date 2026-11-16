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

// ─── Public API ───

export async function ingest(text: string, project?: string, opts?: GraphIngestOpts): Promise<{ entities: number; relationships: number }> {
  if (!ENABLED || !getGraph()) return { entities: 0, relationships: 0 };

  try {
    const result = await extractEntities(text);
    const sourceIds = opts?.sourceIds;

    for (const entity of result.entities) {
      if (shouldRejectEntity(normalize(entity.name), entity.type)) continue;
      upsertEntity(entity.name, entity.type, entity.description, project, sourceIds);
    }

    for (const rel of result.relationships) {
      if (shouldRejectRelationship(normalize(rel.subject), rel.predicate, normalize(rel.object))) continue;
      const sourceId = scopedId(rel.subject, project);
      const targetId = scopedId(rel.object, project);
      if (!getGraph().hasNode(sourceId)) upsertEntity(rel.subject, 'Other', undefined, project, sourceIds);
      if (!getGraph().hasNode(targetId)) upsertEntity(rel.object, 'Other', undefined, project, sourceIds);
      upsertRelationship(sourceId, targetId, rel.predicate, sourceIds);
    }

    debouncedSave();
    invalidateGraphCache();
    console.log(`[graphrag] Ingested ${result.entities.length} entities, ${result.relationships.length} relationships`);

    // Auto-detect decisions in text
    if (containsDecisionLanguage(text)) {
      extractDecision(text).then(decision => {
        if (decision) {
          addDecision(decision, project, sourceIds).catch(err =>
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

  for (const entity of entities) {
    if (shouldRejectEntity(normalize(entity.name), entity.type)) continue;
    upsertEntity(entity.name, entity.type as EntityType, entity.description, project, sourceIds);
  }

  for (const rel of relationships) {
    if (shouldRejectRelationship(normalize(rel.subject), rel.predicate, normalize(rel.object))) continue;
    const sourceId = scopedId(rel.subject, project);
    const targetId = scopedId(rel.object, project);
    if (!getGraph().hasNode(sourceId)) upsertEntity(rel.subject, 'Other', undefined, project, sourceIds);
    if (!getGraph().hasNode(targetId)) upsertEntity(rel.object, 'Other', undefined, project, sourceIds);
    upsertRelationship(sourceId, targetId, rel.predicate, sourceIds);
  }

  debouncedSave();
  invalidateGraphCache();
}
