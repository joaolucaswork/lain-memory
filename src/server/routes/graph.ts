/**
 * Graph routes (server split S3).
 *
 * All /api/graph/* handlers: query, stats, nodes, removals,
 * autoclean, dump, ingest, sync.
 */

import {
  appendGraphOutbox,
  cachedGetGraphForPGS,
  cachedGetStats,
  getGraphSyncStatus,
  ingestExtracted,
  listAllNodes,
  query as graphQuery,
  reconcileGraph,
  removeNodes,
  removeRelationships,
  runAutoclean,
} from '../../graphrag.js';
import { json, requireMaster, tenantOf, type Handler } from '../http.js';

export const handleGraphQuery: Handler = async (data) => {
  const ctx = await graphQuery(data.query || '', { maxDepth: data.depth, maxNodes: data.maxNodes, project: data.project, tenant: tenantOf(data) });
  return json(ctx);
};

export const handleGraphStats: Handler = async (data) => {
  return json(await cachedGetStats(data.project, tenantOf(data)));
};

export const handleGraphNodes: Handler = async (data) => {
  return json(listAllNodes(data.project, tenantOf(data)));
};

export const handleGraphRemoveNodes: Handler = async (data) => {
  const ids = data.ids as string[];
  if (!ids || !Array.isArray(ids)) return json({ error: 'ids array required' }, 400);
  return json({ removed: await removeNodes(ids, data.project, tenantOf(data)) });
};

export const handleGraphRemoveRelationships: Handler = async (data) => {
  const { source, predicates, targets, project } = data;
  if (!source) return json({ error: 'source required' }, 400);
  return json({ removed: await removeRelationships(source, predicates, targets, project, tenantOf(data)) });
};

export const handleGraphAutoclean: Handler = async (data) => {
  const gate = requireMaster(data);
  if (gate) return gate;
  return json(await runAutoclean());
};

export const handleGraphDump: Handler = async (data) => {
  // Full graph payload for PGS sweeps running outside this server.
  return json(await cachedGetGraphForPGS(data.project, tenantOf(data)));
};

export const handleGraphIngest: Handler = async (data) => {
  // Pre-extracted payload: applied directly (synchronous, no LLM).
  // On failure the payload is queued durably and reported (Fase 3) —
  // EXCEPT quota errors, which are final: queueing would just defer the
  // same 429 while letting the outbox grow unbounded.
  const tenant = tenantOf(data);
  const { enforceTenantGraphCap } = await import('../../tenants.js');
  const gcap = await enforceTenantGraphCap(tenant, data.entities ?? [], data.relationships ?? [], data.project);
  if (!gcap.ok) return json({ error: gcap.error }, 429);
  try {
    await ingestExtracted(data.entities ?? [], data.relationships ?? [], data.project, { sourceIds: data.sourceIds, tenant });
    return json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/graph node cap reached/.test(msg)) return json({ error: msg }, 429);
    try {
      appendGraphOutbox({
        entities: data.entities ?? [],
        relationships: data.relationships ?? [],
        project: data.project,
        tenant,
        sourceIds: data.sourceIds,
      });
      return json({ success: true, queued: true });
    } catch {
      throw err;
    }
  }
};

export const handleGraphSync: Handler = async (data) => {
  const gate = requireMaster(data);
  if (gate) return gate;
  // Fase 3: drain outbox (incl. crash recovery) and report divergence state.
  const [report, status] = [await reconcileGraph(), getGraphSyncStatus()];
  return json({ ...report, lastError: status.lastError, lastReconciledAt: status.lastReconciledAt });
};
