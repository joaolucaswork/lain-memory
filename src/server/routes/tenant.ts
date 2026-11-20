/**
 * Tenant routes (multitenant MVP).
 *
 * POST /api/tenant/signup — open (strict per-IP rate limit): {name} → {tenant, apiKey}
 * POST /api/tenant/wipe   — tenant bearer: deletes every memory scope, the
 *   tenant graph, the tenant blocklist and the project registry. Master key
 *   wipes only the `lucas` scope (never the shared legacy graph — use
 *   forget/scan for that; the graph wipe refuses master).
 *
 * Wipe is LGPD elimination, not trash: no undo window. Best-effort per
 * item (one bad id never aborts the sweep); counts are reported honestly.
 */

import { invalidateMem0Cache, deleteMemory } from '../../mem0.js';
import { deleteState } from '../../memory-state.js';
import {
  createTenant,
  getTenantProjects,
  MASTER_TENANT,
  deleteTenantBlocklistFile,
  listMemoriesForWipe,
  resetTenantName,
  resetTenantProjects,
  normalizeTenant,
  upsertTenantForSub,
} from '../../tenants.js';
import { getBlocklistPath } from '../../forget-blocklist.js';
import { removeTenantGraph, invalidateGraphCache, purgeTenantOutbox } from '../../graphrag.js';
import { TRASH_PROJECT } from '../../mem0/lifecycle.js';
import { json, requireMaster, tenantOf, type Handler } from '../http.js';

/**
 * Re-exported from tenants.ts (canonical home). Kept here so existing
 * import sites (`./tenant.js`) keep working.
 */
export { enforceTenantCap } from '../../tenants.js';

export const handleTenantSignup: Handler = async (data) => {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) return json({ error: 'name is required' }, 400);
  try {
    const created = await createTenant(name);
    return json(created, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Duplicate slug → 409 so the demo UI can prompt for another name.
    const status = msg.includes('already taken') ? 409 : 400;
    return json({ error: msg }, status);
  }
};

/**
 * Link a Supabase Auth user to a tenant (find-or-create + key rotation).
 * MASTER bearer only — the BFF calls this after validating the Supabase
 * access token server-side. Never open: it mints tenant keys.
 */
export const handleTenantLink: Handler = async (data) => {
  const gate = requireMaster(data);
  if (gate) return gate;
  const sub = typeof data.sub === 'string' ? data.sub.trim() : '';
  const email = typeof data.email === 'string' ? data.email.trim() : undefined;
  const name = typeof data.name === 'string' ? data.name.trim().slice(0, 40) : '';
  if (!sub) return json({ error: 'sub is required' }, 400);
  try {
    const linked = await upsertTenantForSub(sub, email, name || (email ?? 'user'));
    return json({ tenant: linked.tenant, apiKey: linked.apiKey, created: linked.created });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 400);
  }
};

/**
 * Who am I: resolve the bearer to its tenant slug (BFF session routing).
 * Any known key works (master → `lucas`); unknown keys never reach here
 * (dispatcher 401s first).
 */
export const handleTenantWhoami: Handler = async (data) => {
  return json({ tenant: normalizeTenant(data.tenant) || tenantOf(data) });
};

/**
 * Mint a dedicated MCP token for this tenant (remote per-account MCP).
 * Tenant bearer only (master uses LAIN_API_KEY directly → 400). The current
 * key drops into the 5-key ring, so existing sessions/cookies keep working.
 * Returns the plaintext key ONCE — store it in the MCP client config.
 */
