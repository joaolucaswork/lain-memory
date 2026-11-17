/**
 * Seed + PGS routes (server split S4).
 *
 * /api/seed/* and /api/pgs/*. Health stays in the dispatcher (2 lines,
 * needs the server-local API_KEY).
 */

import { cachedGetGraphForPGS } from '../../graphrag.js';
import { extractSeed, listSeeds } from '../../seed-extraction.js';
import { PGSEngine } from '../../pgs/index.js';
import { createPGSProviders } from '../../pgs/llm-provider.js';
import { PGS_SESSIONS_DIR } from '../../workspace.js';
import { json, tenantOf, type Handler } from '../http.js';

export const handleSeedExtract: Handler = async (data) => {
  // Chunked fact/entity extraction from raw text or PDFs into seed files.
  const tenant = tenantOf(data);
  const input = {
    type: data.type,
    source: data.source,
    rawText: data.rawText,
    project: data.project,
    phone: data.phone,
    tenant,
  };
  try {
    const output = await extractSeed(input);
    const { recordTenantProject } = await import('../../tenants.js');
    await recordTenantProject(tenant, data.project);
    return json({
      success: true,
      id: output.id,
      title: output.title,
      summary: output.summary,
      facts_count: output.facts.length,
      entities_count: output.entities.length,
      message: `Extracted ${output.facts.length} facts and ${output.entities.length} entities from "${output.title}"`,
    });
  } catch (err: unknown) {
    console.error('[lain-memory] seed/extract handler error:', err);
    return json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
};

export const handleSeedList: Handler = async (data) => {
  return json(listSeeds(data.project, tenantOf(data)));
};

export const handlePgsExecute: Handler = async (data) => {
  // Partition → route → sweep → synthesize over the local GraphRAG.
  if (!data.query) return json({ error: 'query required' });
  const tenant = tenantOf(data);
  const pgsGraph = await cachedGetGraphForPGS(data.project, tenant);
  if (pgsGraph.nodes.length === 0) return json({ error: 'Graph is empty' });
  const providers = createPGSProviders();
  const pgsEngine = new PGSEngine({ ...providers, sessionsDir: PGS_SESSIONS_DIR });
  const result = await pgsEngine.execute(data.query, pgsGraph, {
    mode: data.mode,
    // Tenant-namespaced session so two tenants never share sweep coverage.
    sessionId: data.sessionId ? `${tenant}:${data.sessionId}` : tenant,
  });
  return json(result);
};

export const handlePgsStats: Handler = async (data) => {
  const pgsGraph = await cachedGetGraphForPGS(data.project, tenantOf(data));
  const providers = createPGSProviders();
  const pgsEngine = new PGSEngine({ ...providers, sessionsDir: PGS_SESSIONS_DIR });
  const partitions = pgsEngine.partition(pgsGraph);
  return json({
    nodes: pgsGraph.nodes.length,
    edges: pgsGraph.edges.length,
    partitions: partitions.length,
    partitionSummaries: partitions.map(p => ({
      id: p.id,
      nodeCount: p.nodeCount,
      keywords: p.keywords.slice(0, 5),
      summary: p.summary?.substring(0, 80),
    })),
  });
};
