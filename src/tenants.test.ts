/**
 * Multitenant identity tests (Fase 0 T5).
 *
 * Pure unit tests — no Qdrant, no LLM, no network. The tenants store is
 * redirected to a temp file via __setTenantsPathForTests so production
 * state is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  MASTER_TENANT,
  TENANT_MEMORY_CAP,
  __setTenantsPathForTests,
  checkSignupAllowed,
  checkTenantRateLimit,
  createTenant,
  deleteTenantRecord,
  findTenantByKey,
  findTenantBySub,
  getTenantDisplayName,
  getTenantProjects,
  hashTenantKey,
  mintTenantKey,
  normalizeTenant,
  recordTenantProject,
  resetTenantName,
  resetTenantProjects,
  sanitizeTenantDisplayName,
  slugifyTenantName,
  updateTenantName,
  upsertTenantForSub,
  validateTenantSlug,
} from './tenants.js';
import { userId } from './mem0/config.js';
import { getBlocklistPath } from './forget-blocklist.js';
import {
  isNodeVisibleToProject,
  scopedId,
  tenantBase,
  tenantScope,
} from './graphrag/store.js';

function tempTenantsFile(): string {
  return join(tmpdir(), `lain-tenants-test-${randomBytes(6).toString('hex')}.json`);
}

beforeEach(() => {
  __setTenantsPathForTests(tempTenantsFile());
});

afterEach(() => {
  __setTenantsPathForTests(null);
});

describe('slugifyTenantName', () => {
  it('lowercases, strips accents, spaces become dashes', () => {
    expect(slugifyTenantName('João Lucas')).toBe('joao-lucas');
  });

  it('drops symbols and collapses dashes', () => {
    expect(slugifyTenantName('  Ana!@#_Maria  ')).toBe('ana-maria');
  });

  it('returns empty when nothing usable remains', () => {
    expect(slugifyTenantName('!!!')).toBe('');
  });

  it('caps length at 32 chars', () => {
    expect(slugifyTenantName('a'.repeat(50)).length).toBeLessThanOrEqual(32);
  });
});

describe('validateTenantSlug', () => {
  it('rejects short and reserved slugs', () => {
    expect(validateTenantSlug('a')).toEqual({ ok: false, error: expect.any(String) });
    for (const reserved of ['lucas', 'admin', 'trash', 'global']) {
      expect(validateTenantSlug(reserved).ok).toBe(false);
    }
  });

  it('accepts a normal slug', () => {
    expect(validateTenantSlug('ana-maria').ok).toBe(true);
  });
});

describe('normalizeTenant', () => {
  it('lowercases and strips invalid chars', () => {
    expect(normalizeTenant(' Ana_Maria! ')).toBe('anamaria');
  });

  it('empty/undefined stay empty', () => {
    expect(normalizeTenant('')).toBe('');
    expect(normalizeTenant(undefined)).toBe('');
    expect(normalizeTenant(null)).toBe('');
  });
});

describe('tenant store', () => {
  it('creates a tenant and resolves its key', async () => {
    const created = await createTenant('Ana Maria');
    expect(created.tenant).toBe('ana-maria');
    expect(created.apiKey.startsWith('lm_')).toBe(true);

    const found = await findTenantByKey(created.apiKey);
    expect(found).toEqual({ tenant: 'ana-maria', isMaster: false });
  });

  it('rejects duplicate display names (409 path)', async () => {
    await createTenant('Ana');
    await expect(createTenant('ana')).rejects.toThrow('already taken');
  });

  it('rejects reserved and empty names', async () => {
    await expect(createTenant('lucas')).rejects.toThrow('reserved');
    await expect(createTenant('!!!')).rejects.toThrow('too short');
  });

  it('unknown keys resolve to null (fail-closed 401 path)', async () => {
    expect(await findTenantByKey('lm_nonexistent')).toBeNull();
    expect(await findTenantByKey('')).toBeNull();
  });

  it('master key maps to the lucas tenant', async () => {
    const prev = process.env.LAIN_API_KEY;
    process.env.LAIN_API_KEY = 'master-secret';
    try {
      expect(await findTenantByKey('master-secret')).toEqual({ tenant: MASTER_TENANT, isMaster: true });
      expect(await findTenantByKey('lm_nope')).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.LAIN_API_KEY;
      else process.env.LAIN_API_KEY = prev;
    }
  });

  it('keys are stored hashed, never plaintext', async () => {
    const { readFileSync } = await import('node:fs');
    const { getTenantsPath } = await import('./tenants.js');
    const created = await createTenant('Beto');
    const raw = readFileSync(getTenantsPath(), 'utf8');
    expect(raw).not.toContain(created.apiKey);
    expect(raw).toContain(hashTenantKey(created.apiKey));
  });

  it('tracks projects per tenant for wipe enumeration', async () => {
    const { tenant } = await createTenant('Carol');
    expect(await getTenantProjects(tenant)).toEqual([]);
    await recordTenantProject(tenant, 'diario');
    await recordTenantProject(tenant, 'diario'); // idempotent
    await recordTenantProject(tenant, undefined); // ignored
    expect(await getTenantProjects(tenant)).toEqual(['diario']);
    await recordTenantProject('lucas', 'diario'); // master not tracked
    expect(await getTenantProjects('lucas')).toEqual([]);
    await resetTenantProjects(tenant);
    expect(await getTenantProjects(tenant)).toEqual([]);
  });
});

describe('supabase sub linking', () => {
  it('creates a tenant on first link and finds it by sub', async () => {
    const linked = await upsertTenantForSub('sub-123', 'ana@example.com', 'Ana');
    expect(linked.created).toBe(true);
    expect(linked.tenant).toBe('ana');
    const found = await findTenantBySub('sub-123');
    expect(found?.tenant).toBe('ana');
    expect(found?.email).toBe('ana@example.com');
  });

  it('rotates the key on re-login, old cookie keeps working (ring)', async () => {
    const first = await upsertTenantForSub('sub-456', 'beto@example.com', 'Beto');
    const second = await upsertTenantForSub('sub-456', 'beto@example.com', 'Beto');
    expect(second.created).toBe(false);
    expect(second.tenant).toBe(first.tenant);
    expect(second.apiKey).not.toBe(first.apiKey);
    // History continuity: both keys resolve (multi-device), same slug.
    expect(await findTenantByKey(first.apiKey)).toEqual({ tenant: first.tenant, isMaster: false });
    expect(await findTenantByKey(second.apiKey)).toEqual({ tenant: first.tenant, isMaster: false });
  });

  it('evicts the oldest key past the ring cap', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await upsertTenantForSub('sub-ring', 'ring@example.com', 'Ring');
      expect(r.created).toBe(i === 0);
      keys.push(r.apiKey);
    }
    expect(await findTenantByKey(keys[0])).toBeNull();
    expect(await findTenantByKey(keys[5])).toEqual({ tenant: 'ring', isMaster: false });
  });

  it('mints a fresh MCP token, old session key keeps working', async () => {
    const created = await createTenant('Mcp');
    const minted = await mintTenantKey(created.tenant);
    expect(minted.tenant).toBe(created.tenant);
    expect(minted.apiKey).not.toBe(created.apiKey);
    expect(await findTenantByKey(created.apiKey)).toEqual({ tenant: created.tenant, isMaster: false });
    expect(await findTenantByKey(minted.apiKey)).toEqual({ tenant: created.tenant, isMaster: false });
  });

  it('mint refuses master and unknown tenants', async () => {
    await expect(mintTenantKey('lucas')).rejects.toThrow();
    await expect(mintTenantKey('nope')).rejects.toThrow();
  });
});

describe('account deletion', () => {
  it('tombstones the record: key stops resolving, sub unlinks, slug stays reserved', async () => {
    const linked = await upsertTenantForSub('sub-bye', 'bye@example.com', 'Bye');
    const removed = await deleteTenantRecord(linked.tenant);
    expect(removed.supabaseSub).toBe('sub-bye');
    expect(await findTenantByKey(linked.apiKey)).toBeNull();
    expect(await findTenantBySub('sub-bye')).toBeNull();
    // Tombstone: the slug is NEVER reusable (no orphan-data inheritance).
    await expect(createTenant('Bye')).rejects.toThrow('already taken');
    // Re-linking the same identity gets a suffixed slug, never the old one.
    const relinked = await upsertTenantForSub('sub-bye', 'bye@example.com', 'Bye');
    expect(relinked.created).toBe(true);
    expect(relinked.tenant).toBe(`${linked.tenant}-2`);
    expect(relinked.tenant).not.toBe(linked.tenant);
  });

  it('refuses master and unknown tenants', async () => {
    await expect(deleteTenantRecord('lucas')).rejects.toThrow();
    await expect(deleteTenantRecord('nope')).rejects.toThrow();
  });
});

describe('canonical display name', () => {
  it('sanitiza igual ao BFF (controles viram espaço, aspas caem)', () => {
    expect(sanitizeTenantDisplayName('  Ana  ')).toEqual({ ok: true, name: 'Ana' });
    expect(sanitizeTenantDisplayName('a').ok).toBe(false);
    expect(sanitizeTenantDisplayName(null).ok).toBe(false);
    expect(sanitizeTenantDisplayName('Ana\n"admin"')).toEqual({ ok: true, name: 'Ana admin' });
    const long = sanitizeTenantDisplayName('x'.repeat(50));
    expect(long.ok && (long as { name: string }).name.length).toBe(40);
  });

  it('update troca só o nome: slug, key e dados intactos', async () => {
    const created = await createTenant('Beto');
    const updated = await updateTenantName(created.tenant, 'Roberto');
    expect(updated).toEqual({ tenant: created.tenant, name: 'Roberto' });
    // Slug é identidade: não mudou; a key antiga continua válida.
    expect(await getTenantDisplayName(created.tenant)).toBe('Roberto');
    expect(await findTenantByKey(created.apiKey)).toEqual({ tenant: created.tenant, isMaster: false });
  });

  it('update recusa master, desconhecido e nome inválido', async () => {
    await expect(updateTenantName('lucas', 'X')).rejects.toThrow();
    await expect(updateTenantName('nope', 'Ana')).rejects.toThrow();
    const created = await createTenant('Carol');
    await expect(updateTenantName(created.tenant, 'x')).rejects.toThrow();
    expect(await getTenantDisplayName(created.tenant)).toBe('Carol');
  });

  it('reset volta o nome para o slug (wipe: nome é PII, registro fica)', async () => {
    const created = await createTenant('Daniel');
    await updateTenantName(created.tenant, 'Dan');
    await resetTenantName(created.tenant);
    expect(await getTenantDisplayName(created.tenant)).toBe(created.tenant);
    expect(await findTenantByKey(created.apiKey)).toEqual({ tenant: created.tenant, isMaster: false });
  });

  it('get retorna null para master e desconhecido', async () => {
    expect(await getTenantDisplayName('lucas')).toBeNull();
    expect(await getTenantDisplayName('nope')).toBeNull();
  });

  it('suffixes slug on collision with a legacy tenant', async () => {
    await createTenant('Carol');
    const linked = await upsertTenantForSub('sub-789', 'carol@example.com', 'Carol');
    expect(linked.created).toBe(true);
    expect(linked.tenant).toBe('carol-2');
  });

  it('unknown sub resolves to null', async () => {
    expect(await findTenantBySub('sub-nope')).toBeNull();
    expect(await findTenantBySub('')).toBeNull();
  });
});

describe('rate limits', () => {
  it('allows 60 req/min per tenant, then denies', () => {
    const t = `t-${randomBytes(4).toString('hex')}`;
    for (let i = 0; i < 60; i++) expect(checkTenantRateLimit(t)).toBe(true);
    expect(checkTenantRateLimit(t)).toBe(false);
  });

  it('budgets are per-tenant', () => {
    const a = `a-${randomBytes(4).toString('hex')}`;
    const b = `b-${randomBytes(4).toString('hex')}`;
    for (let i = 0; i < 60; i++) checkTenantRateLimit(a);
    expect(checkTenantRateLimit(a)).toBe(false);
    expect(checkTenantRateLimit(b)).toBe(true);
  });

  it('allows 10 signups/hour per IP, then denies', () => {
    const ip = `9.9.9.${randomBytes(1)[0]}`;
    for (let i = 0; i < 10; i++) expect(checkSignupAllowed(ip)).toBe(true);
    expect(checkSignupAllowed(ip)).toBe(false);
  });
});

describe('userId', () => {
  it('master reproduces the legacy scheme byte-identical', () => {
    expect(userId()).toBe('lucas');
    expect(userId('diario')).toBe('lucas:diario');
    expect(userId('latency fixes')).toBe('lucas:latency_fixes');
  });

  it('tenants namespace by slug', () => {
    expect(userId(undefined, 'ana-maria')).toBe('ana-maria');
    expect(userId('diario', 'ana-maria')).toBe('ana-maria:diario');
  });

  it('empty tenant falls back to master', () => {
    expect(userId('diario', '')).toBe('lucas:diario');
  });
});

describe('tenant blocklist paths', () => {
  it('master keeps the legacy file', () => {
    expect(getBlocklistPath('lucas')).toContain('forget-blocklist.json');
    expect(getBlocklistPath('lucas')).not.toContain('forget-blocklist-lucas');
  });

  it('each tenant gets its own file', () => {
    const p = getBlocklistPath('ana-maria');
    expect(p).toContain('forget-blocklist-ana-maria.json');
    expect(p).not.toBe(getBlocklistPath('beto'));
  });
});

describe('graph tenant scoping', () => {
  it('master scopes are unchanged (legacy byte-identical)', () => {
    expect(scopedId('Lain', 'Diario')).toBe('diario::lain');
    expect(scopedId('Lain')).toBe('lain');
    expect(tenantScope('lucas', 'Diario')).toBe('diario');
    expect(tenantScope('lucas')).toBeUndefined();
    expect(tenantBase('lucas')).toBeNull();
  });

  it('tenants get tn- prefixed scopes', () => {
    expect(scopedId('Lain', 'Diario', 'ana')).toBe('tn-ana--diario::lain');
    expect(scopedId('Lain', undefined, 'ana')).toBe('tn-ana::lain');
    expect(tenantBase('ana')).toBe('tn-ana');
  });

  it('tenant nodes are invisible to master scoped reads and lucas globals invisible to tenants', () => {
    // Master scoped read: own data visible, tenant data not.
    expect(isNodeVisibleToProject('diario::x', 'diario', 'lucas')).toBe(true);
    expect(isNodeVisibleToProject('y', 'diario', 'lucas')).toBe(true);
    expect(isNodeVisibleToProject('tn-ana::y', 'diario', 'lucas')).toBe(false);
    expect(isNodeVisibleToProject('tn-ana--diario::y', 'diario', 'lucas')).toBe(false);
    // Tenant reads: only own nodes, project filter respected.
    expect(isNodeVisibleToProject('tn-ana::y', undefined, 'ana')).toBe(true);
    expect(isNodeVisibleToProject('tn-ana--diario::y', 'diario', 'ana')).toBe(true);
    expect(isNodeVisibleToProject('tn-ana--outro::y', 'diario', 'ana')).toBe(false);
    expect(isNodeVisibleToProject('tn-ana::y', 'diario', 'ana')).toBe(true); // tenant-global always visible
    expect(isNodeVisibleToProject('y', undefined, 'ana')).toBe(false); // lucas legacy global
    expect(isNodeVisibleToProject('diario::y', 'diario', 'ana')).toBe(false); // lucas project node
    expect(isNodeVisibleToProject('tn-beto::y', undefined, 'ana')).toBe(false); // other tenant
  });

  it('prefix boundary: ana never sees ana2 nodes', () => {
    expect(isNodeVisibleToProject('tn-ana2::y', undefined, 'ana')).toBe(false);
    expect(isNodeVisibleToProject('tn-ana2--diario::y', 'diario', 'ana')).toBe(false);
    expect(isNodeVisibleToProject('tn-ana2::y', undefined, 'ana2')).toBe(true);
  });

  it('cap constant is sane', () => {
    expect(TENANT_MEMORY_CAP).toBe(500);
  });
});
