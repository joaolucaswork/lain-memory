/**
 * Memory read routes (server split S2).
 *
 * recall, list, context, consolidate, scan, resolve-entities,
 * contradiction-scan, metrics, contradictions, contradictions/dismiss.
 */

import {
  cachedSearchMemory,
  consolidateMemories,
  getContextForSpawn,
  getMemories,
  scanAndCleanProjectMemories,
  searchMemory,
} from '../../mem0.js';
import { getGraphSyncStatus, resolveEntities } from '../../graphrag.js';
import { classifyMemoryAction } from '../../contradiction-detector.js';
import { getMetrics } from '../../mem-metrics.js';
import { json, requireMaster, tenantOf, type Handler } from '../http.js';

export const handleRecall: Handler = async (data) => {
  const tenant = tenantOf(data);
  const result = data.cached
    ? await cachedSearchMemory(data.query, data.project, data.limit, tenant)
    : await searchMemory(data.query, data.project, data.limit, tenant);
  // debug:true pins the measurement contract (adjustedScore + importance
  // on every hit). RankedMemory already carries both, so the spread is a
  // no-op today — non-debug responses are byte-identical to before.
  if (data.debug) {
    return json(result.map((r) => ({ ...r, adjustedScore: r.adjustedScore, importance: r.importance ?? null })));
  }
  return json(result);
};

export const handleList: Handler = async (data) => {
  const result = await getMemories(data.project, data.limit, tenantOf(data));
  return json(result);
};

export const handleContext: Handler = async (data) => {
  // Spawn-context composition. Keeps the
  // query-building + budget logic server-side with the ranker.
  const result = await getContextForSpawn(data.message, data.project, data.charBudget, data.limits, tenantOf(data));
  return json({ context: result });
};

export const handleConsolidate: Handler = async (data) => {
  // Maintenance op on the shared pending-review queue — master only.
  const gate = requireMaster(data);
  if (gate) return gate;
  const result = await consolidateMemories(data.project);
  return json(result);
};

export const handleScan: Handler = async (data) => {
  if (!data.project) return json({ error: 'project is required for memory scan' }, 400);
  const report = await scanAndCleanProjectMemories(data.project, tenantOf(data));
  return json({
    total: report.total,
    deleted: report.deleted,
    message: report.deleted === 0
      ? `No stale memories to clean for project "${data.project}".`
      : `Cleaned ${report.deleted} stale memories from "${data.project}".`,
    deletedItems: report.deletedItems,
  });
};

export const handleResolveEntities: Handler = async (data) => {
  const result = await resolveEntities(data.threshold ?? 0.75, data.project, tenantOf(data));
  return json(result);
};

export const handleContradictionScan: Handler = async (data) => {
  // Fase 4: diagnostic only — detects and reports, never writes.
  // NOOP means "ignore" (not "delete"); UPDATE/DELETE verdicts are
  // actioned by the maintenance/policy flows, not by this scan.
  // Paged (limit/offset) so 100x LLM no longer times out: callers
  // iterate offset += limit until scanned < limit.
  const project = data?.project as string | undefined;
  const tenant = tenantOf(data ?? {});
  const limit = Math.min(Math.max(Number(data?.limit ?? 20) || 20, 1), 100);
  const offset = Math.max(Number(data?.offset ?? 0) || 0, 0);
  const fetched = await getMemories(project, Math.min(offset + limit, 500), tenant);
  const memories = fetched.slice(offset, offset + limit);
  const results: { id: string; action: string; domainOp: string; reason: string; memory: string }[] = [];
  for (const mem of memories) {
    const similar = await searchMemory(mem.memory, project, 5, tenant);
    const others = similar
      .filter(s => s.id !== mem.id && (s.score ?? 0) > 0.6)
      .map(s => ({ id: s.id, memory: s.memory, score: s.score ?? 0 }));
    if (others.length === 0) continue;
    const classification = await classifyMemoryAction(mem.memory, others);
    if (classification.action !== 'ADD') {
      const { domainOpForClassification } = await import('../../memory-policy.js');
      results.push({
        id: mem.id,
        action: classification.action,
        domainOp: domainOpForClassification(classification.action),
        reason: classification.reason,
        memory: mem.memory.slice(0, 100),
      });
    }
  }
  return json({ scanned: memories.length, issues: results.length, results, writes: 0, limit, offset });
};

export const handleMetrics: Handler = async (data) => {
  const gate = requireMaster(data);
  if (gate) return gate;
  return json({ ...getMetrics(), graphOutboxPending: getGraphSyncStatus().pending });
};

export const handleContradictions: Handler = async (data) => {
  const gate = requireMaster(data);
  if (gate) return gate;
  // Item 3: visible backlog — UPDATE merge candidates + DELETE
  // contradictions queued by the automatic sweep. Read-only.
  const { listPending } = await import('../../pending-review.js');
  const kind = data?.kind as 'merge' | 'contradiction' | undefined;
  const limit = Math.min(Math.max(Number(data?.limit ?? 100) || 100, 1), 200);
  const items = listPending(kind);
  return json({
    total: items.length,
    pending: items.slice(0, limit).map(e => ({
      id: e.id,
      kind: e.kind,
      verdict: e.verdict,
      scope: e.scope ?? 'global',
      memoryId: e.memoryId,
      memory: e.memory.slice(0, 200),
      relatedIds: e.related.map(r => r.id),
      reason: e.reason,
      attempts: e.attempts,
      detectedAt: e.detectedAt,
    })),
  });
};

export const handleContradictionsDismiss: Handler = async (data) => {
  const gate = requireMaster(data);
  if (gate) return gate;
  if (!data?.id) return json({ error: 'id required' }, 400);
  const { dismissEntry } = await import('../../pending-review.js');
  const ok = await dismissEntry(data.id);
  if (!ok) return json({ error: 'entry not found' }, 404);
  return json({ success: true });
};
