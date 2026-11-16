/**
 * Memory State — user decisions live here (Qdrant payload), Redis is L2 only.
 *
 * Issue #8: feedback (confidence, last_confirmed_at, status, kind, sensitive,
 * correct_count, title) + importance used to live ONLY in Redis (TTL 1y).
 * Flushing Redis wiped archives, titles, confirmations and forgets.
 *
 * Now the authority is the Qdrant point payload:
 *   - `lain_feedback`    → MemoryFeedback object
 *   - `lain_importance`  → number
 * (two top-level keys instead of one nested `lain_state` because Qdrant
 * setPayload merges SHALLOWLY — a nested object would be replaced wholesale
 * and concurrent feedback/importance writes would clobber each other.)
 *
 * Reads also accept the legacy nested `lain_state: { feedback, importance }`
 * shape, so a future migration or manual payload stays readable.
 *
 * Redis keeps the same `mem0:feedback:<id>` / `mem0:importance:<id>` keys as
 * a best-effort L2 cache (same TTLs as before). It is NEVER the only copy:
 * every read falls through to Qdrant, every write goes to Qdrant first and
 * throws on failure (fail-hard — /api/memory/feedback surfaces 500).
 *
 * Reads never throw (defaults on any failure). Writes throw on Qdrant
 * failure, including voting on a point that does not exist (Not Found).
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { getRedis, isRedisAvailable } from './redis.js';
import { INSTANCE_ID } from './workspace.js';

// ─── Types (moved from mem0.ts — re-exported there for compat) ───

export type FeedbackStatus = 'active' | 'archived';
export type FeedbackKind = 'fact' | 'state';

export interface MemoryFeedback {
  confidence: number;
  last_confirmed_at: string | null;
  status: FeedbackStatus;
  kind: FeedbackKind;
  sensitive: boolean;
  correct_count: number;
  /** Short display title (ideal 3 words, max 6). Metadata only — never affects ranking. */
  title: string | null;
}

export const FEEDBACK_DEFAULTS: MemoryFeedback = {
  confidence: 0.5,
  last_confirmed_at: null,
  status: 'active',
  kind: 'fact',
  sensitive: false,
  correct_count: 0,
  title: null,
};

/** Display-title cap: 6 words ≈ 80 chars with margin. */
export const FEEDBACK_TITLE_MAX_CHARS = 80;

/** Neutral importance when not yet scored. */
export const IMPORTANCE_DEFAULT = 0.5;

/** Top-level Qdrant payload keys (namespaced — never collide with mem0 internals). */
export const LAIN_FEEDBACK_KEY = 'lain_feedback';
export const LAIN_IMPORTANCE_KEY = 'lain_importance';
/** Extractor relevance 1-5 (Tarefa B/C). Marks a memory as rated — the backfill skips ids that have it. */
export const LAIN_RELEVANCE_KEY = 'lain_relevance';

/** Trash-copy metadata key carrying the state snapshot for restore. */
export const STATE_SNAPSHOT_KEY = 'lain_state_snapshot';

/** Full user-state snapshot (stashed in trash metadata, reapplied on restore). */
export interface StateSnapshot {
  feedback: MemoryFeedback;
  importance: number | null;
}

/** True when the state is neutral defaults (nothing worth snapshotting). */
export function isDefaultState(feedback: MemoryFeedback, importance: number | null): boolean {
  return importance === null
    && feedback.confidence === FEEDBACK_DEFAULTS.confidence
    && feedback.last_confirmed_at === null
    && feedback.status === 'active'
    && feedback.kind === 'fact'
    && feedback.sensitive === false
    && feedback.correct_count === 0
    && feedback.title === null;
}

