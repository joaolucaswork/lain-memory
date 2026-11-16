/**
 * User-state writes: feedback, importance, touch (mem0 split M4).
 *
 * Authority: src/memory-state.ts (Qdrant payload, Redis L2). This module is
 * the mem0-side façade — thin wrappers plus the heuristic post-save and the
 * vote side effects. mem0.ts re-exports everything; importers are unchanged.
 *
 * Cache invalidation after votes is a lazy import of read.ts (M5) so the
 * dependency stays one-directional (read → state) and this module never
 * pulls in the Mem0 client chain.
 */

import { getRedis, isRedisAvailable } from '../redis.js';
import {
  FEEDBACK_DEFAULTS as STATE_FEEDBACK_DEFAULTS,
  IMPORTANCE_DEFAULT as STATE_IMPORTANCE_DEFAULT,
  getFeedback as stateGetFeedback,
  getImportance as stateGetImportance,
  getManyFeedback as stateGetManyFeedback,
  setFeedback as stateSetFeedback,
  setImportance as stateSetImportance,
  deleteState as stateDeleteState,
} from '../memory-state.js';
import { scoreImportance } from './scoring.js';
import type {
  AddMemoryOpts,
  FeedbackAction,
  FeedbackKind,
  MemoryFeedback,
} from './types.js';

// ─── Importance Scoring (Poignancy) ───

// Authority: src/memory-state.ts (Qdrant payload, Redis L2). Re-exported
// here so existing import sites keep working.
export const IMPORTANCE_DEFAULT = STATE_IMPORTANCE_DEFAULT;

/**
 * Chat atoms carry extractor-owned importance/kind (persisted by
 * rememberChatTurn) — the regex heuristics must not run for them.
 * Exported so tests pin the contract without live backends or global mocks
 * (a spy-based test would need a second mock.module, which collides in one
 * bun process — see mem0-audit-trail.test.ts).
 */
export function shouldApplyHeuristicState(opts?: AddMemoryOpts): boolean {
  return !opts?.chatAtom;
}

/**
 * Heuristic post-save for non-chat paths: regex importance + state tag.
 * Exported for tests (live Qdrant, no LLM needed).
 */
export async function persistHeuristicState(text: string, memoryId: string): Promise<void> {
  const score = scoreImportance(text);
  await setMemoryImportance(memoryId, score);
  console.log(`[mem0] Importance scored: ${score.toFixed(2)} for ${memoryId.slice(0, 8)}…`);
  // Tag transient states at save time (fact is the neutral default).
  if (heuristicKind(text) === 'state') {
    await setMemoryFeedback(memoryId, { kind: 'state' });
  }
}

/**
 * Persist importance score for a memory ID.
 * Authority is Qdrant (memory-state.ts) — throws on write failure (fail-hard).
 */
export async function setMemoryImportance(memoryId: string, score: number): Promise<void> {
  await stateSetImportance(memoryId, score);
}

/**
 * Stored importance score for a memory ID.
 * Returns null if not yet scored, IMPORTANCE_DEFAULT when the backend is
 * unreachable. Never throws.
 */
export async function getMemoryImportance(memoryId: string): Promise<number | null> {
  return stateGetImportance(memoryId);
}

/**
 * Bump importance slightly when a memory is accessed.
 * Implements usage-based reinforcement: frequently used memories become more important.
 * Cap at 1.0.
 */
export async function reinforceMemoryImportance(memoryId: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    const current = await getMemoryImportance(memoryId);
    if (current === null) return; // not yet scored — don't set 0.5+0.05 as if it were scored
    const bumped = Math.min(1.0, current + 0.05);
    await setMemoryImportance(memoryId, bumped);
  } catch { /* non-critical */ }
}

// ─── Relevance Boost (touch on retrieval) ───

const TOUCH_TTL = 30 * 24 * 60 * 60; // 30 days

/**
 * Record that a memory was accessed/used.
 * Stores last-access timestamp in Redis. When computing age decay,
 * this effectively "refreshes" the memory's recency.
 * Also reinforces importance score.
 */
export async function touchMemoryTimestamp(memoryId: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await getRedis().set(`mem0:touch:${memoryId}`, Date.now().toString(), 'EX', TOUCH_TTL);
    // Fire-and-forget: reinforce importance on access
    reinforceMemoryImportance(memoryId).catch(() => {});
  } catch { /* non-critical */ }
}

/**
 * Get the last access timestamp for a memory (if touched).
 * Returns null if never accessed or Redis unavailable.
 */
export async function getMemoryTouchTimestamp(memoryId: string): Promise<number | null> {
  if (!isRedisAvailable()) return null;
  try {
    const ts = await getRedis().get(`mem0:touch:${memoryId}`);
    return ts ? parseInt(ts, 10) : null;
  } catch { return null; }
}

// ─── Memory Feedback (user votes: ✓ confirm / 🕐 archive) ───
// Fase 0 of per-memory quick actions (replaces like/dislike).
// Authority: src/memory-state.ts (Qdrant payload, Redis L2). Absent state =
// neutral defaults, so existing ranking behavior is unchanged until the
// first vote. Re-exported here so existing import sites keep working.

export const FEEDBACK_DEFAULTS: MemoryFeedback = STATE_FEEDBACK_DEFAULTS;

/** Display-title cap: 6 words ≈ 80 chars with margin. */
export const FEEDBACK_TITLE_MAX_CHARS = 80;

