#!/usr/bin/env bun
/**
 * Tenant smoke (Fase 0 T5).
 *
 * HTTP end-to-end against a live lain-memory server (local or VPS):
 * signup → duplicate-409 → remember (raw) → recall (tenant finds it,
 * master does NOT — isolation) → wipe → recall empty.
 *
 *   LAIN_MEMORY_URL=http://localhost:3341 LAIN_API_KEY=<master> bun run smoke:tenant
 *
 * Raw mode avoids the LLM extraction path (embeddings still run server-side).
 * Leaves zero residue: the tenant is wiped at the end (the tenant record +
 * key hash remain in tenants.json, which is by design — keys stay revoked
 * only via wipe + manual record removal).
 */

const BASE = (process.env.LAIN_MEMORY_URL ?? 'http://localhost:3341').replace(/\/$/, '');
const MASTER = process.env.LAIN_API_KEY ?? '';
if (!MASTER) {
  console.error('LAIN_API_KEY is required (master key for the isolation check)');
  process.exit(1);
}

const MARKER = `smoke-tenant ${Date.now()}: the demo visitor prefers strong coffee with orange peel after debugging session cache issues on Fridays`;
const PROJECT = 'smoke-tenant-proj';

const failures: string[] = [];
function check(cond: boolean, label: string, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail.slice(0, 160)}` : ''}`);
  if (!cond) failures.push(label);
}

async function call(path: string, body: unknown, key?: string, method = 'POST'): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json: parsed };
}

try {
  const health = await call('/health', {}, MASTER);
  check(health.status === 200 && health.json?.ok, 'server reachable', JSON.stringify(health.json));

  // 1. signup (open) — unique name per run (tenant records persist by design)
  const smokeName = `Smoke Visitor ${Date.now().toString(36)}`;
  const signup = await call('/api/tenant/signup', { name: smokeName });
  check(signup.status === 201 && signup.json?.tenant && signup.json?.apiKey, 'signup creates tenant', JSON.stringify(signup.json));
  if (signup.status !== 201) throw new Error('signup failed — aborting');
  const { tenant, apiKey } = signup.json as { tenant: string; apiKey: string };

  // 2. duplicate name → 409
  const dup = await call('/api/tenant/signup', { name: smokeName });
  check(dup.status === 409, 'duplicate signup is 409', JSON.stringify(dup.json));

  // 3. remember (raw — no LLM extraction, still embedded server-side)
  const remembered = await call('/api/memory/remember', { text: MARKER, project: PROJECT, mode: 'raw' }, apiKey);
  const memId = remembered.json?.[0]?.id;
  check(remembered.status === 200 && memId && memId !== 'rejected', 'tenant remember stores (raw)', JSON.stringify(remembered.json));

  // 4a. tenant recall finds it
  const found = await call('/api/memory/recall', { query: 'strong coffee orange peel debugging session cache Fridays', project: PROJECT }, apiKey);
  const tenantFound = Array.isArray(found.json) && found.json.some((r: any) => r.id === memId || (r.memory ?? '').includes('orange peel'));
  check(found.status === 200 && tenantFound, 'tenant recall finds the memory', JSON.stringify(found.json)?.slice(0, 200));

  // 4b. master recall does NOT find it (isolation across user_id)
  const masterRecall = await call('/api/memory/recall', { query: 'strong coffee orange peel debugging session cache Fridays', project: PROJECT }, MASTER);
  const leaked = Array.isArray(masterRecall.json) && masterRecall.json.some((r: any) => (r.memory ?? '').includes('orange peel'));
  check(masterRecall.status === 200 && !leaked, 'master recall does not leak tenant memory', JSON.stringify(masterRecall.json)?.slice(0, 200));

  // 4c. unknown key → 401
  const anon = await call('/api/memory/recall', { query: 'x' }, 'lm_bogus');
  check(anon.status === 401, 'unknown key is 401', String(anon.status));

  // 5. wipe (DELETE, no body)
  const wipe = await call('/api/tenant/data', undefined, apiKey, 'DELETE');
  check(wipe.status === 200 && wipe.json?.success && (wipe.json?.deletedMemories ?? 0) >= 1,
    'wipe deletes tenant data', JSON.stringify(wipe.json));

  // 6. recall after wipe → empty
  const gone = await call('/api/memory/recall', { query: 'strong coffee orange peel', project: PROJECT }, apiKey);
  const stillThere = Array.isArray(gone.json) && gone.json.some((r: any) => (r.memory ?? '').includes('orange peel'));
  check(gone.status === 200 && !stillThere, 'recall after wipe is empty', JSON.stringify(gone.json)?.slice(0, 200));

  console.log(`tenant record kept by design: ${tenant} (key hash stays revoked-by-wipe in tenants.json)`);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!failures.includes(msg)) failures.push(msg);
  console.error(`SMOKE ERROR: ${msg}`);
}

if (failures.length > 0) {
  console.error(`smoke:tenant FAIL (${failures.length})`);
  process.exit(1);
}
console.log('smoke:tenant OK (signup → remember → isolated recall → wipe)');
