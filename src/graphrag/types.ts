/**
 * Graph domain types (graphrag split G1).
 *
 * Pure type declarations — no runtime code. Every graphrag module imports
 * from here; graphrag.ts re-exports everything for external importers.
 */

export type EntityType = 'Person' | 'Project' | 'Technology' | 'Company' | 'Concept' | 'Location' | 'Decision' | 'Medication' | 'HealthCondition' | 'Food' | 'Other';

export interface EntityAttrs {
  type: EntityType;
  description?: string;
  firstSeen: number;
  lastSeen: number;
  mentions: number;
  /**
   * Fase 3 — proveniência: Mem0 IDs whose ingestion created/touched this
   * entity. Undefined = legacy/pre-provenance data (never pruned for lack
   * of sources). Defined = derived projection, safe to prune when empty.
   */
  sources?: string[];
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
  /** Fase 3 — proveniência: see EntityAttrs.sources. */
  sources?: string[];
}

export interface GraphContext {
  entities: Array<EntityAttrs & { id: string }>;
  relationships: Array<{ source: string; target: string; predicate: string; weight: number }>;
  markdown: string;
}

export interface GraphIngestOpts {
  /** Mem0 IDs that originated this content (Fase 3 proveniência). */
  sourceIds?: string[];
}

export interface GraphOutboxEntry {
  id: string;
  ts: number;
  attempts: number;
  project?: string;
  sourceIds?: string[];
  text?: string;
  entities?: Array<{ name: string; type: string; description: string }>;
  relationships?: Array<{ subject: string; predicate: string; object: string }>;
}