export const handleTenantMcpToken: Handler = async (data) => {
  const tenant = normalizeTenant(data.tenant) || tenantOf(data);
  if (!tenant || tenant === MASTER_TENANT) {
    return json({ error: 'tenant only — master uses LAIN_API_KEY directly' }, 400);
  }
  try {
    const { mintTenantKey } = await import('../../tenants.js');
    const minted = await mintTenantKey(tenant);
    return json({ ok: true, tenant: minted.tenant, apiKey: minted.apiKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('unknown tenant') ? 404 : 400;
    return json({ error: msg }, status);
  }
};

/**
 * Canonical display name (profile edit).
 * GET → {name} (who the agent should call them; null = unknown).
 * POST {name} → validates + updates ONLY rec.name. The slug never changes
 * (it is the isolation identity). Master has no record → 400.
 */
export const handleTenantProfileGet: Handler = async (data) => {
  const tenant = normalizeTenant(data.tenant) || tenantOf(data);
  if (!tenant || tenant === MASTER_TENANT) {
    return json({ error: 'tenant only' }, 400);
  }
  const { getTenantDisplayName } = await import('../../tenants.js');
  return json({ ok: true, tenant, name: await getTenantDisplayName(tenant) });
};

export const handleTenantProfileUpdate: Handler = async (data) => {
  const tenant = normalizeTenant(data.tenant) || tenantOf(data);
  if (!tenant || tenant === MASTER_TENANT) {
    return json({ error: 'tenant only — master has no tenant record' }, 400);
  }
  try {
    const { updateTenantName } = await import('../../tenants.js');
    const updated = await updateTenantName(tenant, (data as Record<string, unknown>).name);
    return json({ ok: true, ...updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('unknown tenant') ? 404 : 400;
    return json({ error: msg }, status);
  }
};

export const handleTenantWipe: Handler = async (data) => {
  const tenant = normalizeTenant(data.tenant) || tenantOf(data);
  if (tenant === MASTER_TENANT) {
    return json({ error: 'master wipe is not supported — use forget/scan for lucas data' }, 403);
  }
  const t = tenant;
  const wiped = await wipeTenantData(t);
  try {
    await resetTenantProjects(t);
    await resetTenantName(t);
    await invalidateMem0Cache();
    await invalidateGraphCache();
  } catch (err) {
    wiped.errors.push(`cache/registry reset failed: ${err instanceof Error ? err.message : err}`);
  }

  return json({ success: true, tenant: t, ...wiped });
};

/**
 * Full account deletion (LGPD): same data sweep as the wipe, then the
 * tenant record is TOMBSTONED (key ring cleared, sub unlinked — the slug
 * stays reserved forever, never reusable). Fail-closed: when the sweep
 * reports errors, the record is KEPT and a 500 is returned so the caller
 * can retry safely instead of freeing a dirty slug. Returns `sub` so the
 * BFF can also delete the Supabase Auth user. Master → 403.
 */
export const handleTenantAccountDelete: Handler = async (data) => {
  const tenant = normalizeTenant(data.tenant) || tenantOf(data);
  if (tenant === MASTER_TENANT) {
    return json({ error: 'master account cannot be deleted via tenant route' }, 403);
  }
  const t = tenant;
  const wiped = await wipeTenantData(t);
  if (wiped.errors.length > 0) {
    try {
      await invalidateMem0Cache();
      await invalidateGraphCache();
    } catch { /* best-effort */ }
    return json({ success: false, tenant: t, ...wiped }, 500);
  }
  let sub: string | undefined;
  try {
    const { deleteTenantRecord } = await import('../../tenants.js');
    sub = (await deleteTenantRecord(t)).supabaseSub;
  } catch (err) {
    wiped.errors.push(`record purge failed: ${err instanceof Error ? err.message : err}`);
    return json({ success: false, tenant: t, sub, ...wiped }, 500);
  }
  try {
    await invalidateMem0Cache();
    await invalidateGraphCache();
  } catch (err) {
    wiped.errors.push(`cache reset failed: ${err instanceof Error ? err.message : err}`);
    return json({ success: false, tenant: t, sub, ...wiped }, 500);
  }

  return json({ success: true, tenant: t, sub, ...wiped });
};

/**
 * Data sweep shared by wipe (record stays) and account delete (tombstone).
 * Best-effort per item; counts reported honestly. Never throws — errors
 * accumulate in `errors` so a partial sweep is always reported, not lost.
 */
export async function wipeTenantData(t: string): Promise<{
  deletedMemories: number;
  removedNodes: number;
  purgedOutbox: number;
  deletedSeeds: number;
  deletedSessions: number;
  errors: string[];
}> {
  let deletedMemories = 0;
  const errors: string[] = [];

  // Every scope the tenant ever wrote to, plus the global scope and trash.
  const scopes: Array<string | undefined> = [undefined, TRASH_PROJECT];
  try {
    for (const p of await getTenantProjects(t)) scopes.push(p);
  } catch (err) {
    errors.push(`project registry unreadable: ${err instanceof Error ? err.message : err}`);
  }

  for (const scope of scopes) {
    for (;;) {
      let batch: Awaited<ReturnType<typeof listMemoriesForWipe>>;
      try {
        batch = await listMemoriesForWipe(scope, 200, t);
      } catch (err) {
        errors.push(`list ${scope ?? 'global'} failed: ${err instanceof Error ? err.message : err}`);
        break;
      }
      if (batch.length === 0) break;
      for (const mem of batch) {
        try {
          await deleteMemory(mem.id);
          try { await deleteState(mem.id); } catch { /* best-effort */ }
          deletedMemories++;
        } catch (err) {
          errors.push(`delete ${mem.id} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (batch.length < 200) break;
    }
  }

  // Derived projection + outbox + blocklist + registry.
  let removedNodes = 0;
  let purgedOutbox = 0;
  let deletedSeeds = 0;
  let deletedSessions = 0;
  try {
    purgedOutbox = purgeTenantOutbox(t);
  } catch (err) {
    errors.push(`outbox purge failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    removedNodes = await removeTenantGraph(t);
  } catch (err) {
    errors.push(`graph wipe failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    await deleteTenantBlocklistFile(getBlocklistPath(t));
  } catch (err) {
    errors.push(`blocklist wipe failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const { deleteTenantSeeds } = await import('../../seed-extraction.js');
    deletedSeeds = deleteTenantSeeds(t);
  } catch (err) {
    errors.push(`seeds wipe failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const { deleteTenantPgsSessions } = await import('../../pgs/session.js');
    const { PGS_SESSIONS_DIR } = await import('../../workspace.js');
    deletedSessions = deleteTenantPgsSessions(t, PGS_SESSIONS_DIR);
  } catch (err) {
    errors.push(`pgs sessions wipe failed: ${err instanceof Error ? err.message : err}`);
  }

  return { deletedMemories, removedNodes, purgedOutbox, deletedSeeds, deletedSessions, errors };
}
