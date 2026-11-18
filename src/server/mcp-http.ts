/**
 * Remote MCP over Streamable HTTP (`POST/GET/DELETE /mcp`).
 *
 * WHY: local stdio serves one machine; per-account remote serves any MCP
 * client (opencode, Claude Desktop) from the VPS with the tenant's own
 * memories. No firewall change — Caddy `443 → 127.0.0.1:3341` carries it;
 * `:3341` stays DROP for the open internet.
 *
 * Auth: `Authorization: Bearer <key>` per request (master → `lucas`,
 * `lm_...` → tenant slug via the key ring). Stateless (no session store:
 * single-instance safe, no sticky sessions) with JSON responses (no SSE
 * through the proxy). Each request gets a FRESH Server bound to its tenant
 * — a shared global would leak cross-tenant tool scope.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '../mcp.js';
import { checkTenantRateLimit, findTenantByKey } from '../tenants.js';
import { json } from './http.js';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

export function handleMcpOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}

/**
 * Handle one MCP HTTP request. Owns auth + rate limit (the dispatcher
 * routes /mcp here BEFORE the generic bearer gate). Never throws — transport
 * errors become 500 JSON (never stacks/paths).
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer (.+)$/.exec(h);
  const found = m ? await findTenantByKey(m[1]) : null;
  if (!found) return withCors(json({ error: 'unauthorized' }, 401));
  if (!checkTenantRateLimit(found.tenant)) {
    return withCors(json({ error: 'tenant rate limit exceeded (60 req/min)' }, 429));
  }

  // Fresh per-request server: tool calls close over THIS tenant only.
  const mcpServer: Server = createMcpServer(found.tenant);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session store
    enableJsonResponse: true, // plain JSON through Caddy (no SSE)
  });
  try {
    await mcpServer.connect(transport);
    return withCors(await transport.handleRequest(req));
  } catch (err) {
    console.error('[lain-memory] /mcp failed:', err instanceof Error ? err.message : err);
    return withCors(json({ error: 'internal error' }, 500));
  } finally {
    try { await transport.close(); } catch { /* already closed */ }
    try { await mcpServer.close(); } catch { /* already closed */ }
  }
}
