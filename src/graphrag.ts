/**
 * GraphRAG — barrel (graphrag split G1–G10, epic #23).
 *
 * All logic lives in ./graphrag/: types, store, cache, extract, decisions,
 * ingest, query, outbox, resolve, reconcile. This module only re-exports
 * the public surface so existing import sites keep working unchanged.
 */

export type {
  DecisionAttrs,
  DecisionInput,
  EntityAttrs,
  EntityType,
  GraphContext,
  GraphIngestOpts,
  GraphOutboxEntry,
  RelationshipAttrs,
} from './graphrag/types.js';
export {
  __setGraphForTests,
  __setPersistEnabledForTests,
  getStats,
  initGraph,
  isGraphEnabled,
  isNodeOwnedByTenant,
  isNodeVisibleToProject,
  nodeProject,
  normalizeProject,
  relationshipKey,
  resolveNodeId,
  SCOPE_SEPARATOR,
  scopedId,
  tenantBase,
  tenantScope,
} from './graphrag/store.js';
export {
  cachedGetStats,
  invalidateGraphCache,
} from './graphrag/cache.js';
export { addDecision } from './graphrag/decisions.js';
export { ingest, ingestExtracted } from './graphrag/ingest.js';
export { query, queryDecisions } from './graphrag/query.js';
export {
  appendGraphOutbox,
  drainGraphOutbox,
  purgeTenantOutbox,
  queueGraphIngest,
  queueGraphIngestExtracted,
} from './graphrag/outbox.js';
export {
  pruneGraph,
  resolveEntities,
  runAutoclean,
} from './graphrag/resolve.js';
export {
  cachedGetGraphForPGS,
  getGraphForPGS,
  getGraphSyncStatus,
  listAllNodes,
  reconcileGraph,
  removeGraphProvenance,
  removeNodes,
  removeRelationships,
  removeTenantGraph,
} from './graphrag/reconcile.js';
