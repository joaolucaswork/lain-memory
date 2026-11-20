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

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { withFileLock, safeWriteFileSync } from './file-io-lock.js';
import { WORKSPACE_DIR } from './workspace.js';

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
  /** Current key hash (rotated per login). */
  keyHash: string;
  /** Previous key hashes still accepted (multi-device; capped). */
  pastKeyHashes: string[];
  createdAt: string;
  /** Mem0 project scopes this tenant has written to (for wipe enumeration). */
  projects: string[];
  /** Supabase Auth user id linked to this tenant (null = legacy name-only demo tenant). */
  supabaseSub?: string;
  /** Login email (display + future password-reset; never a secret). */
  email?: string;
  /** Tombstone marker: set when the account was deleted. Slug stays reserved. */
  deletedAt?: string;
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
  tenantFileCache = null;
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
  // Fast path: cached records when the file mtime is unchanged.
  try {
    const cached = tenantFileCache;
    if (cached && cached.file === file) {
      try {
        const st = statSync(file);
        if (st.mtimeMs === cached.mtimeMs) return cached.records;
      } catch {
        if (cached.missing) return cached.records;
      }
    }
  } catch { /* fall through to disk read */ }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      tenantFileCache = { file, mtimeMs: 0, missing: true, records: {} };
      return {}; // fresh install — no tenants yet
    }
    throw err;
  }
  if (!raw.trim()) {
    try {
      const st = statSync(file);
      tenantFileCache = { file, mtimeMs: st.mtimeMs, records: {} };
    } catch {}
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`tenants file corrupt (invalid JSON): ${file}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`tenants file corrupt (expected object): ${file}`);
  }
  try {
    const st = statSync(file);
    tenantFileCache = { file, mtimeMs: st.mtimeMs, records: parsed as TenantFile };
  } catch {
    tenantFileCache = { file, mtimeMs: 0, records: parsed as TenantFile };
  }
  return parsed as TenantFile;
}

interface TenantFileCache {
  file: string;
  mtimeMs: number;
  missing?: boolean;
  records: TenantFile;
}

let tenantFileCache: TenantFileCache | null = null;

/** Test-only: clear the in-memory tenants file cache. */
export function __clearTenantsCacheForTests(): void {
  tenantFileCache = null;
}

function saveTenantsSync(records: TenantFile): void {
  const file = getTenantsPath();
  mkdirSync(dirname(file), { recursive: true });
  // 0600: holds key hashes. safeWriteFileSync is atomic (temp + rename).
  safeWriteFileSync(file, JSON.stringify(records, null, 2), 0o600);
  try {
    const st = statSync(file);
    tenantFileCache = { file, mtimeMs: st.mtimeMs, records };
  } catch {
    tenantFileCache = null;
  }
}

export interface TenantIdentity {
  tenant: string;
  isMaster: boolean;
}

/**
 * Resolve the bearer key to a tenant. Master key → `lucas` (compat).
 * Tenant keys match the current hash OR any hash in the rotation ring
 * (multi-device: older cookies keep working until evicted).
 * Returns null for unknown keys (caller answers 401). Reads never throw —
 * a corrupt/unreadable file fails closed (null) so a broken store can't
 * leak one tenant's data into another's scope.
 */
export async function findTenantByKey(key: string): Promise<TenantIdentity | null> {
  if (!key) return null;
  const master = masterApiKey();
  // Constant-time master comparison (no early-exit oracle on prefix).
  if (master) {
    if (key.length === master.length) {
      try {
        if (timingSafeEqual(Buffer.from(key), Buffer.from(master))) {
          return { tenant: MASTER_TENANT, isMaster: true };
        }
      } catch {
        if (key === master) return { tenant: MASTER_TENANT, isMaster: true };
      }
    } else if (key === master) {
      return { tenant: MASTER_TENANT, isMaster: true };
    }
  }
  try {
    const file = getTenantsPath();
    return await withFileLock(file, () => {
      const records = loadTenantsSync();
      const hash = hashTenantKey(key);
      const eq = (a: string, b: string): boolean => {
        if (!a || a.length !== b.length) return false;
        try {
          return timingSafeEqual(Buffer.from(a), Buffer.from(b));
        } catch {
          return a === b;
        }
      };
      for (const rec of Object.values(records)) {
        if (rec.deletedAt) continue; // tombstone: no keys, never resolves
        if (rec.keyHash && eq(rec.keyHash, hash)) return { tenant: rec.tenant, isMaster: false };
        if (Array.isArray(rec.pastKeyHashes) && rec.pastKeyHashes.includes(hash)) {
          return { tenant: rec.tenant, isMaster: false };
        }
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
      pastKeyHashes: [],
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
 * The apiKey ROTATES on every call: only hashes persist, so a fresh key is
 * issued per login. Previous keys stay valid in a small ring (multi-device;
 * oldest evicted past RING_CAP). Returns created=true only for brand-new
 * tenants. History continuity comes from the slug-stable session dir, not
 * the key — rotation never orphans transcripts.
 */
const KEY_RING_CAP = 5;

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
        const ring = Array.isArray(rec.pastKeyHashes) ? rec.pastKeyHashes : [];
        ring.unshift(rec.keyHash);
        rec.keyHash = hashTenantKey(apiKey);
        rec.pastKeyHashes = ring.slice(0, KEY_RING_CAP - 1);
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
      pastKeyHashes: [],
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

/**
 * Mint a fresh API key for an existing tenant (remote MCP per-account).
 *
 * WHY: raw `lm_...` keys live only in cookies/client configs — the store
 * keeps hashes. A tenant that lost its key (or wants a dedicated MCP token)
 * calls this with a STILL-VALID bearer; the current hash drops into the
 * 5-key ring so existing sessions keep working. Master has no record —
 * minting is a tenant-only op (master uses LAIN_API_KEY directly).
 * Returns the plaintext key ONCE. Throws when the tenant is unknown.
 */
export async function mintTenantKey(tenantSlug: string): Promise<{ tenant: string; apiKey: string }> {
  const t = normalizeTenant(tenantSlug);
  if (!t || t === MASTER_TENANT) throw new Error('master uses LAIN_API_KEY directly');
  const apiKey = `lm_${randomBytes(24).toString('hex')}`;
  const file = getTenantsPath();
  let minted = false;
  await withFileLock(file, () => {
    const records = loadTenantsSync();
    const rec = records[t];
    if (!rec) throw new Error(`unknown tenant '${t}'`);
    const ring = Array.isArray(rec.pastKeyHashes) ? rec.pastKeyHashes : [];
    ring.unshift(rec.keyHash);
    rec.keyHash = hashTenantKey(apiKey);
    rec.pastKeyHashes = ring.slice(0, KEY_RING_CAP - 1);
    saveTenantsSync(records);
    minted = true;
  });
  if (!minted) throw new Error(`unknown tenant '${t}'`);
  return { tenant: t, apiKey };
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

/**
 * Display-name validation shared by create/link/profile-update.
 * Same contract as the BFF profile: 2–40 chars, no C0/DEL controls, no
 * double quotes (prompt-quoting safety). Never throws — 400s, not 500s.
 */
export function sanitizeTenantDisplayName(rawName: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof rawName !== 'string') return { ok: false, error: 'name is required (min 2 characters)' };
  const name = rawName.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/"/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (name.length < 2) return { ok: false, error: 'name is required (min 2 characters)' };
  return { ok: true, name };
}

/** Canonical display name for a tenant (null when unknown — never throws). */
export async function getTenantDisplayName(tenantSlug: string): Promise<string | null> {
  const t = normalizeTenant(tenantSlug);
  if (!t || t === MASTER_TENANT) return null;
  const file = getTenantsPath();
  try {
    return await withFileLock(file, () => loadTenantsSync()[t]?.name ?? null);
  } catch {
    return null;
  }
}

/**
 * Rename a tenant's DISPLAY name only (profile edit).
 * The slug is the isolation identity (Qdrant user_id, graph scope, session
 * dir) and NEVER changes here — renaming the slug would orphan every scope.
 * Master has no record (400 upstream). Throws on unknown tenant/validation.
 */
export async function updateTenantName(tenantSlug: string, rawName: unknown): Promise<{ tenant: string; name: string }> {
  const t = normalizeTenant(tenantSlug);
  if (!t || t === MASTER_TENANT) throw new Error('master has no tenant record');
  const clean = sanitizeTenantDisplayName(rawName);
  if (!clean.ok) throw new Error(clean.error);
  const file = getTenantsPath();
  let renamed = false;
  await withFileLock(file, () => {
    const records = loadTenantsSync();
    const rec = records[t];
    if (!rec) throw new Error(`unknown tenant '${t}'`);
    rec.name = clean.name;
    saveTenantsSync(records);
    renamed = true;
  });
  if (!renamed) throw new Error(`unknown tenant '${t}'`);
  return { tenant: t, name: clean.name };
}

/** Reset the display name to the slug (wipe flow: name is PII, record stays). */
export async function resetTenantName(tenantSlug: string): Promise<void> {
  const t = normalizeTenant(tenantSlug);
  if (!t || t === MASTER_TENANT) return;
  const file = getTenantsPath();
  try {
    await withFileLock(file, () => {
      const records = loadTenantsSync();
      if (records[t]) {
        records[t].name = t;
        saveTenantsSync(records);
      }
    });
  } catch (err) {
    console.error('[tenants] resetTenantName failed:', err instanceof Error ? err.message : err);
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

/**
 * Full account removal: tombstones the tenant record (key ring cleared, sub
 * link dropped, name reset to the slug). The slug stays RESERVED forever —
 * no future signup/link may reclaim it, so orphaned Qdrant/graph data from
 * a partially-failed wipe can never leak into a new account with the same
 * name. Throws on master and unknown tenants. Returns the removed record
 * so the caller can finish external cleanup (e.g. Supabase Auth deletion).
 */
export async function deleteTenantRecord(tenantSlug: string): Promise<TenantRecord> {
  const t = normalizeTenant(tenantSlug);
  if (!t || t === MASTER_TENANT) throw new Error('master has no tenant record');
  const file = getTenantsPath();
  let removed: TenantRecord | null = null;
  await withFileLock(file, () => {
    const records = loadTenantsSync();
    const rec = records[t];
    if (!rec) throw new Error(`unknown tenant '${t}'`);
    if (rec.deletedAt) throw new Error(`unknown tenant '${t}'`);
    removed = { ...rec };
    records[t] = {
      tenant: t,
      name: t,
      keyHash: '',
      pastKeyHashes: [],
      createdAt: rec.createdAt,
      projects: [],
      deletedAt: new Date().toISOString(),
    };
    saveTenantsSync(records);
  });
  return removed!;
}

/** True when the slug is tombstoned (deleted, permanently reserved). */
export function isTenantTombstoned(slug: string): boolean {
  try {
    const records = loadTenantsSync();
    return Boolean(records[normalizeTenant(slug)]?.deletedAt);
  } catch {
    return false;
  }
}

// ─── Write-path budgets (moved here from routes/tenant.ts) ───

/**
 * Write-path budget: at most TENANT_MEMORY_CAP memories per tenant+project
 * scope (global scope included). Counted live via getAll — one extra Qdrant
 * round-trip per remember, acceptable for the MVP (remember already does a
 * search + LLM calls). Master tenant is uncapped (legacy behavior).
 * Dynamic import of mem0 avoids a static tenants↔mem0 cycle.
 */
type CountRow = { id: string };
type GetMemoriesFn = (project?: string, limit?: number, tenant?: string) => Promise<CountRow[]>;

let _getMemoriesOverride: GetMemoriesFn | null = null;

/** Test-only: stub the memory count source (pass null to restore). */
export function __setGetMemoriesForTests(fn: GetMemoriesFn | null): void {
  _getMemoriesOverride = fn;
}

/**
 * Memory listing shared by quota checks and LGPD wipe enumeration.
 * Prefers the test override when set (offline suites), otherwise the real
 * Mem0 backend. Keeps wipe fail-closed testing deterministic.
 */
export async function listMemoriesForWipe(
  project: string | undefined,
  limit: number,
  tenant: string,
): Promise<Array<{ id: string }>> {
  const fn: GetMemoriesFn = _getMemoriesOverride
    ?? (await import('./mem0.js')).getMemories;
  return fn(project, limit, tenant);
}

export async function enforceTenantCap(
  tenant: string,
  project?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (tenant === MASTER_TENANT) return { ok: true };
  try {
    const getMemories: GetMemoriesFn = _getMemoriesOverride
      ?? (await import('./mem0.js')).getMemories;
    const existing = await getMemories(project, TENANT_MEMORY_CAP + 1, tenant);
    if (existing.length >= TENANT_MEMORY_CAP) {
      return { ok: false, error: `memory cap reached (${TENANT_MEMORY_CAP} per scope) — wipe via DELETE /api/tenant/data to start over` };
    }
    return { ok: true };
  } catch {
    // Fail-open on count errors: a Qdrant hiccup must not brick writes.
    // The remember itself will surface backend errors honestly.
    return { ok: true };
  }
}

/** Max graph nodes owned by a single non-master tenant. */
export const TENANT_GRAPH_NODE_CAP = 500;

/**
 * Graph ingest budget: at most TENANT_GRAPH_NODE_CAP nodes per non-master
 * tenant. Master is uncapped (shared legacy graph).
 */
export async function enforceTenantGraphCap(
  tenant: string,
  incomingNodes = 0
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (tenant === MASTER_TENANT) return { ok: true };
  try {
    const { getGraph } = await import('./graphrag/store.js');
    const g = getGraph();
    if (!g) return { ok: true };
    const base = `tn-${normalizeTenant(tenant)}`;
    let owned = 0;
    g.forEachNode((key) => {
      const idx = key.indexOf('::');
      const scope = idx <= 0 ? null : key.slice(0, idx);
      if (scope === base || (scope && scope.startsWith(`${base}--`))) owned++;
    });
    if (owned + incomingNodes > TENANT_GRAPH_NODE_CAP) {
      return { ok: false, error: `graph node cap reached (${TENANT_GRAPH_NODE_CAP} nodes) — remove nodes before ingesting more` };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

// ─── Rate limits (in-memory fixed-window, single-instance) ───

/** Fixed-window limiter: stores {count, resetAt}, preserves resetAt until expiry. */
export class FixedWindowLimiter {
  private store = new Map<string, { count: number; resetAt: number }>();
  constructor(private maxEntries = 5000) {}

  /** True when the call fits the budget (and counts it). */
  check(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const entry = this.store.get(key);
    if (!entry || now >= entry.resetAt) {
      if (this.store.size >= this.maxEntries && !this.store.has(key)) {
        const oldest = this.store.keys().next();
        if (!oldest.done) this.store.delete(oldest.value);
      }
      this.store.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  }

  clear(): void {
    this.store.clear();
  }
}

const tenantMinuteBudget = new FixedWindowLimiter(5000);
const signupHourBudget = new FixedWindowLimiter(1000);
const expensiveOpBudget = new FixedWindowLimiter(5000);

/** Reset all in-memory rate-limit buckets (tests). */
export function __resetRateLimitersForTests(): void {
  tenantMinuteBudget.clear();
  signupHourBudget.clear();
  expensiveOpBudget.clear();
}

/** True when the call fits the 60 req/min tenant budget (and counts it). */
export function checkTenantRateLimit(tenant: string): boolean {
  const key = `ratelimit:${normalizeTenant(tenant) || 'unknown'}`;
  return tenantMinuteBudget.check(key, RATE_LIMIT_PER_MIN, 60_000);
}

/** True when a signup from this IP fits the 10/hour anti-abuse budget. */
export function checkSignupAllowed(ip: string): boolean {
  const key = `signup:${ip || 'unknown'}`;
  return signupHourBudget.check(key, SIGNUP_MAX_PER_HOUR, 3_600_000);
}

/** Stricter 5 req/min budget for expensive LLM endpoints (non-master). */
export function checkExpensiveOpAllowed(tenant: string, endpoint: string): boolean {
  const t = normalizeTenant(tenant) || MASTER_TENANT;
  if (t === MASTER_TENANT) return true;
  return expensiveOpBudget.check(`expensive:${t}:${endpoint}`, 5, 60_000);
}
