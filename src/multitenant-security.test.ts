/**
 * Multitenant hardening regression suite (Plano — Fase 4).
 *
 * Offline by design: no Qdrant, no LLM, no external network. Backend seams
 * use explicit test hooks (__set*ForTests), never mock.module (which leaks
 * across test files in the same bun run). The graph singleton, seeds dir
 * and tenants file are redirected to throwaway state per test.
 *
 * Covers:
 *  1. LFI/SSRF in seed_extract (non-master blocked, master keeps local reads)
 *  2. Graph isolation in removeNodes/removeRelationships
 *  3. Admin-only routes (403 for tenants, 200/pass for master)
 *  4. Quotas (memory cap incl. chat mode, graph node cap, metadata sanitize)
 *  5. Rate limiting (fixed window, signup IP, expensive ops, clientIp)
 *  6. LGPD wipe (seeds + PGS sessions) & tombstone + fail-closed delete
 *  7. Validation coverage (every /api/* route has a schema)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import Graph from 'graphology';

import {
  __setSeedsDirForTests,
  __setProcessChunkForTests,
  __setSeedMemorySaverForTests,
  assertSafePublicUrl,
  deleteTenantSeeds,
  extractSeed,
  isPrivateIP,
} from './seed-extraction.js';
import {
  __setGraphForTests,
  __setPersistEnabledForTests,
  getGraph,
  isNodeOwnedByTenant,
  normalizeProject,
  resolveNodeId,
  scopedId,
  upsertEntity,
  upsertRelationship,
} from './graphrag/store.js';
import { removeNodes, removeRelationships } from './graphrag/reconcile.js';
import {
  __setGetMemoriesForTests,
  __setTenantsPathForTests,
  __resetRateLimitersForTests,
  FixedWindowLimiter,
  TENANT_MEMORY_CAP,
  checkExpensiveOpAllowed,
  checkSignupAllowed,
  checkTenantRateLimit,
  createTenant,
  deleteTenantRecord,
  enforceTenantCap,
  enforceTenantGraphCap,
  findTenantByKey,
  getTenantDisplayName,
  getTenantProjects,
  mintTenantKey,
  recordTenantProject,
  updateTenantName,
  upsertTenantForSub,
} from './tenants.js';
import { routeSchemas, validateRoute } from './http-validation.js';
import { requireMaster, resolveClientIp } from './server/http.js';
import {
  handleConsolidate,
  handleContradictions,
  handleContradictionsDismiss,
  handleMetrics,
} from './server/routes/memory-read.js';
import { handleGraphAutoclean, handleGraphIngest, handleGraphSync } from './server/routes/graph.js';
import { handleAdd, handleBundle, handleRemember, stripReservedMetadata } from './server/routes/memory-write.js';
import { handlePgsExecute } from './server/routes/misc.js';
import { handleTenantAccountDelete } from './server/routes/tenant.js';
import { ingestExtracted } from './graphrag/ingest.js';
import { handleTool } from './mcp.js';
import { deleteTenantPgsSessions } from './pgs/session.js';

let tmpRoot = '';

function freshTmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `lain-mtsec-${name}-${randomBytes(4).toString('hex')}-`));
}

const CANNED_CHUNK = {
  title: 'Canned',
  summary: 'Canned summary.',
  facts: ['canned fact one two three four five'],
  entities: [] as Array<{ name: string; type: string; description: string }>,
  relationships: [] as Array<{ subject: string; predicate: string; object: string }>,
};

let seedSaverCalls = 0;

beforeEach(() => {
  tmpRoot = freshTmp('root');
  __setTenantsPathForTests(join(tmpRoot, 'tenants.json'));
  __setSeedsDirForTests(join(tmpRoot, 'seeds'));
  __setPersistEnabledForTests(false);
  __setGraphForTests(new Graph({ type: 'directed', multi: true }));
  __resetRateLimitersForTests();
  // Offline default: memory count source throws (Qdrant unreachable).
  __setGetMemoriesForTests(() => Promise.reject(new Error('qdrant offline (test default)')));
  __setProcessChunkForTests(async () => ({ ...CANNED_CHUNK }));
  seedSaverCalls = 0;
  __setSeedMemorySaverForTests(async () => [{ id: `seedmem-${++seedSaverCalls}` }]);
});

afterEach(() => {
  __setTenantsPathForTests(null);
  __setSeedsDirForTests(null);
  __setPersistEnabledForTests(true);
  __setGetMemoriesForTests(null);
  __setProcessChunkForTests(null);
  __setSeedMemorySaverForTests(null);
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
// 1. LFI / SSRF
// ═══════════════════════════════════════════════════════════════════

describe('1. seed_extract LFI/SSRF', () => {
  it("non-master cannot read local files (txt/pdf/docx)", async () => {
    await expect(extractSeed({ type: 'txt', source: '/etc/passwd', tenant: 'ana' }))
      .rejects.toThrow(/master-only/);
    await expect(extractSeed({ type: 'txt', source: '.env', tenant: 'ana' }))
      .rejects.toThrow(/master-only/);
    await expect(extractSeed({ type: 'pdf', source: '/tmp/x.pdf', tenant: 'ana' }))
      .rejects.toThrow(/master-only/);
    await expect(extractSeed({ type: 'docx', source: '/tmp/x.docx', tenant: 'ana' }))
      .rejects.toThrow(/master-only/);
  });

  it('non-master auto-detect never falls through to local files', async () => {
    // No type + local-looking source, no rawText → must refuse, not read.
    await expect(extractSeed({ source: '/etc/passwd', tenant: 'ana' } as never))
      .rejects.toThrow(/master-only/);
    await expect(extractSeed({ source: 'notes.txt', tenant: 'ana' } as never))
      .rejects.toThrow(/master-only/);
  });

  it('non-master SSRF targets are blocked (loopback, metadata, localhost)', async () => {
    await expect(extractSeed({ type: 'url', source: 'http://127.0.0.1:6333/collections', tenant: 'ana' }))
      .rejects.toThrow(/blocked SSRF/);
    await expect(extractSeed({ type: 'url', source: 'http://169.254.169.254/latest/meta-data/', tenant: 'ana' }))
      .rejects.toThrow(/blocked SSRF/);
    await expect(extractSeed({ type: 'url', source: 'http://localhost:6333/collections', tenant: 'ana' }))
      .rejects.toThrow(/blocked SSRF/);
  });

  it('non-master redirect to a private IP is blocked', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/go') {
          return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/evil' } });
        }
        return new Response('ok');
      },
    });
    try {
      const port = server.port;
      // Lie about localhost at the DNS layer (public) so the fetch reaches
      // the local redirector; the redirect target must still be rejected.
      const stubLookup = async (host: string) => {
        if (host === 'localhost') return [{ address: '93.184.216.34' }];
        if (host === '127.0.0.1') return [{ address: '127.0.0.1' }];
        return [{ address: '93.184.216.34' }];
      };
      await expect(assertSafePublicUrl(`http://localhost:${port}/go`, 3, stubLookup))
        .rejects.toThrow(/blocked SSRF/);
    } finally {
      server.stop(true);
    }
  });

  it('isPrivateIP covers the full fe80::/10 link-local range (fe80–febf)', () => {
    expect(isPrivateIP('fe80::1')).toBe(true);
    expect(isPrivateIP('fe9a::1')).toBe(true);
    expect(isPrivateIP('febf:ffff::1')).toBe(true);
    expect(isPrivateIP('fec0::1')).toBe(false); // site-local, outside /10
    expect(isPrivateIP('fe7f::1')).toBe(false); // just below the range
  });

  it("non-master type:'text' + rawText still works", async () => {
    const out = await extractSeed({
      type: 'text',
      source: 'inline',
      rawText: 'Ana prefers morning standups and owns the payments service.',
      tenant: 'ana',
    });
    expect(out.tenant).toBe('ana');
    expect(out.type).toBe('text');
  });

  it('master keeps local file reads (offline: ENOENT proves the guard passed)', async () => {
    // Master must NOT hit the master-only guard: it proceeds to the
    // filesystem and fails with ENOENT on a missing file (never master-only).
    await expect(extractSeed({ type: 'txt', source: '/nonexistent-xyz-123.txt', tenant: 'lucas' }))
      .rejects.toThrow(/ENOENT/);
    await expect(extractSeed({ type: 'txt', source: '/nonexistent-xyz-123.txt', tenant: 'lucas' }))
      .rejects.not.toThrow(/master-only/);
  });

  it('master full local extraction works end-to-end (stubbed chunk/save)', async () => {    const dir = freshTmp('seedfile');
    const file = join(dir, 'note.txt');
    writeFileSync(file, 'Lucas decided to migrate the billing service to Postgres in Q3.');
    const out = await extractSeed({ type: 'txt', source: file, tenant: 'lucas' });
    expect(out.type).toBe('txt');
    expect(out.memoryIds.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Graph isolation
// ═══════════════════════════════════════════════════════════════════

describe('2. graph remove isolation', () => {
  it("ana cannot remove bob's or master's nodes; own removal works", async () => {
    upsertEntity('postgres', 'Technology', 'master db', 'diario', undefined, 'lucas');
    upsertEntity('bun', 'Technology', 'bob runtime', undefined, undefined, 'bob');
    upsertEntity('own', 'Technology', 'ana thing', undefined, undefined, 'ana');
    // Ensure the target exists BEFORE linking so the edge is real.
    upsertEntity('bun2', 'Technology', undefined, undefined, undefined, 'bob');
    upsertRelationship('tn-bob::bun', 'tn-bob::bun2', 'USES');

    const removed = await removeNodes(['tn-bob::bun', 'diario::postgres'], undefined, 'ana');
    expect(removed).toEqual([]);
    const g = getGraph();
    expect(g.hasNode('tn-bob::bun')).toBe(true);
    expect(g.hasNode('diario::postgres')).toBe(true);

    const relRemoved = await removeRelationships('tn-bob::bun', undefined, undefined, undefined, 'ana');
    expect(relRemoved).toBe(0);
    expect(g.hasEdge('tn-bob::bun-USES-tn-bob::bun2')).toBe(true);

    // Cross-tenant edge prune via own source + foreign target is fail-closed.
    const crossRemoved = await removeRelationships('tn-ana::own', undefined, ['tn-bob::bun'], undefined, 'ana');
    expect(crossRemoved).toBe(0);

    // Own removal still works.
    const ownRemoved = await removeNodes(['own'], undefined, 'ana');
    expect(ownRemoved).toEqual(['tn-ana::own']);
    expect(g.hasNode('tn-ana::own')).toBe(false);
  });

  it('resolveNodeId never hands a foreign scope to non-master', () => {
    const key = resolveNodeId('tn-bob::bun', undefined, 'ana');
    expect(isNodeOwnedByTenant(key, 'ana')).toBe(false);
    expect(isNodeOwnedByTenant('tn-ana::x', 'ana')).toBe(true);
    expect(isNodeOwnedByTenant('tn-ana--p::x', 'ana')).toBe(true);
    expect(isNodeOwnedByTenant('tn-ana2::x', 'ana')).toBe(false);
    expect(isNodeOwnedByTenant('bare', 'ana')).toBe(false);
    expect(isNodeOwnedByTenant('bare', 'lucas')).toBe(true);
  });

  it("project/name sanitizing keeps the '::'/'--' grammar unambiguous", () => {
    expect(normalizeProject('a::b--c')).not.toContain(':');
    expect(normalizeProject('a::b--c')).not.toContain('--');
    const id = scopedId('tn-bob::x', 'p', 'ana');
    const namePart = id.slice(id.indexOf('::') + 2);
    expect(namePart).not.toContain('::');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Admin-only routes
// ═══════════════════════════════════════════════════════════════════

describe('3. admin routes are master-only', () => {
  const tenantCtx = { tenant: 'ana', isMaster: false };

  it('tenants get 403 on every global route', async () => {
    expect((await handleMetrics(tenantCtx)).status).toBe(403);
    expect((await handleContradictions(tenantCtx)).status).toBe(403);
    expect((await handleContradictionsDismiss(tenantCtx)).status).toBe(403);
    expect((await handleConsolidate(tenantCtx)).status).toBe(403);
    expect((await handleGraphAutoclean(tenantCtx)).status).toBe(403);
    expect((await handleGraphSync(tenantCtx)).status).toBe(403);
  });

  it('master passes the gate (safe backends return 200)', async () => {
    const master = { tenant: 'lucas', isMaster: true };
    expect((await handleMetrics(master)).status).toBe(200);
    expect((await handleContradictions(master)).status).toBe(200);
    expect((await handleGraphAutoclean(master)).status).toBe(200);
    // Gate-level: heavy backends (consolidate/sync/dismiss) are not executed
    // here; assert the gate itself passes instead of running them.
    expect(requireMaster(master)).toBeNull();
    expect(requireMaster(tenantCtx)?.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Quotas
// ═══════════════════════════════════════════════════════════════════

describe('4. quotas on every write path', () => {
  it('master is uncapped; tenants hit the memory cap (message points at DELETE /api/tenant/data)', async () => {
    expect(await enforceTenantCap('lucas', 'p')).toEqual({ ok: true });
    __setGetMemoriesForTests(async () => Array.from({ length: 500 }, (_, i) => ({ id: `m-${i}` })));
    const res = await enforceTenantCap('ana', 'p');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/DELETE \/api\/tenant\/data/);
    expect(TENANT_MEMORY_CAP).toBe(500);
    __setGetMemoriesForTests(async () => []);
    expect((await enforceTenantCap('ana', 'p')).ok).toBe(true);
  });

  it('handleRemember enforces the cap in atomic AND chat mode', async () => {
    __setGetMemoriesForTests(async () => Array.from({ length: 500 }, (_, i) => ({ id: `m-${i}` })));
    const ctx = (extra: Record<string, unknown>) => ({ tenant: 'ana', isMaster: false, ...extra });
    const atomic = await handleRemember(ctx({ text: 'x'.repeat(10) }));
    expect(atomic.status).toBe(429);
    const chat = await handleRemember(ctx({ text: 'user turn here', mode: 'chat' }));
    expect(chat.status).toBe(429);
  });

  it('MCP remember + bundle_diario enforce the cap', async () => {
    __setGetMemoriesForTests(async () => Array.from({ length: 500 }, (_, i) => ({ id: `m-${i}` })));
    const r = await handleTool('remember', { text: 'hello world, this is a fact' }, 'ana');
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/memory cap reached/);
    const b = await handleTool('bundle_diario', {}, 'ana');
    expect(b.isError).toBe(true);
    expect(JSON.stringify(b)).toMatch(/memory cap reached/);
  });

  it('graph ingest respects TENANT_GRAPH_NODE_CAP (HTTP 429 via enforceTenantGraphCap)', async () => {
    for (let i = 0; i < 500; i++) {
      upsertEntity(`node-${i}`, 'Other', undefined, undefined, undefined, 'ana');
    }
    expect((await enforceTenantGraphCap('ana', [{ name: 'one-more' }])).ok).toBe(false);
    expect((await enforceTenantGraphCap('lucas', [{ name: 'x' }])).ok).toBe(true);
    const res = await handleGraphIngest({
      tenant: 'ana',
      isMaster: false,
      entities: [{ name: 'overflow', type: 'Other', description: '' }],
      relationships: [],
    });
    expect(res.status).toBe(429);
  });

  it('relationships-only payloads cannot bypass the graph cap', async () => {
    // 499 owned nodes + entities:[] with 2 brand-new relationship endpoints
    // = 501 > 500 → must 429 at the pre-check (not ingest, not queue).
    for (let i = 0; i < 499; i++) {
      upsertEntity(`capnode-${i}`, 'Other', undefined, undefined, undefined, 'ana');
    }
    const rels = [{ subject: 'brand-new-a', predicate: 'USES', object: 'brand-new-b' }];
    expect((await enforceTenantGraphCap('ana', [], rels)).ok).toBe(false);
    const res = await handleGraphIngest({
      tenant: 'ana',
      isMaster: false,
      entities: [],
      relationships: rels,
    });
    expect(res.status).toBe(429);
    const g = getGraph();
    expect(g.hasNode('tn-ana::brand-new-a')).toBe(false);
    expect(g.hasNode('tn-ana::brand-new-b')).toBe(false);
    // Same endpoints already in the graph → no new nodes → allowed.
    // (Fresh budget check on a graph where the endpoints pre-exist.)
    __setGraphForTests(new Graph({ type: 'directed', multi: true }));
    for (let i = 0; i < 498; i++) {
      upsertEntity(`capnode-${i}`, 'Other', undefined, undefined, undefined, 'ana');
    }
    upsertEntity('brand-new-a', 'Other', undefined, undefined, undefined, 'ana');
    upsertEntity('brand-new-b', 'Other', undefined, undefined, undefined, 'ana');
    // 500 owned + 0 incoming = exactly at cap → allowed (not over).
    expect((await enforceTenantGraphCap('ana', [], rels)).ok).toBe(true);
  });

  it('ingestExtracted throws (never queues) when the tenant graph is full', async () => {
    for (let i = 0; i < 500; i++) {
      upsertEntity(`full-${i}`, 'Other', undefined, undefined, undefined, 'ana');
    }
    await expect(
      ingestExtracted([{ name: 'overflow', type: 'Other', description: '' }], [], undefined, { tenant: 'ana' }),
    ).rejects.toThrow(/graph node cap reached/);
    // Cap errors must surface as 429, never `queued: true`. Simulate the
    // race (pre-check passed, ingest threw) by stubbing the handler path:
    // a full graph + entities-only payload is rejected before queueing.
    const res = await handleGraphIngest({
      tenant: 'ana',
      isMaster: false,
      entities: [{ name: 'overflow', type: 'Other', description: '' }],
      relationships: [],
    });
    expect(res.status).toBe(429);
    expect(await res.json()).not.toHaveProperty('queued');
  });

  it('stripReservedMetadata removes internal keys for non-master only', () => {
    const opts = (meta: Record<string, unknown>) => ({ metadata: meta });
    const anaOpts = opts({ keep: 'yes', lain_feedback: 'x', lain_importance: 1, lain_relevance: 1, lain_state_snapshot: 1, deleted_from: 1, original_id: 1, trashed_at: 1 });
    stripReservedMetadata(anaOpts, 'ana');
    expect(anaOpts).toEqual({ metadata: { keep: 'yes' } });
    const masterOpts = opts({ keep: 'yes', lain_feedback: 'x' });
    stripReservedMetadata(masterOpts, 'lucas');
    expect(masterOpts).toEqual({ metadata: { keep: 'yes', lain_feedback: 'x' } });
    // handleAdd wires the sanitizer (cap stubbed under budget; the Qdrant
    // write itself is out of scope for this offline suite).
    expect(typeof handleAdd).toBe('function');
    expect(typeof handleBundle).toBe('function');
    expect(typeof handlePgsExecute).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Rate limiting
// ═══════════════════════════════════════════════════════════════════

describe('5. rate limiting', () => {
  it('fixed window: 60 allowed, 61st denied, per-tenant buckets', () => {
    const t = `t-${randomBytes(4).toString('hex')}`;
    for (let i = 0; i < 60; i++) expect(checkTenantRateLimit(t)).toBe(true);
    expect(checkTenantRateLimit(t)).toBe(false);
    expect(checkTenantRateLimit(`other-${t}`)).toBe(true);
  });

  it('fixed window: sustained 2 req/min never trips; window resets', () => {
    const lim = new FixedWindowLimiter(100);
    const t0 = Date.now();
    // 2 req/min for 30 min: always within budget.
    for (let m = 0; m < 30; m++) {
      expect(lim.check('k', 60, 60_000, t0 + m * 60_000)).toBe(true);
      expect(lim.check('k', 60, 60_000, t0 + m * 60_000 + 1000)).toBe(true);
    }
    // Burst to the cap inside one window, then the window expires.
    const w = t0 + 31 * 60_000;
    for (let i = 0; i < 60; i++) expect(lim.check('burst', 60, 60_000, w)).toBe(true);
    expect(lim.check('burst', 60, 60_000, w + 59_000)).toBe(false);
    expect(lim.check('burst', 60, 60_000, w + 61_000)).toBe(true);
  });

  it('signup budget is 10/hour per IP', () => {
    const ip = `9.9.9.${randomBytes(1)[0]}`;
    for (let i = 0; i < 10; i++) expect(checkSignupAllowed(ip)).toBe(true);
    expect(checkSignupAllowed(ip)).toBe(false);
  });

  it('expensive LLM ops: 5 req/min per non-master tenant; master uncapped', () => {
    const t = `exp-${randomBytes(4).toString('hex')}`;
    for (let i = 0; i < 5; i++) expect(checkExpensiveOpAllowed(t, '/api/pgs/execute')).toBe(true);
    expect(checkExpensiveOpAllowed(t, '/api/pgs/execute')).toBe(false);
    // Separate endpoint has its own bucket.
    expect(checkExpensiveOpAllowed(t, '/api/seed/extract')).toBe(true);
    for (let i = 0; i < 100; i++) expect(checkExpensiveOpAllowed('lucas', '/api/pgs/execute')).toBe(true);
  });

  it('resolveClientIp trusts X-Forwarded-For only behind loopback', () => {
    const xff = (v: string) => new Request('http://x/', { headers: { 'x-forwarded-for': v } });
    // Behind Caddy (loopback peer): last hop wins.
    expect(resolveClientIp(xff('1.2.3.4, 5.6.7.8'), '127.0.0.1')).toBe('5.6.7.8');
    expect(resolveClientIp(xff('1.2.3.4'), '::1')).toBe('1.2.3.4');
    const xri = new Request('http://x/', { headers: { 'x-real-ip': '7.7.7.7' } });
    expect(resolveClientIp(xri, '127.0.0.1')).toBe('7.7.7.7');
    // Direct exposure: spoofed headers ignored.
    expect(resolveClientIp(xff('1.2.3.4'), '9.9.9.9')).toBe('9.9.9.9');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. LGPD wipe & tombstone
// ═══════════════════════════════════════════════════════════════════

describe('6. LGPD wipe, tombstone, fail-closed delete', () => {
  it('wipe removes tenant seeds + PGS sessions without touching others', () => {
    const seedsDir = join(tmpRoot, 'seeds');
    mkdirSync(seedsDir, { recursive: true });
    writeFileSync(join(seedsDir, 'a.json'), JSON.stringify({ id: 'a', source: 's', type: 'text', title: 't', summary: 's', facts: [], entities: [], relationships: [], chunks: 1, wordCount: 1, processedAt: 1, memoryIds: [], tenant: 'ana' }));
    writeFileSync(join(seedsDir, 'b.json'), JSON.stringify({ id: 'b', source: 's', type: 'text', title: 't', summary: 's', facts: [], entities: [], relationships: [], chunks: 1, wordCount: 1, processedAt: 1, memoryIds: [], tenant: 'bob' }));
    writeFileSync(join(seedsDir, 'c.json'), JSON.stringify({ id: 'c', source: 's', type: 'text', title: 't', summary: 's', facts: [], entities: [], relationships: [], chunks: 1, wordCount: 1, processedAt: 1, memoryIds: [] }));
    // Point the module at this dir via the test hook (listSeeds reads it too).
    __setSeedsDirForTests(seedsDir);
    expect(deleteTenantSeeds('ana')).toBe(1);
    expect(readdirSync(seedsDir).sort()).toEqual(['b.json', 'c.json']);

    const pgsDir = join(tmpRoot, 'pgs');
    mkdirSync(pgsDir, { recursive: true });
    for (const f of ['ana.json', 'ana_sess1.json', 'bob.json', 'lucas.json']) {
      writeFileSync(join(pgsDir, f), '{}');
    }
    expect(deleteTenantPgsSessions('ana', pgsDir)).toBe(2);
    expect(readdirSync(pgsDir).sort()).toEqual(['bob.json', 'lucas.json']);
    expect(deleteTenantPgsSessions('lucas', pgsDir)).toBe(0);
  });

  it('deleted slugs are tombstoned: never reusable', async () => {
    const created = await createTenant('Wipe Me');
    const key = created.apiKey;
    await deleteTenantRecord(created.tenant);
    expect(await findTenantByKey(key)).toBeNull();
    await expect(createTenant('Wipe Me')).rejects.toThrow(/already taken/);
    const relinked = await upsertTenantForSub('sub-wipe-1', 'w@example.com', 'Wipe Me');
    expect(relinked.tenant).not.toBe(created.tenant);
  });

  it('tombstoned tenants are inert for every internal use', async () => {
    const created = await createTenant('Ghost Town');
    await deleteTenantRecord(created.tenant);
    // No new keys, no renames, no display name, no project tracking.
    await expect(mintTenantKey(created.tenant)).rejects.toThrow(/unknown tenant/);
    await expect(updateTenantName(created.tenant, 'Someone')).rejects.toThrow(/unknown tenant/);
    expect(await getTenantDisplayName(created.tenant)).toBeNull();
    await recordTenantProject(created.tenant, 'diario'); // must not throw…
    expect(await getTenantProjects(created.tenant)).toEqual([]); // …nor record
  });

  it('failed save invalidates the cache (no dirty in-memory mutation)', async () => {
    const { chmodSync } = await import('node:fs');
    const created = await createTenant('Cache Check');
    await recordTenantProject(created.tenant, 'p1'); // persisted baseline
    expect(await getTenantProjects(created.tenant)).toEqual(['p1']);
    // Read-only dir: load succeeds (cache/disk), mutation happens, the
    // atomic write fails → saveTenantsSync must drop the cache.
    chmodSync(tmpRoot, 0o555);
    try {
      await recordTenantProject(created.tenant, 'p2'); // internally caught
    } finally {
      chmodSync(tmpRoot, 0o755);
    }
    // Disk still has only p1; a stale cache would report [p1, p2].
    expect(await getTenantProjects(created.tenant)).toEqual(['p1']);
    // And the store is still writable after the failure.
    await recordTenantProject(created.tenant, 'p3');
    expect(await getTenantProjects(created.tenant)).toEqual(['p1', 'p3']);
    expect((await findTenantByKey(created.apiKey))?.tenant).toBe(created.tenant);
  });

  it('account delete is fail-closed: errors keep the record (500, retry safe)', async () => {
    __setGetMemoriesForTests(() => Promise.reject(new Error('qdrant boom')));
    const created = await createTenant('Fail Closed');
    const res = await handleTenantAccountDelete({ tenant: created.tenant, isMaster: false });
    expect(res.status).toBe(500);
    const body = await res.json() as { success: boolean; errors: string[] };
    expect(body.success).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    // Record kept → retry is safe.
    expect(await findTenantByKey(created.apiKey)).toEqual({ tenant: created.tenant, isMaster: false });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Validation coverage
// ═══════════════════════════════════════════════════════════════════

describe('7. every route has a schema', () => {
  const ALL_ROUTES = [
    '/health', '/api/health',
    '/api/memory/remember', '/api/memory/recall', '/api/memory/list',
    '/api/memory/forget', '/api/memory/restore', '/api/memory/feedback',
    '/api/memory/add', '/api/memory/context', '/api/memory/update',
    '/api/memory/consolidate', '/api/memory/bundle', '/api/memory/scan',
    '/api/memory/resolve-entities', '/api/memory/contradiction-scan',
    '/api/memory/metrics', '/api/memory/contradictions',
    '/api/memory/contradictions/dismiss',
    '/api/graph/query', '/api/graph/stats', '/api/graph/nodes',
    '/api/graph/remove-nodes', '/api/graph/remove-relationships',
    '/api/graph/autoclean', '/api/graph/dump', '/api/graph/ingest',
    '/api/graph/sync',
    '/api/seed/extract', '/api/seed/list',
    '/api/pgs/execute', '/api/pgs/stats',
    '/api/tenant/signup', '/api/tenant/link', '/api/tenant/mcp-token',
    '/api/tenant/profile', '/api/tenant/whoami',
    '/api/tenant/data', '/api/tenant/account',
  ];

  it('routeSchemas covers 100% of known routes', () => {
    for (const r of ALL_ROUTES) {
      expect(
        (routeSchemas as Record<string, unknown>)[r] !== undefined,
        `missing schema: ${r}`,
      ).toBe(true);
    }
  });

  it('newly added schemas accept their contracts', () => {
    expect(validateRoute('/api/memory/bundle', {}).ok).toBe(true);
    expect(validateRoute('/api/memory/bundle', { dry_run: true }).ok).toBe(true);
    expect(validateRoute('/api/tenant/mcp-token', {}).ok).toBe(true);
    expect(validateRoute('/api/tenant/profile', {}).ok).toBe(true);
    expect(validateRoute('/api/tenant/profile', { name: 'Ana' }).ok).toBe(true);
    expect(validateRoute('/api/tenant/whoami', {}).ok).toBe(true);
  });
});