/** Validate + sanitize a snapshot read from trash metadata. Null when absent/invalid/default. */
export function parseStateSnapshot(raw: unknown): StateSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!s['feedback'] || typeof s['feedback'] !== 'object') return null;
  const feedback = sanitizeFeedback(s['feedback'] as Partial<MemoryFeedback>);
  const importance = typeof s['importance'] === 'number' && !isNaN(s['importance'] as number)
    ? (s['importance'] as number)
    : null;
  if (isDefaultState(feedback, importance)) return null;
  return { feedback, importance };
}

// L2 cache keys/TTLs (same names as the old Redis-only store, so the
// migration script and any lingering keys keep working as cache).
const FEEDBACK_L2_TTL = 365 * 24 * 60 * 60; // 1 year
const IMPORTANCE_L2_TTL = 365 * 24 * 60 * 60; // 1 year

function feedbackKey(memoryId: string): string {
  return `mem0:feedback:${memoryId}`;
}

function importanceKey(memoryId: string): string {
  return `mem0:importance:${memoryId}`;
}

export function sanitizeFeedback(parsed: Partial<MemoryFeedback>): MemoryFeedback {
  return {
    confidence: typeof parsed.confidence === 'number'
      ? Math.min(1, Math.max(0, parsed.confidence))
      : FEEDBACK_DEFAULTS.confidence,
    last_confirmed_at: typeof parsed.last_confirmed_at === 'string' ? parsed.last_confirmed_at : null,
    status: parsed.status === 'archived' ? 'archived' : 'active',
    kind: parsed.kind === 'state' ? 'state' : 'fact',
    sensitive: parsed.sensitive === true,
    correct_count: Number.isInteger(parsed.correct_count) && (parsed.correct_count as number) >= 0
      ? (parsed.correct_count as number)
      : 0,
    title: typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim().slice(0, FEEDBACK_TITLE_MAX_CHARS)
      : null,
  };
}

// ─── Qdrant client (lazy singleton) ───

let _qdrant: QdrantClient | null = null;

export function collectionName(): string {
  return INSTANCE_ID ? `mem0-${INSTANCE_ID}` : 'mem0';
}

function getQdrant(): QdrantClient {
  if (!_qdrant) {
    _qdrant = new QdrantClient({
      host: process.env.QDRANT_HOST || 'localhost',
      port: parseInt(process.env.QDRANT_PORT || '6333', 10),
      ...(process.env.LAIN_QDRANT_API_KEY ? { apiKey: process.env.LAIN_QDRANT_API_KEY } : {}),
      checkCompatibility: false,
    });
  }
  return _qdrant;
}

function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not found/i.test(msg) || /\b404\b/.test(msg);
}

/** Qdrant point ids are UUIDs (mem0 generates v4) or uints — anything else fails the whole batch. */
export function isQueryableId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || /^\d+$/.test(id);
}

// ─── Metadata extraction (free state — rides along with get/getAll/search) ───

export interface ExtractedState {
  feedback: MemoryFeedback | null;
  importance: number | null;
  /** Extractor relevance 1-5. Null when never rated. */
  relevance: number | null;
}

/** Valid stored relevance: integer 1-5. Anything else reads as unrated. */
export function sanitizeRelevance(raw: unknown): number | null {
  return Number.isInteger(raw) && (raw as number) >= 1 && (raw as number) <= 5 ? (raw as number) : null;
}

