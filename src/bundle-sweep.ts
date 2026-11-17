/**
 * Bundle sweep — weekly non-destructive digest for the `diario` project.
 *
 * Scope is intentionally fixed to `diario` (per user decision).
 * NEVER deletes, archives, or updates fragments — read + 1 append only.
 * Fragments stay intact; the bundle is saved with `skipConflictCheck`
 * (index mode: summary of already-saved atoms) and provenance metadata
 * `{ kind: 'bundle', bundle_of: [ids], non_destructive: true }`.
 *
 * Env vars (read at call time):
 *   LAIN_BUNDLE_ENABLED   'false'|'0'|'no' disables entirely (default: enabled)
 *   LAIN_BUNDLE_DRY_RUN   'true'|'1' logs without saving (default: false)
 *   LAIN_BUNDLE_FETCH_LIMIT  max diario memories to scan (default: 100)
 */

import { randomUUID } from 'crypto';
import { MASTER_TENANT } from './tenants.js';
import {
  addMemory,
  getMemories,
  scoreMemoryQuality,
  MIN_MEMORY_QUALITY,
} from './mem0.js';
import { incrementMetric } from './mem-metrics.js';
import { logMaintenance } from './maintenance-log.js';

export const BUNDLE_PROJECT = 'diario';
export const BUNDLE_PREFIX = '[Bundle: diario';
const BUNDLE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const BUNDLE_WINDOW_DAYS = 7;
const DISABLED_VALUES = new Set(['false', '0', 'no']);

const FETCH_LIMIT_DEFAULT = 100;
export function getBundleFetchLimit(): number {
  const raw = process.env.LAIN_BUNDLE_FETCH_LIMIT;
  if (!raw) return FETCH_LIMIT_DEFAULT;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return FETCH_LIMIT_DEFAULT;
  return n;
}

export function isBundleEnabled(): boolean {
  return !DISABLED_VALUES.has((process.env.LAIN_BUNDLE_ENABLED ?? '').toLowerCase());
}

export function isBundleDryRun(): boolean {
  const v = (process.env.LAIN_BUNDLE_DRY_RUN ?? '').toLowerCase();
  return v === 'true' || v === '1';
}

export interface BundleCandidate {
  id: string;
  memory: string;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

/** Bundles are identifiable by prefix or provenance metadata — never re-bundled. */
export function isBundleMemory(m: { memory: string; metadata?: Record<string, unknown> }): boolean {
  if (m.memory.startsWith(BUNDLE_PREFIX)) return true;
  return (m.metadata as Record<string, unknown> | undefined)?.kind === 'bundle';
}

function ageDays(m: BundleCandidate, now: number): number | null {
  const ref = m.updated_at ?? m.created_at;
  if (!ref) return null;
  const ms = new Date(ref).getTime();
  if (isNaN(ms)) return null;
  return (now - ms) / (1000 * 60 * 60 * 24);
}

/**
 * Weekly window: unbundled diario memories from the last `windowDays`.
 * Undated memories are included (neutral — no penalty for missing timestamps).
 */
export function selectWeeklyCandidates(
  memories: BundleCandidate[],
  opts?: { now?: number; windowDays?: number },
): BundleCandidate[] {
  const now = opts?.now ?? Date.now();
  const windowDays = opts?.windowDays ?? BUNDLE_WINDOW_DAYS;
  return memories.filter(m => {
    if (isBundleMemory(m)) return false;
    const age = ageDays(m, now);
    if (age === null || isNaN(age)) return true;
    return age >= 0 && age <= windowDays;
  });
}

export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
  if (wordsA.size === 0 || wordsB.size === 0) return 0.0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / (wordsA.size + wordsB.size - intersection);
}

/** Skip when an identical bundle already exists (exact/near-duplicate guard). */
export function bundleAlreadyExists(merged: string, existingBundles: BundleCandidate[]): boolean {
  for (const b of existingBundles) {
    if (jaccardSimilarity(merged, b.memory) > 0.85) return true;
  }
  return false;
}

async function llmMergeBundle(texts: string[]): Promise<string | null> {
  const { runFastLlmJson } = await import('./llm-client.js');
  const { withRetry } = await import('./mem0.js');
  const fragments = texts.join('\n- ');
  const result = await withRetry(() =>
    runFastLlmJson<{ consolidated: string }>(
      `Consolide essas memórias do diário em UMA ÚNICA linha do tempo semanal, completa e rica.
Mantenha TODOS os fatos importantes, nomes, datas e o arco emocional.
NÃO invente fatos novos. Retorne APENAS JSON: {"consolidated": "texto aqui"}

Memórias:
- ${fragments}`,
      { maxTokens: 1024 },
    ),
  );
  if (result?.consolidated && result.consolidated.length > 20) return result.consolidated;
  return null;
}

export interface BundleSweepResult {
  bundles: number;
  skipped: number;
  dryRun: boolean;
  disabled?: boolean;
  details: { newId?: string; fragments: number; bundleOf: string[]; preview: string }[];
}

