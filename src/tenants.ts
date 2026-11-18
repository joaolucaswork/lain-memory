/**
 * Multitenant identity (MVP demo).
 *
 * WHY: single user_id `lucas` can't serve the Instagram demo. Tenant =
 * namespace: every backend scope (Mem0 user_id, graph node ids, blocklist,
 * caches) keys off the tenant resolved from the bearer key. Master key
 * (LAIN_API_KEY) keeps working and maps to the legacy `lucas` tenant, so
 * all pre-tenant data stays byte-identical.
 *
 * Store: a single JSON file in the workspace, atomic writes (temp + rename)
 * via safeWriteFileSync, serialized per-file via withFileLock. Mode 0600 —
 * it holds key hashes (not the keys themselves: only sha256 is persisted,
 * the plaintext key is shown once at signup).
 */

import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { withFileLock, safeWriteFileSync } from './file-io-lock.js';
import { WORKSPACE_DIR } from './workspace.js';
import { TtlCache } from './lib/ttl-cache.js';

/** Legacy single-user tenant. Master bearer key maps here; scoping is a no-op. */
export const MASTER_TENANT = 'lucas';

/** Tenant slugs that would collide with system scopes. */
const RESERVED_SLUGS = new Set(['lucas', 'admin', 'trash', 'global', 'api', 'root', 'system']);

/** Max Mem0 scopes... capped per tenant+project scope (see enforceTenantCap). */
export const TENANT_MEMORY_CAP = 500;

/** Sustained write/read budget per tenant (sliding-ish 60s window, in-memory). */
const RATE_LIMIT_PER_MIN = 60;

/** Signup abuse budget per IP (1h window, in-memory). */
const SIGNUP_MAX_PER_HOUR = 10;

export interface TenantRecord {
  tenant: string;
  name: string;
  keyHash: string;
  createdAt: string;
  /** Mem0 project scopes this tenant has written to (for wipe enumeration). */
  projects: string[];
  /** Supabase Auth user id linked to this tenant (null = legacy name-only demo tenant). */
  supabaseSub?: string;
  /** Login email (display + future password-reset; never a secret). */
  email?: string;
}

type TenantFile = Record<string, TenantRecord>;

export const TENANTS_FILENAME = 'tenants.json';

/** Test override (same pattern as forget-blocklist). Null = production path. */
let _pathOverride: string | null = null;

export function getTenantsPath(): string {
  return _pathOverride ?? join(WORKSPACE_DIR, TENANTS_FILENAME);
}

/** Test-only: redirect the tenants file (pass null to restore). */
export function __setTenantsPathForTests(p: string | null): void {
  _pathOverride = p;
}

export function masterApiKey(): string {
  return process.env.LAIN_API_KEY ?? '';
}

export function hashTenantKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Canonical tenant form: lowercase alnum + hyphens. Empty/unknown → ''.
 * WHY lowercase: Mem0 user_id and graph scopes must be stable regardless of
 * how the tenant string arrives (header, env, stored record).
 */
export function normalizeTenant(t: string | undefined | null): string {
  if (!t) return '';
  return t.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || '';
}

/**
 * Slugify a display name: accents stripped, spaces → '-', max 32 chars.
 * Returns '' when nothing usable remains.
 */
export function slugifyTenantName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug;
}

export function validateTenantSlug(slug: string): { ok: true } | { ok: false; error: string } {
  if (slug.length < 2) return { ok: false, error: 'name too short (min 2 usable characters)' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: `name '${slug}' is reserved` };
  return { ok: true };
}

