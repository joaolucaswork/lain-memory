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
import {
  checkSignupAllowed,
  checkTenantRateLimit,
  findTenantByKey,
  MASTER_TENANT,
  type TenantIdentity,
} from './tenants.js';
import { handleTenantLink, handleTenantMcpToken, handleTenantSignup, handleTenantWhoami, handleTenantWipe } from './server/routes/tenant.js';
import { handleMcpOptions, handleMcpRequest } from './server/mcp-http.js';

const PORT = Number(process.env.LAIN_MEMORY_PORT ?? 3341);
const BIND = process.env.LAIN_MEMORY_BIND ?? '127.0.0.1';
const API_KEY = process.env.LAIN_API_KEY ?? '';

/** Open signup: no key, but strictly rate-limited per IP (anti-abuse). */
const SIGNUP_PATH = '/api/tenant/signup';

/**
 * Bearer → tenant. Master key maps to the legacy tenant; tenant keys map
 * via the workspace registry. Unknown keys → null (caller answers 401).
 * Reads never throw — a corrupt store fails closed (null).
 */
async function tenantFromRequest(req: Request): Promise<TenantIdentity | null> {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return null;
  return findTenantByKey(m[1]);
}

const GET_ROUTES = new Set([
  '/health',
  '/api/health',
  '/api/tenant/whoami',
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

    case SIGNUP_PATH:
      return handleTenantSignup(data);

    case '/api/tenant/link':
      return handleTenantLink(data);

    case '/api/tenant/mcp-token':
      return handleTenantMcpToken(data);

    case '/api/tenant/whoami':
      return handleTenantWhoami(data);

    case '/api/tenant/data':
      return handleTenantWipe(data);

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
    async fetch(req, server) {
      const url = new URL(req.url);

      // Remote MCP (Streamable HTTP, stateless JSON). Owns its auth (per-
      // request bearer → tenant) + rate limit — BEFORE the generic gate.
      // :3341 stays DROP; Caddy 443 → 127.0.0.1:3341 carries /mcp.
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
        if (req.method === 'OPTIONS') return handleMcpOptions();
        if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
          return handleMcpRequest(req);
        }
        return json({ error: 'method not allowed' }, 405);
      }

      // Open signup (no key) with a strict per-IP budget. Everything else
      // needs a known bearer (master or tenant key).
      let tenant: TenantIdentity | null = null;
      let clientIp = 'unknown';
      try {
        clientIp = server.requestIP(req)?.address ?? 'unknown';
      } catch { /* Bun without requestIP — signup budget falls back to shared */ }
      if (url.pathname === SIGNUP_PATH) {
        if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        if (!checkSignupAllowed(clientIp)) return json({ error: 'signup rate limit exceeded — try again later' }, 429);
      } else {
        const found = await tenantFromRequest(req);
        if (!found) return json({ error: 'unauthorized' }, 401);
        tenant = found;
        if (!checkTenantRateLimit(tenant.tenant)) {
          return json({ error: 'tenant rate limit exceeded (60 req/min)' }, 429);
        }
      }
      const withTenant = (data: Record<string, any>): Record<string, any> => {
        data.tenant = tenant?.tenant ?? MASTER_TENANT;
        data.isMaster = tenant?.isMaster ?? false;
        data.clientIp = clientIp;
        return data;
      };
      if (req.method === 'GET' && GET_ROUTES.has(url.pathname)) {
        const validated = validateRoute(url.pathname, Object.fromEntries(url.searchParams));
        if (!validated.ok) return json({ error: 'invalid request', issues: validated.issues }, 400);
        try {
          return await route(url.pathname, withTenant(validated.data));
        } catch (err) {
          console.error(`[lain-memory] route ${url.pathname} failed:`, err);
          return json({ error: 'internal error' }, 500);
        }
      }
      // Tenant wipe is a DELETE with no body (LGPD elimination).
      if (req.method === 'DELETE' && url.pathname === '/api/tenant/data') {
        try {
          return await route(url.pathname, { tenant: tenant?.tenant ?? MASTER_TENANT, clientIp });
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
        return await route(url.pathname, withTenant(validated.data));
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