export async function runBundleSweep(opts?: {
  dryRun?: boolean;
  now?: number;
  windowDays?: number;
  tenant?: string;
}): Promise<BundleSweepResult> {
  const dryRun = opts?.dryRun ?? isBundleDryRun();
  if (!isBundleEnabled()) {
    console.log('[bundle] disabled (LAIN_BUNDLE_ENABLED) — skipping');
    return { bundles: 0, skipped: 0, dryRun, disabled: true, details: [] };
  }

  const runId = randomUUID().slice(0, 8);
  const now = opts?.now ?? Date.now();
  console.log(`[bundle] Starting weekly diario digest...${dryRun ? ' (DRY RUN)' : ''}`);

  let memories: BundleCandidate[];
  try {
    memories = await getMemories(BUNDLE_PROJECT, getBundleFetchLimit(), opts?.tenant ?? MASTER_TENANT);
  } catch (err) {
    console.error('[bundle] Failed to fetch diario memories:', err);
    return { bundles: 0, skipped: 0, dryRun, details: [] };
  }

  const existingBundles = memories.filter(isBundleMemory);
  const candidates = selectWeeklyCandidates(memories, { now, windowDays: opts?.windowDays });

  if (candidates.length < 2) {
    console.log(`[bundle] Nothing to bundle: ${candidates.length} candidate(s) in window`);
    return { bundles: 0, skipped: candidates.length, dryRun, details: [] };
  }

  const texts = candidates.map(c => c.memory);
  let merged: string | null;
  try {
    merged = await llmMergeBundle(texts);
  } catch (err) {
    console.error('[bundle] LLM merge failed:', err instanceof Error ? err.message : err);
    return { bundles: 0, skipped: candidates.length, dryRun, details: [] };
  }
  if (!merged) {
    console.log('[bundle] LLM returned nothing usable — skipping');
    return { bundles: 0, skipped: candidates.length, dryRun, details: [] };
  }

  const bundleText = `${BUNDLE_PREFIX} ${new Date(now).toISOString().slice(0, 10)}] ${merged}`;

  if (scoreMemoryQuality(bundleText) < MIN_MEMORY_QUALITY) {
    console.log('[bundle] Merged bundle rejected by quality gate — skipping');
    return { bundles: 0, skipped: candidates.length, dryRun, details: [] };
  }
  if (bundleAlreadyExists(bundleText, existingBundles)) {
    console.log('[bundle] Identical bundle already exists — skipping');
    return { bundles: 0, skipped: candidates.length, dryRun, details: [] };
  }

  const bundleOf = candidates.map(c => c.id);
  if (dryRun) {
    console.log(`[bundle] [DRY] would save bundle from ${candidates.length} fragments`);
    incrementMetric('bundlesCreated');
    return {
      bundles: 0,
      skipped: 0,
      dryRun: true,
      details: [{ fragments: candidates.length, bundleOf, preview: bundleText.slice(0, 200) }],
    };
  }

  // Index mode: skip conflict check (summary of already-saved atoms), keep quality gate above.
  // NON-DESTRUCTIVE: no delete/trash/update of fragments — append only.
  const saved = await addMemory(bundleText, BUNDLE_PROJECT, {
    skipConflictCheck: true,
    skipQualityCheck: true,
    metadata: { kind: 'bundle', bundle_of: bundleOf, non_destructive: true, run_id: runId },
  }, opts?.tenant ?? MASTER_TENANT);
  const newId = saved[0]?.id ?? 'unknown';
  incrementMetric('bundlesCreated');
  try {
    logMaintenance('bundle_created', {
      run_id: runId,
      scope: BUNDLE_PROJECT,
      new_id: newId,
      fragments: bundleOf.length,
      bundle_of: bundleOf,
      non_destructive: true,
    });
  } catch { /* non-critical */ }

  console.log(`[bundle] Saved bundle ${newId.slice(0, 8)} from ${bundleOf.length} fragments (fragments preserved)`);
  return {
    bundles: 1,
    skipped: 0,
    dryRun: false,
    details: [{ newId, fragments: bundleOf.length, bundleOf, preview: bundleText.slice(0, 200) }],
  };
}

let bundleTimer: ReturnType<typeof setInterval> | undefined;
let bundleInitTimer: ReturnType<typeof setTimeout> | undefined;

export function startBundleSweep(): void {
  if (!isBundleEnabled()) {
    console.log('[bundle] disabled (LAIN_BUNDLE_ENABLED) — no intervals registered');
    return;
  }
  if (isBundleDryRun()) {
    console.log('[bundle] dry-run mode active — bundles will be simulated, not saved');
  }
  // First pass after 15 minutes, then weekly
  bundleInitTimer = setTimeout(
    () => runBundleSweep().catch(err => console.error('[bundle] error:', err)),
    15 * 60 * 1000,
  );
  bundleTimer = setInterval(
    () => runBundleSweep().catch(err => console.error('[bundle] error:', err)),
    BUNDLE_INTERVAL_MS,
  );
}

export function stopBundleSweep(): void {
  if (bundleInitTimer) {
    clearTimeout(bundleInitTimer);
    bundleInitTimer = undefined;
  }
  if (bundleTimer) {
    clearInterval(bundleTimer);
    bundleTimer = undefined;
  }
}
