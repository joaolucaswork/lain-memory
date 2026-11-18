/**
 * Remote MCP auth tests (Fase MCP remoto).
 *
 * No Qdrant, no LLM, no network: only the initialize handshake (no backend
 * touched) plus the 401 gate. Tenants store redirected to temp.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { __setTenantsPathForTests, createTenant } from '../tenants.js';
import { handleMcpRequest } from './mcp-http.js';

function tempTenantsFile(): string {
  return join(tmpdir(), `lain-mcp-test-${randomBytes(6).toString('hex')}.json`);
}

const MASTER = process.env.LAIN_API_KEY ?? '';

// Sem key (ex: CI sem .env) os testes de handshake são pulados — o gate
// 401 continua coberto sem segredo.
const describeAuth = MASTER ? describe : describe.skip;

beforeEach(() => {
  __setTenantsPathForTests(tempTenantsFile());
});

afterEach(() => {
  __setTenantsPathForTests(null);
});

function mcpReq(body: unknown, key?: string): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (key) headers.Authorization = `Bearer ${key}`;
  return new Request('http://localhost:3341/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

describeAuth('handleMcpRequest auth', () => {
  it('401s without a known bearer', async () => {
    const res = await handleMcpRequest(mcpReq(INITIALIZE));
    expect(res.status).toBe(401);
    const res2 = await handleMcpRequest(mcpReq(INITIALIZE, 'lm_bogus'));
    expect(res2.status).toBe(401);
  });

  it('handshakes with the master key (lucas scope)', async () => {
    const res = await handleMcpRequest(mcpReq(INITIALIZE, MASTER));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('lain-memory');
  });

  it('handshakes with a tenant key (per-account scope)', async () => {
    const created = await createTenant('Mcp Remote');
    const res = await handleMcpRequest(mcpReq(INITIALIZE, created.apiKey));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('lain-memory');
  });
});
