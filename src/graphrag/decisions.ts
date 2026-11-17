/**
 * Decisions for graphrag (graphrag split G5).
 *
 * addDecision: explicit decision nodes with DECIDED_FOR/AGAINST edges.
 * Upserts come from the store — no cycle with ingest.
 */

import {
  debouncedSave,
  ENABLED,
  getGraph,
  mergeSources,
  scopedId,
  upsertEntity,
  upsertRelationship,
} from './store.js';
import { invalidateGraphCache } from './cache.js';
import { MASTER_TENANT } from '../tenants.js';
import type { DecisionAttrs, DecisionInput, EntityAttrs } from './types.js';

// ─── Decision Framework ───

export async function addDecision(decision: DecisionInput, project?: string, sourceIds?: string[], tenant: string = MASTER_TENANT): Promise<string> {
  if (!ENABLED || !getGraph()) return '';

  const id = scopedId(decision.name, project, tenant);
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
    ...(sourceIds && sourceIds.length > 0 ? { sources: [...new Set(sourceIds)] } : {}),
  };

  if (getGraph().hasNode(id)) {
    const prev = getGraph().getNodeAttributes(id) as EntityAttrs;
    const merged = mergeSources(prev.sources, sourceIds);
    if (merged) attrs.sources = merged;
    getGraph().replaceNodeAttributes(id, attrs);
  } else {
    getGraph().addNode(id, attrs);
  }

  // Create DECIDED_FOR edge to the chosen option
  const chosenId = upsertEntity(decision.chosen, 'Concept', undefined, project, sourceIds, tenant);
  upsertRelationship(id, chosenId, 'DECIDED_FOR', sourceIds);

  // Create DECIDED_AGAINST edges to rejected options
  for (const option of decision.options) {
    if (option !== decision.chosen) {
      const optionId = upsertEntity(option, 'Concept', undefined, project, sourceIds, tenant);
      upsertRelationship(id, optionId, 'DECIDED_AGAINST', sourceIds);
    }
  }

  // Link to related entities
  if (decision.relatedEntities) {
    for (const related of decision.relatedEntities) {
      const relatedId = upsertEntity(related.name, related.type, undefined, project, sourceIds, tenant);
      upsertRelationship(id, relatedId, 'RELATED_TO', sourceIds);
    }
  }

  debouncedSave();
  invalidateGraphCache();
  console.log(`[graphrag] Added decision: ${decision.name} → chose "${decision.chosen}"`);
  return id;
}