/** Pull state out of a mem0 `metadata` object without any I/O. Nulls when absent/invalid. */
export function extractStateFromMetadata(metadata: unknown): ExtractedState {
  const out: ExtractedState = { feedback: null, importance: null, relevance: null };
  if (!metadata || typeof metadata !== 'object') return out;
  const m = metadata as Record<string, unknown>;
  // New flat keys.
  if (m[LAIN_FEEDBACK_KEY] && typeof m[LAIN_FEEDBACK_KEY] === 'object') {
    try {
      out.feedback = sanitizeFeedback(m[LAIN_FEEDBACK_KEY] as Partial<MemoryFeedback>);
    } catch { /* keep null */ }
  }
  if (typeof m[LAIN_IMPORTANCE_KEY] === 'number' && !isNaN(m[LAIN_IMPORTANCE_KEY] as number)) {
    out.importance = m[LAIN_IMPORTANCE_KEY] as number;
  }
  out.relevance = sanitizeRelevance(m[LAIN_RELEVANCE_KEY]);
  // Legacy nested shape: lain_state: { feedback, importance }.
  const nested = m['lain_state'];
  if ((!out.feedback || out.importance === null) && nested && typeof nested === 'object') {
    const n = nested as Record<string, unknown>;
    if (!out.feedback && n['feedback'] && typeof n['feedback'] === 'object') {
      try {
        out.feedback = sanitizeFeedback(n['feedback'] as Partial<MemoryFeedback>);
      } catch { /* keep null */ }
    }
    if (out.importance === null && typeof n['importance'] === 'number' && !isNaN(n['importance'] as number)) {
      out.importance = n['importance'] as number;
    }
    if (out.relevance === null) {
      out.relevance = sanitizeRelevance(n['relevance']);
    }
  }
  return out;
}

// ─── L2 (Redis) helpers — best-effort, never throw ───

async function l2GetFeedback(id: string): Promise<MemoryFeedback | null> {
  if (!isRedisAvailable()) return null;
  try {
    const raw = await getRedis().get(feedbackKey(id));
    if (!raw) return null;
    return sanitizeFeedback(JSON.parse(raw) as Partial<MemoryFeedback>);
  } catch { return null; }
}

async function l2SetFeedback(id: string, fb: MemoryFeedback): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await getRedis().set(feedbackKey(id), JSON.stringify(fb), 'EX', FEEDBACK_L2_TTL);
  } catch { /* best-effort */ }
}

async function l2GetImportance(id: string): Promise<number | null> {
  if (!isRedisAvailable()) return null;
  try {
    const val = await getRedis().get(importanceKey(id));
    if (val === null) return null;
    const score = parseFloat(val);
    return isNaN(score) ? null : score;
  } catch { return null; }
}

async function l2SetImportance(id: string, score: number): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await getRedis().set(importanceKey(id), score.toString(), 'EX', IMPORTANCE_L2_TTL);
  } catch { /* best-effort */ }
}

// ─── Qdrant reads — never throw; unanswered ids degrade to L2/defaults ───

interface QdrantState {
  feedback: MemoryFeedback | null;
  importance: number | null;
  relevance: number | null;
  /** True when Qdrant answered (point found or confirmed missing). False on transport error. */
  answered: boolean;
  /** True when the point was actually returned by retrieve. */
  found: boolean;
}

async function qdrantRetrieve(ids: string[]): Promise<Map<string, QdrantState>> {
  const out = new Map<string, QdrantState>();
  const queryable = [...new Set(ids.filter(Boolean))].filter(isQueryableId);
  if (queryable.length === 0) return out;
  const applyPoint = (p: { id: unknown; payload?: unknown }) => {
    const st = extractStateFromMetadata(p.payload ?? null);
    out.set(String(p.id), { feedback: st.feedback, importance: st.importance, relevance: st.relevance, answered: true, found: true });
  };
  try {
    const points = await getQdrant().retrieve(collectionName(), { ids: queryable, with_payload: true });
    for (const p of points) applyPoint(p as { id: unknown; payload?: unknown });
    // Ids not returned do not exist → answered with nulls.
    for (const id of queryable) {
      if (!out.has(id)) out.set(id, { feedback: null, importance: null, relevance: null, answered: true, found: false });
    }
  } catch {
    // Batch failed — retry per-id so one poison id cannot blank the batch.
    await Promise.all(queryable.map(async (id) => {
      try {
        const one = await getQdrant().retrieve(collectionName(), { ids: [id], with_payload: true });
        if (one.length > 0) applyPoint(one[0] as { id: unknown; payload?: unknown });
        else out.set(id, { feedback: null, importance: null, relevance: null, answered: true, found: false });
      } catch {
        // Per-id failure — stays absent (unanswered), caller degrades.
      }
    }));
  }
  return out;
}

