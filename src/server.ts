/**
 * lain-memory HTTP server.
 *
 * Serves the full `/api/...` memory/graph/seed/pgs surface:
 * remember, recall, list, forget, add, context, update, consolidate,
 * scan, resolve-entities, contradiction-scan, metrics, graph query/stats/
 * nodes/remove/autoclean/dump/ingest, seed extract/list, pgs execute/stats.
 *
 * This server owns persistence and retrieval. It has no channels, no agent
 * lifecycle, no session side-effects — consumers talk to it over HTTP.
 */

import {
  addMemory,
  addMemoryWithConflictCheck,
  searchMemory,
  cachedSearchMemory,
  getMemories,
  deleteMemory,
  updateMemory,
  consolidateMemories,
  scanAndCleanProjectMemories,
  getContextForSpawn,
  isMem0Configured,
} from './mem0.js';
import {
  initGraph,
  query as graphQuery,
  cachedGetStats,
  cachedGetGraphForPGS,
  listAllNodes,
  removeNodes,
  removeRelationships,
  runAutoclean,
  resolveEntities,
  ingestExtracted,
} from './graphrag.js';
import { classifyMemoryAction } from './contradiction-detector.js';
import { getMetrics } from './mem-metrics.js';
import { extractSeed, listSeeds } from './seed-extraction.js';
import { PGSEngine } from './pgs/index.js';
import { createPGSProviders } from './pgs/haiku-provider.js';
import { PGS_SESSIONS_DIR } from './workspace.js';
import { startMemoryMaintenance } from './mem0.js';
import { startDedupSweep } from './dedup-sweep.js';
import { startMemoryReaper } from './memory-reaper.js';

const PORT = Number(process.env.LAIN_MEMORY_PORT ?? 3341);
const API_KEY = process.env.LAIN_API_KEY ?? '';

function unauthorized(req: Request): boolean {
  if (!API_KEY) return false; // empty key = open localhost (same semantics as lain validateApiKey)
  const h = req.headers.get('authorization') ?? '';
  return h !== `Bearer ${API_KEY}`;
}