function loadTenantsSync(): TenantFile {
  const file = getTenantsPath();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}; // fresh install — no tenants yet
    }
    throw err;
  }
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`tenants file corrupt (invalid JSON): ${file}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`tenants file corrupt (expected object): ${file}`);
  }
  return parsed as TenantFile;
}

function saveTenantsSync(records: TenantFile): void {
  const file = getTenantsPath();
  mkdirSync(dirname(file), { recursive: true });
  // 0600: holds key hashes. safeWriteFileSync is atomic (temp + rename).
  safeWriteFileSync(file, JSON.stringify(records, null, 2), 0o600);
}

export interface TenantIdentity {
  tenant: string;
  isMaster: boolean;
}

/**
 * Resolve the bearer key to a tenant. Master key → `lucas` (compat).
 * Returns null for unknown keys (caller answers 401). Reads never throw —
 * a corrupt/unreadable file fails closed (null) so a broken store can't
 * leak one tenant's data into another's scope.
 */
export async function findTenantByKey(key: string): Promise<TenantIdentity | null> {
  if (!key) return null;
  const master = masterApiKey();
  if (master && key === master) return { tenant: MASTER_TENANT, isMaster: true };
  try {
    const file = getTenantsPath();
    return await withFileLock(file, () => {
      const records = loadTenantsSync();
      const hash = hashTenantKey(key);
      for (const rec of Object.values(records)) {
        if (rec.keyHash === hash) return { tenant: rec.tenant, isMaster: false };
      }
      return null;
    });
  } catch (err) {
    console.error('[tenants] lookup failed — failing closed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Create a tenant from a display name. Throws on validation/duplicate/I/O —
 * signup is fail-hard (a half-created tenant must surface, not 200 with
 * nothing stored). Returns the plaintext key ONCE (only the hash persists).
 */
export async function createTenant(displayName: string): Promise<{ tenant: string; apiKey: string }> {
  const slug = slugifyTenantName(displayName);
  const valid = validateTenantSlug(slug);
  if (!valid.ok) throw new Error((valid as { error: string }).error);
  const apiKey = `lm_${randomBytes(24).toString('hex')}`;
  const file = getTenantsPath();
  await withFileLock(file, () => {
    const records = loadTenantsSync();
    if (records[slug]) throw new Error(`name '${slug}' is already taken`);
    records[slug] = {
      tenant: slug,
      name: displayName.trim().slice(0, 40),
      keyHash: hashTenantKey(apiKey),
      createdAt: new Date().toISOString(),
      projects: [],
    };
    saveTenantsSync(records);
  });
  return { tenant: slug, apiKey };
}

/**
 * Find a tenant record by linked Supabase Auth user id. Null when unlinked.
 * Never throws (lookup is best-effort; callers fail closed on null).
 */
export async function findTenantBySub(sub: string): Promise<TenantRecord | null> {
  if (!sub) return null;
  const file = getTenantsPath();
  try {
    return await withFileLock(file, () => {
      const records = loadTenantsSync();
      for (const rec of Object.values(records)) {
        if (rec.supabaseSub === sub) return rec;
      }
      return null;
    });
  } catch (err) {
    console.error('[tenants] findTenantBySub failed — failing closed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Find-or-create a tenant for a Supabase Auth user (called by the BFF after
 * validating the access token — master bearer only).
 *
 * The apiKey ROTATES on every call: only the hash persists, so a fresh key
 * is issued per login and older cookies for the same tenant stop working
 * (single active session per tenant in the MVP). Returns created=true only
 * for brand-new tenants.
 */
export async function upsertTenantForSub(
  sub: string,
  email: string | undefined,
  displayName: string
): Promise<{ tenant: string; apiKey: string; created: boolean }> {
  if (!sub || sub.length > 200) throw new Error('sub is required (max 200 chars)');
  const cleanEmail = (email ?? '').trim().slice(0, 160);
  const apiKey = `lm_${randomBytes(24).toString('hex')}`;
  const file = getTenantsPath();
  let result: { tenant: string; apiKey: string; created: boolean };
  await withFileLock(file, () => {
    const records = loadTenantsSync();
    for (const rec of Object.values(records)) {
      if (rec.supabaseSub === sub) {
        rec.keyHash = hashTenantKey(apiKey);
        if (cleanEmail) rec.email = cleanEmail;
        saveTenantsSync(records);
        result = { tenant: rec.tenant, apiKey, created: false };
        return;
      }
    }
    // New tenant: slug from display name (or email prefix), suffixed on collision.
    const fallbackBase = slugifyTenantName(cleanEmail.split('@')[0] ?? '') || 'user';
    const base = slugifyTenantName(displayName) || fallbackBase;
    let slug = RESERVED_SLUGS.has(base) ? `${base}-user` : base;
    for (let n = 2; records[slug] && n < 1000; n++) slug = `${base}-${n}`;
    if (records[slug]) throw new Error(`name '${base}' is already taken`);
    records[slug] = {
      tenant: slug,
      name: displayName.trim().slice(0, 40) || cleanEmail.split('@')[0]?.slice(0, 40) || slug,
      keyHash: hashTenantKey(apiKey),
      createdAt: new Date().toISOString(),
      projects: [],
      supabaseSub: sub,
      ...(cleanEmail ? { email: cleanEmail } : {}),
    };
    saveTenantsSync(records);
    result = { tenant: slug, apiKey, created: true };
  });
  return result!;
}

/** Record a project scope the tenant wrote to (best-effort, for wipe). */
export async function recordTenantProject(tenant: string, project: string | undefined): Promise<void> {
  const t = normalizeTenant(tenant);
  if (!t || t === MASTER_TENANT || !project) return;
  const clean = project.trim().slice(0, 100);
  if (!clean) return;
  const file = getTenantsPath();
  try {
    await withFileLock(file, () => {
      const records = loadTenantsSync();
      const rec = records[t];
      if (!rec) return;
      if (!rec.projects.includes(clean)) {
        rec.projects = [...rec.projects, clean].slice(-200);
        saveTenantsSync(records);
      }
    });
  } catch (err) {
    // Non-critical: wipe falls back to global + graph enumeration.
    console.error('[tenants] recordTenantProject failed:', err instanceof Error ? err.message : err);
  }
}

/** Project scopes known for a tenant ([] when unknown — never throws). */
export async function getTenantProjects(tenant: string): Promise<string[]> {
  const t = normalizeTenant(tenant);
  if (!t || t === MASTER_TENANT) return [];
  try {
    const file = getTenantsPath();
    return await withFileLock(file, () => loadTenantsSync()[t]?.projects ?? []);
  } catch {
    return [];
  }
}

/** Clear the project registry (wipe flow keeps the tenant + key). */
export async function resetTenantProjects(tenant: string): Promise<void> {
  const t = normalizeTenant(tenant);
  if (!t || t === MASTER_TENANT) return;
  const file = getTenantsPath();
  try {
    await withFileLock(file, () => {
      const records = loadTenantsSync();
      if (records[t]) {
        records[t].projects = [];
        saveTenantsSync(records);
      }
    });
  } catch (err) {
    console.error('[tenants] resetTenantProjects failed:', err instanceof Error ? err.message : err);
  }
}

/** Delete the per-tenant blocklist file (wipe flow). Missing file = no-op. */
export async function deleteTenantBlocklistFile(path: string): Promise<void> {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      console.error('[tenants] blocklist delete failed:', err instanceof Error ? err.message : err);
    }
  }
}

// ─── Rate limits (in-memory TTL, single-instance — same contract as TtlCache) ───

const tenantMinuteBudget = new TtlCache<number>({ maxEntries: 5000 });
const signupHourBudget = new TtlCache<number>({ maxEntries: 1000 });

/** True when the call fits the 60 req/min tenant budget (and counts it). */
export function checkTenantRateLimit(tenant: string): boolean {
  const key = `ratelimit:${normalizeTenant(tenant) || 'unknown'}`;
  const used = tenantMinuteBudget.get(key) ?? 0;
  if (used >= RATE_LIMIT_PER_MIN) return false;
  tenantMinuteBudget.set(key, used + 1, 60);
  return true;
}

/** True when a signup from this IP fits the 10/hour anti-abuse budget. */
export function checkSignupAllowed(ip: string): boolean {
  const key = `signup:${ip || 'unknown'}`;
  const used = signupHourBudget.get(key) ?? 0;
  if (used >= SIGNUP_MAX_PER_HOUR) return false;
  signupHourBudget.set(key, used + 1, 3600);
  return true;
}