/** Stored feedback for a memory, or neutral defaults when never voted. Never throws. */
export async function getMemoryFeedback(memoryId: string): Promise<MemoryFeedback> {
  return stateGetFeedback(memoryId);
}

/**
 * Batch feedback fetch. Preloaded mem0 `metadata` is free — no I/O.
 * Missing keys → neutral defaults. Never throws.
 */
export async function getManyMemoryFeedback(
  ids: string[],
  preloadedById?: Map<string, unknown> | Record<string, unknown>,
): Promise<Map<string, MemoryFeedback>> {
  return stateGetManyFeedback(ids, preloadedById);
}

/**
 * Attach feedback signals to list-style items. Additive — safe for all
 * getMemories consumers (vault, sweeps, snapshots, restore).
 */
export async function attachFeedback<T extends { id: string }>(items: T[]): Promise<(T & MemoryFeedback)[]> {
  if (items.length === 0) return [];
  const preloaded = new Map<string, unknown>();
  for (const m of items) {
    const meta = (m as { metadata?: unknown }).metadata;
    if (meta !== undefined) preloaded.set(m.id, meta);
  }
  const map = await stateGetManyFeedback(items.map((m) => m.id), preloaded);
  return items.map((m) => ({ ...m, ...(map.get(m.id) ?? FEEDBACK_DEFAULTS) }));
}

/**
 * Remove a memory's feedback/importance (forget / trash / policy cleanup).
 * The Qdrant payload dies with the point; this evicts leftovers (L2) and is
 * idempotent. Swallows Not Found; throws on other Qdrant errors.
 */
export async function deleteState(memoryId: string): Promise<void> {
  await stateDeleteState(memoryId);
}

/**
 * Merge patch into stored feedback (creates with defaults when absent).
 * Fail-hard: throws when Qdrant cannot persist (the route surfaces 500).
 */
export async function setMemoryFeedback(
  memoryId: string,
  patch: Partial<MemoryFeedback>,
): Promise<MemoryFeedback> {
  return stateSetFeedback(memoryId, patch);
}

/**
 * Best-effort recall-cache invalidation after a vote.
 * Lazy import keeps the dependency one-directional (read → state) and keeps
 * this module free of the Mem0 client chain. The vote itself already applied;
 * a stale cache only lasts until TTL.
 */
async function invalidateRecallCache(): Promise<void> {
  try {
    const read = (await import('./read.js' as string)) as {
      invalidateMem0Cache: (project?: string) => Promise<void>;
    };
    await read.invalidateMem0Cache().catch(() => {});
  } catch { /* read module not yet extracted (pre-M5) or Redis down — non-critical */ }
}

/**
 * Apply a user vote. Side effects per action:
 *   confirm   → confidence=1.0, last_confirmed_at=now, correct_count+1,
 *                touch (recency refresh) + importance floor 0.85 (180d half-life protection).
 *   archive   → status=archived (excluded from recall, kept in list/history).
 *   unarchive → status=active.
 * `forget` is NOT here — it deletes via trash+blocklist (issue #2).
 */
export async function applyMemoryFeedback(
  memoryId: string,
  action: FeedbackAction,
  opts?: { kind?: FeedbackKind },
): Promise<MemoryFeedback> {
  const now = new Date().toISOString();
  const kindPatch = opts?.kind ? { kind: opts.kind } : {};
  // Votes change ranking immediately — don't serve stale cached recalls.
  invalidateRecallCache().catch(() => {});
  if (action === 'confirm') {
    const current = await getMemoryFeedback(memoryId);
    const next = await setMemoryFeedback(memoryId, {
      confidence: 1.0,
      last_confirmed_at: now,
      correct_count: current.correct_count + 1,
      ...kindPatch,
    });
    // Recency refresh is best-effort cache. The importance floor below is a
    // user-decision write (Qdrant authority) — fail-hard, like the vote above.
    await touchMemoryTimestamp(memoryId).catch(() => {});
    const importance = await getMemoryImportance(memoryId);
    await setMemoryImportance(memoryId, Math.max(importance ?? 0, 0.85));
    return next;
  }
  if (action === 'archive') {
    return setMemoryFeedback(memoryId, { status: 'archived', ...kindPatch });
  }
  return setMemoryFeedback(memoryId, { status: 'active', last_confirmed_at: now, ...kindPatch });
}

// ─── Kind Heuristic (fact vs state) ───
// Fase 0: coarse text signals, no LLM. Errs toward `fact` (safe default —
// facts decay slowly). Only `state` is ever persisted here; `fact` is the
// neutral default and needs no key.

const STATE_HINTS = [
  /\b(hoje|agora|ainda|ontem|no momento|atualmente|essa semana|ultimamente|por enquanto)\b/i,
  /\b\d{1,2}[h:]\d{2}\b/, // time of day ("14h30", "às 8:00")
  /\b(estou|esta|está|to|tô|tá|continuo|sigo)\s+\w*(ando|endo|indo)\b/i, // progressive ("estou lendo")
  /\b(lendo|tomando|usando|sentindo|fazendo|trabalhando|estudando|jogando|assistindo|vendo|ouvindo|comendo|bebendo|dormindo|acordando|saindo|voltando|passando)\b/i,
  /\b(estou|está|esta|to|tô|ta|tá)\s+(com|me sentindo|sentindo)\b/i, // state report ("estou com dor")
];

/** Classify saved text as stable fact vs transient state. Pure, unit-tested. */
export function heuristicKind(text: string): FeedbackKind {
  return STATE_HINTS.some((re) => re.test(text)) ? 'state' : 'fact';
}