export interface QdrantStateRead {
  feedback: MemoryFeedback | null;
  importance: number | null;
  /** Extractor relevance 1-5. Null when never rated. */
  relevance: number | null;
  /** True when the point was found. False when missing OR id not queryable. */
  exists: boolean;
  /** False when Qdrant could not be reached for this id (transport error). */
  answered: boolean;
}

/**
 * Qdrant-only state read (no L2, no metadata). For migrations and audits
 * that must distinguish "Qdrant has no state" from "a cache has state".
 * Never throws; unreachable ids degrade as answered:false.
 */
export async function readQdrantState(ids: string[]): Promise<Map<string, QdrantStateRead>> {
  const out = new Map<string, QdrantStateRead>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (const id of uniq) out.set(id, { feedback: null, importance: null, relevance: null, exists: false, answered: false });
  if (uniq.length === 0) return out;
  const qmap = await qdrantRetrieve(uniq);
  for (const id of uniq) {
    const q = qmap.get(id);
    if (!q || !q.answered) continue; // transport error — answered stays false
    out.set(id, { feedback: q.feedback, importance: q.importance, relevance: q.relevance, exists: q.found, answered: true });
  }
  return out;
}

export interface MemoryState {
  feedback: MemoryFeedback;
  /** Null when never scored AND Qdrant confirmed the point state. */
  importance: number | null;
}

/**
 * Batch state fetch. Preloaded mem0 `metadata` (from get/getAll/search) is
 * free — no I/O. Then L2, then one Qdrant retrieve for the rest. Never throws.
 */
export async function getManyState(
  ids: string[],
  preloadedById?: Map<string, unknown> | Record<string, unknown>,
): Promise<Map<string, MemoryState>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, MemoryState>();
  for (const id of uniq) out.set(id, { feedback: { ...FEEDBACK_DEFAULTS }, importance: null });
  if (uniq.length === 0) return out;

  const pre = (id: string): unknown =>
    preloadedById instanceof Map ? preloadedById.get(id) : (preloadedById as Record<string, unknown> | undefined)?.[id];

  const hasFb = new Set<string>();
  const hasIm = new Set<string>();

  // 1. Free metadata (rides along with mem0 results).
  for (const id of uniq) {
    const st = extractStateFromMetadata(pre(id));
    if (st.feedback) { out.get(id)!.feedback = st.feedback; hasFb.add(id); }
    if (st.importance !== null) { out.get(id)!.importance = st.importance; hasIm.add(id); }
  }

  // 2. Qdrant for the rest (authority first — a stale L2 must never shadow
  // it, e.g. after a write with Redis down followed by a reconnect).
  const needQ = uniq.filter((id) => !hasFb.has(id) || !hasIm.has(id));
  // answeredByQdrant tracks ids Qdrant confirmed (point found or missing),
  // so step 4 can tell "unscored" apart from "backend unreachable".
  const answeredByQdrant = new Set<string>();
  if (needQ.length > 0) {
    const qmap = await qdrantRetrieve(needQ);
    const l2Writes: Array<Promise<void>> = [];
    for (const id of needQ) {
      const q = qmap.get(id);
      if (!q || !q.answered) continue; // Qdrant unreachable — L2 next
      answeredByQdrant.add(id);
      if (q.feedback && !hasFb.has(id)) {
        out.get(id)!.feedback = q.feedback;
        hasFb.add(id);
        l2Writes.push(l2SetFeedback(id, q.feedback));
      }
      if (q.importance !== null && !hasIm.has(id)) {
        out.get(id)!.importance = q.importance;
        hasIm.add(id);
        l2Writes.push(l2SetImportance(id, q.importance));
      }
    }
    if (l2Writes.length > 0) await Promise.allSettled(l2Writes);
  }

  // 3. L2 only for ids Qdrant could not answer (fallback, never authority).
  const needL2 = uniq.filter((id) => !hasFb.has(id) || !hasIm.has(id));
  if (needL2.length > 0 && isRedisAvailable()) {
    try {
      const pipe = getRedis().pipeline();
      for (const id of needL2) {
        pipe.get(feedbackKey(id));
        pipe.get(importanceKey(id));
      }
      const rows = await pipe.exec();
      needL2.forEach((id, i) => {
        try {
          const rawFb = rows?.[i * 2]?.[1] as string | null;
          const rawIm = rows?.[i * 2 + 1]?.[1] as string | null;
          if (rawFb && !hasFb.has(id)) {
            out.get(id)!.feedback = sanitizeFeedback(JSON.parse(rawFb) as Partial<MemoryFeedback>);
            hasFb.add(id);
          }
          if (rawIm !== null && !hasIm.has(id)) {
            const score = parseFloat(rawIm);
            if (!isNaN(score)) { out.get(id)!.importance = score; hasIm.add(id); }
          }
        } catch { /* keep current */ }
      });
    } catch { /* degrade to defaults below */ }
  }

  // 4. Final defaults: unscored-but-confirmed stays null; unreachable
  // backends degrade importance to the neutral default (old semantics).
  for (const id of uniq) {
    if (!hasIm.has(id) && !answeredByQdrant.has(id)) {
      out.get(id)!.importance = IMPORTANCE_DEFAULT;
    }
  }
  return out;
}