async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    return (await req.json()) as Record<string, any>;
  } catch {
    return {};
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function route(path: string, data: Record<string, any>): Promise<Response> {
  const needMem0 = path.startsWith('/api/memory/') && !path.includes('resolve-entities');
  if (needMem0 && !isMem0Configured()) {
    return json({ error: 'MEM0_API_KEY not configured' }, 500);
  }

  switch (path) {
    case '/api/memory/remember': {
      const memOpts: { skipConflictCheck?: boolean; bundleMode?: boolean; inferFalse?: boolean; skipQualityCheck?: boolean } = {};
      if (data.mode === 'index') memOpts.skipConflictCheck = true;
      else if (data.mode === 'bundle') memOpts.bundleMode = true;
      else if (data.mode === 'raw') memOpts.inferFalse = true;
      if (data.skipQualityCheck) memOpts.skipQualityCheck = true;
      const result = await addMemoryWithConflictCheck(data.text, data.project, memOpts);
      return json(result);
    }

    case '/api/memory/recall': {
      const result = data.cached
        ? await cachedSearchMemory(data.query, data.project, data.limit)
        : await searchMemory(data.query, data.project, data.limit);
      return json(result);
    }

    case '/api/memory/list': {
      const result = await getMemories(data.project, data.limit);
      return json(result);
    }

    case '/api/memory/forget': {
      await deleteMemory(data.memory_id);
      return json({ success: true });
    }

    case '/api/memory/add': {
      // Direct addMemory (no conflict check). Used by notes/file ingests
      // that pre-filter. Same AddMemoryOpts shape as in-process calls.
      const result = await addMemory(data.text, data.project, data.opts);
      return json(result);
    }

    case '/api/memory/context': {
      // Spawn-context composition. Keeps the
      // query-building + budget logic server-side with the ranker.
      const result = await getContextForSpawn(data.message, data.project, data.charBudget, data.limits);
      return json({ context: result });
    }

    case '/api/memory/update': {
      const updated = await updateMemory(data.id, data.memory, data.project);
      return json(updated);
    }

    case '/api/memory/consolidate': {
      const result = await consolidateMemories(data.project);
      return json(result);
    }

    case '/api/memory/scan': {
      if (!data.project) return json({ error: 'project is required for memory scan' }, 400);
      const report = await scanAndCleanProjectMemories(data.project);
      return json({
        total: report.total,
        deleted: report.deleted,
        message: report.deleted === 0
          ? `No stale memories to clean for project "${data.project}".`
          : `Cleaned ${report.deleted} stale memories from "${data.project}".`,
        deletedItems: report.deletedItems,
      });
    }

    case '/api/memory/resolve-entities': {
      const result = await resolveEntities(data.threshold ?? 0.75);
      return json(result);
    }

    case '/api/memory/contradiction-scan': {
      const project = data?.project as string | undefined;
      const memories = await getMemories(project, 100);
      const results: { id: string; action: string; reason: string; memory: string }[] = [];
      for (const mem of memories) {
        const similar = await searchMemory(mem.memory, project, 5);
        const others = similar
          .filter(s => s.id !== mem.id && (s.score ?? 0) > 0.6)
          .map(s => ({ id: s.id, memory: s.memory, score: s.score ?? 0 }));
        if (others.length === 0) continue;
        const classification = await classifyMemoryAction(mem.memory, others);
        if (classification.action !== 'ADD') {
          results.push({
            id: mem.id,
            action: classification.action,
            reason: classification.reason,
            memory: mem.memory.slice(0, 100),
          });
          if (classification.action === 'NOOP') await deleteMemory(mem.id);
        }
      }
      return json({ scanned: memories.length, issues: results.length, results });
    }

    case '/api/memory/metrics':
      return json(getMetrics());

    case '/api/graph/query': {
      const ctx = await graphQuery(data.query || '', { maxDepth: data.depth, maxNodes: data.maxNodes });
      return json(ctx);
    }

    case '/api/graph/stats':
      return json(await cachedGetStats());

    case '/api/graph/nodes':
      return json(listAllNodes());

    case '/api/graph/remove-nodes': {
      const ids = data.ids as string[];
      if (!ids || !Array.isArray(ids)) return json({ error: 'ids array required' }, 400);
      return json({ removed: await removeNodes(ids) });
    }

    case '/api/graph/remove-relationships': {
      const { source, predicates, targets } = data;
      if (!source) return json({ error: 'source required' }, 400);
      return json({ removed: await removeRelationships(source, predicates, targets) });
    }

    case '/api/graph/autoclean':
      return json(await runAutoclean());

    case '/api/graph/dump': {
      // Full graph payload for PGS sweeps running outside this server.
      return json(await cachedGetGraphForPGS());
    }

    case '/api/graph/ingest': {
      await ingestExtracted(data.entities ?? [], data.relationships ?? []);
      return json({ success: true });
    }

    case '/api/seed/extract': {
      // Chunked fact/entity extraction from raw text or PDFs into seed files.
      const input = {
        type: data.type,
        source: data.source,
        rawText: data.rawText,
        project: data.project,
        phone: data.phone,
      };
      try {
        const output = await extractSeed(input);
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
    }

    case '/api/seed/list': {
      return json(listSeeds(data.project));
    }

    case '/api/pgs/execute': {
      // Partition → route → sweep → synthesize over the local GraphRAG.
      if (!data.query) return json({ error: 'query required' });
      const pgsGraph = await cachedGetGraphForPGS();
      if (pgsGraph.nodes.length === 0) return json({ error: 'Graph is empty' });
      const providers = createPGSProviders();
      const pgsEngine = new PGSEngine({ ...providers, sessionsDir: PGS_SESSIONS_DIR });
      const result = await pgsEngine.execute(data.query, pgsGraph, {
        mode: data.mode,
        sessionId: data.sessionId,
      });
      return json(result);
    }

    case '/api/pgs/stats': {
      const pgsGraph = await cachedGetGraphForPGS();
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
    }

    case '/health':
    case '/api/health':
      return json({ ok: true, service: 'lain-memory' });

    default:
      return json({ error: `unknown route: ${path}` }, 404);
  }
}

async function boot(): Promise<void> {
  await initGraph();
  startMemoryMaintenance();
  startDedupSweep();
  startMemoryReaper();

  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (unauthorized(req)) return json({ error: 'unauthorized' }, 401);
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health' ||
          url.pathname === '/api/memory/metrics' || url.pathname === '/api/graph/stats' ||
          url.pathname === '/api/graph/nodes')) {
        return route(url.pathname, Object.fromEntries(url.searchParams));
      }
      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      try {
        return await route(url.pathname, await readJson(req));
      } catch (err) {
        console.error(`[lain-memory] route ${url.pathname} failed:`, err);
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    },
  });
  console.log(`[lain-memory] listening on :${PORT}`);
}

boot().catch(err => {
  console.error('[lain-memory] fatal boot error:', err);
  process.exit(1);
});
