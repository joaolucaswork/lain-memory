/**
 * lain-memory HTTP server.
 *
 * Serves the full `/api/...` memory/graph/seed/pgs surface:
 * remember, recall, list, forget, restore, feedback, add, context, update, consolidate,
 * scan, resolve-entities, contradiction-scan, metrics, graph query/stats/
 * nodes/remove/autoclean/dump/ingest, seed extract/list, pgs execute/stats.
 *
 * This server owns persistence and retrieval. It has no channels, no agent
 * lifecycle, no session side-effects — consumers talk to it over HTTP.
 */

import {
  isMem0Configured,
} from './mem0.js';
import { initGraph } from './graphrag.js';
import {
  handleAdd,
  handleBundle,
  handleFeedback,
  handleForget,
  handleRemember,
  handleRestore,
  handleUpdate,
} from './server/routes/memory-write.js';
import {
  handleConsolidate,
  handleContext,
  handleContradictions,
  handleContradictionsDismiss,
  handleContradictionScan,
  handleList,
  handleMetrics,
  handleRecall,
  handleResolveEntities,
  handleScan,
} from './server/routes/memory-read.js';
import {
  handleGraphAutoclean,
  handleGraphDump,
  handleGraphIngest,
  handleGraphNodes,
  handleGraphQuery,
  handleGraphRemoveNodes,
  handleGraphRemoveRelationships,
  handleGraphStats,
  handleGraphSync,
} from './server/routes/graph.js';
import {
  handlePgsExecute,
  handlePgsStats,
  handleSeedExtract,
  handleSeedList,
} from './server/routes/misc.js';
import { json } from './server/http.js';
import { startMemoryMaintenance } from './mem0.js';
import { startDedupSweep } from './dedup-sweep.js';
import { startMemoryReaper } from './memory-reaper.js';
import { startBundleSweep } from './bundle-sweep.js';
import { parseBody, validateRoute } from './http-validation.js';

const PORT = Number(process.env.LAIN_MEMORY_PORT ?? 3341);
const BIND = process.env.LAIN_MEMORY_BIND ?? '127.0.0.1';
const API_KEY = process.env.LAIN_API_KEY ?? '';

function unauthorized(req: Request): boolean {
  const h = req.headers.get('authorization') ?? '';
  return h !== `Bearer ${API_KEY}`;
}

const GET_ROUTES = new Set([
  '/health',
  '/api/health',
  '/api/memory/metrics',
  '/api/memory/contradictions',
  '/api/graph/stats',
  '/api/graph/nodes',
]);

async function route(path: string, data: Record<string, any>): Promise<Response> {
  const needMem0 = path.startsWith('/api/memory/') && !path.includes('resolve-entities');
  if (needMem0 && !isMem0Configured()) {
    return json({ error: 'MEM0_API_KEY not configured' }, 500);
  }

  switch (path) {
    case '/api/memory/remember':
      return handleRemember(data);

    case '/api/memory/recall':
      return handleRecall(data);

    case '/api/memory/list':
      return handleList(data);

    case '/api/memory/forget':
      return handleForget(data);

    case '/api/memory/restore':
      return handleRestore(data);

    case '/api/memory/feedback':
      return handleFeedback(data);

    case '/api/memory/add':
      return handleAdd(data);

    case '/api/memory/context':
      return handleContext(data);

    case '/api/memory/update':
      return handleUpdate(data);

    case '/api/memory/consolidate':
      return handleConsolidate(data);

    case '/api/memory/bundle':
      return handleBundle(data);

    case '/api/memory/scan':
      return handleScan(data);

    case '/api/memory/resolve-entities':
      return handleResolveEntities(data);

    case '/api/memory/contradiction-scan':
      return handleContradictionScan(data);

    case '/api/memory/metrics':
      return handleMetrics(data);

    case '/api/memory/contradictions':
      return handleContradictions(data);

    case '/api/memory/contradictions/dismiss':
      return handleContradictionsDismiss(data);

    case '/api/graph/query':
      return handleGraphQuery(data);

    case '/api/graph/stats':
      return handleGraphStats(data);

    case '/api/graph/nodes':
      return handleGraphNodes(data);

    case '/api/graph/remove-nodes':
      return handleGraphRemoveNodes(data);

    case '/api/graph/remove-relationships':
      return handleGraphRemoveRelationships(data);

    case '/api/graph/autoclean':
      return handleGraphAutoclean(data);

    case '/api/graph/dump':
      return handleGraphDump(data);

    case '/api/graph/ingest':
      return handleGraphIngest(data);

    case '/api/graph/sync':
      return handleGraphSync(data);

    case '/api/seed/extract':
      return handleSeedExtract(data);

    case '/api/seed/list':
      return handleSeedList(data);

    case '/api/pgs/execute':
      return handlePgsExecute(data);

    case '/api/pgs/stats':
      return handlePgsStats(data);

    case '/health':
    case '/api/health':
      return json({ ok: true, service: 'lain-memory', auth: 'bearer' });

    default:
      return json({ error: `unknown route: ${path}` }, 404);
  }
}

async function boot(): Promise<void> {
  await initGraph();
  startMemoryMaintenance();
  startDedupSweep();
  startMemoryReaper();
  startBundleSweep();

  Bun.serve({
    port: PORT,
    hostname: BIND,
    async fetch(req) {
      const url = new URL(req.url);
      if (unauthorized(req)) return json({ error: 'unauthorized' }, 401);
      if (req.method === 'GET' && GET_ROUTES.has(url.pathname)) {
        const validated = validateRoute(url.pathname, Object.fromEntries(url.searchParams));
        if (!validated.ok) return json({ error: 'invalid request', issues: validated.issues }, 400);
        try {
          return await route(url.pathname, validated.data);
        } catch (err) {
          console.error(`[lain-memory] route ${url.pathname} failed:`, err);
          return json({ error: 'internal error' }, 500);
        }
      }
      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const body = await parseBody(req);
      if (!body.ok) return json({ error: body.error }, body.status);
      const validated = validateRoute(url.pathname, body.data);
      if (!validated.ok) return json({ error: 'invalid request', issues: validated.issues }, 400);
      try {
        return await route(url.pathname, validated.data);
      } catch (err) {
        // Never leak internals (stacks, paths, backend messages) to callers.
        console.error(`[lain-memory] route ${url.pathname} failed:`, err);
        return json({ error: 'internal error' }, 500);
      }
    },
  });
  console.log(`[lain-memory] listening on ${BIND}:${PORT} (auth: bearer)`);
}

if (!API_KEY) {
  console.error('[lain-memory] fatal: LAIN_API_KEY is required');
  process.exit(1);
}

boot().catch(err => {
  console.error('[lain-memory] fatal boot error:', err);
  process.exit(1);
});