/** Stored feedback for a memory, or neutral defaults when never voted. Never throws. */
export async function getFeedback(memoryId: string, preloadedMetadata?: unknown): Promise<MemoryFeedback> {
  const m = await getManyState(
    [memoryId],
    preloadedMetadata !== undefined ? new Map([[memoryId, preloadedMetadata]]) : undefined,
  );
  return m.get(memoryId)!.feedback;
}

/** Batch feedback fetch. Missing keys → neutral defaults. Never throws. */
export async function getManyFeedback(
  ids: string[],
  preloadedById?: Map<string, unknown> | Record<string, unknown>,
): Promise<Map<string, MemoryFeedback>> {
  const states = await getManyState(ids, preloadedById);
  const out = new Map<string, MemoryFeedback>();
  for (const [id, st] of states) out.set(id, st.feedback);
  return out;
}

/**
 * Stored importance score. Null when never scored (Qdrant confirmed),
 * IMPORTANCE_DEFAULT when the backend is unreachable. Never throws.
 */
export async function getImportance(memoryId: string, preloadedMetadata?: unknown): Promise<number | null> {
  const m = await getManyState(
    [memoryId],
    preloadedMetadata !== undefined ? new Map([[memoryId, preloadedMetadata]]) : undefined,
  );
  return m.get(memoryId)!.importance;
}

// ─── Per-id write mutex (serializes read-modify-write within this process) ───

const writeTails = new Map<string, Promise<void>>();

function withIdLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeTails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const cur = new Promise<void>((resolve) => { release = resolve; });
  const mine = prev.then(() => cur);
  writeTails.set(id, mine);
  const run = prev.then(() => fn());
  // Release the next waiter when we settle; drop the map entry when nobody
  // chained behind us (a waiter replaces the entry first, so the check holds).
  const done = () => {
    release();
    void mine.then(() => { if (writeTails.get(id) === mine) writeTails.delete(id); });
  };
  void run.then(done, done);
  return run;
}

// ─── Public writes — fail-hard (throw on Qdrant failure) ───

/** Authoritative feedback read for merge: Qdrant first, then L2, then defaults. Never throws. */
async function readFeedbackAuthoritative(id: string): Promise<MemoryFeedback> {
  if (isQueryableId(id)) {
    try {
      const pts = await getQdrant().retrieve(collectionName(), { ids: [id], with_payload: true });
      if (pts.length > 0) {
        const st = extractStateFromMetadata((pts[0] as { payload?: unknown }).payload ?? null);
        if (st.feedback) return st.feedback;
      }
    } catch {
      // Transport error — fall through to L2.
    }
  }
  return (await l2GetFeedback(id)) ?? { ...FEEDBACK_DEFAULTS };
}

/**
 * Merge patch into stored feedback (creates with defaults when absent).
 * Writes Qdrant first (throws on failure, incl. missing point), then L2
 * best-effort. Never returns silently-unstored data.
 */
export async function setFeedback(memoryId: string, patch: Partial<MemoryFeedback>): Promise<MemoryFeedback> {
  return withIdLock(memoryId, async () => {
    const current = await readFeedbackAuthoritative(memoryId);
    const next = sanitizeFeedback({ ...current, ...patch });
    try {
      await getQdrant().setPayload(collectionName(), {
        payload: { [LAIN_FEEDBACK_KEY]: next },
        points: [memoryId],
      });
    } catch (err) {
      throw new Error(`memory-state: Qdrant setPayload(feedback) failed for ${memoryId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await l2SetFeedback(memoryId, next);
    return next;
  });
}

/**
 * Persist importance score. Throws on Qdrant failure (fail-hard).
 */
export async function setImportance(memoryId: string, score: number): Promise<void> {
  try {
    await getQdrant().setPayload(collectionName(), {
      payload: { [LAIN_IMPORTANCE_KEY]: score },
      points: [memoryId],
    });
  } catch (err) {
    throw new Error(`memory-state: Qdrant setPayload(importance) failed for ${memoryId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await l2SetImportance(memoryId, score);
}

/**
 * Persist extractor relevance 1-5 (the "already rated" marker the backfill
 * uses to skip). Qdrant-only on purpose: the single reader is the backfill
 * skip-check via readQdrantState, no L2 involved. Throws on invalid input
 * or Qdrant failure (fail-hard).
 */
export async function setRelevance(memoryId: string, relevance: number): Promise<void> {
  if (sanitizeRelevance(relevance) === null) {
    throw new Error(`memory-state: invalid relevance ${JSON.stringify(relevance)} (want integer 1-5) for ${memoryId}`);
  }
  try {
    await getQdrant().setPayload(collectionName(), {
      payload: { [LAIN_RELEVANCE_KEY]: relevance },
      points: [memoryId],
    });
  } catch (err) {
    throw new Error(`memory-state: Qdrant setPayload(relevance) failed for ${memoryId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Clear a memory's importance score (rollback path — restores the unscored
 * null state). Feedback is untouched. Swallows Not Found; throws on other
 * Qdrant errors. L2 eviction is best-effort.
 */
export async function clearImportance(memoryId: string): Promise<void> {
  if (isQueryableId(memoryId)) {
    try {
      await getQdrant().deletePayload(collectionName(), {
        points: [memoryId],
        keys: [LAIN_IMPORTANCE_KEY],
      });
    } catch (err) {
      if (!isNotFound(err)) {
        throw new Error(`memory-state: Qdrant deletePayload(importance) failed for ${memoryId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (isRedisAvailable()) {
    try {
      await getRedis().del(importanceKey(memoryId));
    } catch { /* best-effort */ }
  }
}

/**
 * Remove a memory's state (forget / trash / policy path — issue #10 caller).
 * Swallows Not Found (idempotent delete); throws on other Qdrant errors.
 * L2 eviction is best-effort.
 */
export async function deleteState(memoryId: string): Promise<void> {
  if (isQueryableId(memoryId)) {
    try {
      await getQdrant().deletePayload(collectionName(), {
        points: [memoryId],
        keys: [LAIN_FEEDBACK_KEY, LAIN_IMPORTANCE_KEY],
      });
    } catch (err) {
      if (!isNotFound(err)) {
        throw new Error(`memory-state: Qdrant deletePayload failed for ${memoryId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (isRedisAvailable()) {
    try {
      await getRedis().del(feedbackKey(memoryId), importanceKey(memoryId));
    } catch { /* best-effort */ }
  }
}
