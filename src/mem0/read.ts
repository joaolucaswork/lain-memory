/**
 * Recall pipeline (mem0 split M5).
 *
 * Read path: search, shared recall pipeline (touch-boost + signals +
 * archived filter + rank), in-memory cached search, cache invalidation,
 * and list. Depends on config (client), scoring (rank), and state
 * (signals, touch) — never the reverse.
 */

import { TtlCache } from '../lib/ttl-cache.js';
import { getManyState } from '../memory-state.js';
import { incrementMetric } from '../mem-metrics.js';
import { getClient, userId } from './config.js';
import { applyAgeDecayToResults } from './scoring.js';
import {
  attachFeedback,
  FEEDBACK_DEFAULTS,
  getMemoryTouchTimestamp,
  touchMemoryTimestamp,
} from './state.js';
import type {
  FeedbackKind,
  FeedbackStatus,
  MemoryFeedback,
  RankedMemory,
} from './types.js';

/**
 * Calibrated default for LAIN_MIN_RECALL_SCORE.
 *
 * Derived from 5 benchmark dumps (2026-05-21). Score-distribution analysis:
 *   - Junk top-1 scores (na-01..na-05): 0.215, 0.337, 0.355, 0.447*, 0.571*
 *     (* = 429-contaminated runs only — Qdrant returned noise instead of nothing)
 *   - Genuine hit min scores (ka-* / ra-*): 0.358 (ka-03, lowest), ..., 0.735
 *
 * Gap: na-05 tops at 0.355, ka-03 hits at 0.358 — a 0.003-wide separation.
 * 0.356 sits in this gap: filters na-01/na-02/na-05 reliably, keeps all genuine hits.
 *
 * TRADEOFF (documented explicitly): na-03 (0.447) and na-04 (0.571) are not
 * suppressed — doing so would require threshold > 0.447 which drops ka-03 (0.358),
 * ka-10 (0.402), and ra-03 (0.404). Those contaminated scores appear only in 2/5
 * runs; clean runs return no results for those queries.
 *
 * PROVISIONAL — calibrated from 429-contaminated dumps; re-validate after clean
 * re-ingestion. Set LAIN_MIN_RECALL_SCORE=0 to disable.
 */
export const DEFAULT_MIN_RECALL_SCORE = 0.356;

/**
 * Filter search results by a minimum score threshold.
 * When minScore <= 0 the filter is disabled and all results are returned.
 * At-threshold results are kept (>= semantics).
 */
export function applyMinScoreFilter<T extends { score?: number }>(results: T[], minScore: number): T[] {
  if (minScore <= 0) return results;
  return results.filter(r => (r.score ?? 0) >= minScore);
}

export function resolveMinRecallScore(env: NodeJS.ProcessEnv = process.env): number {
  return parseFloat(env.LAIN_MIN_RECALL_SCORE ?? String(DEFAULT_MIN_RECALL_SCORE)) || 0;
}

export async function searchMemory(query: string, project?: string, limit: number = 10): Promise<RankedMemory[]> {
  const m = getClient();
  const result = await m.search(query, {
    // v3 requires snake_case entity keys in filters (camelCase throws).
    filters: { user_id: userId(project) },
    topK: limit,
  });
  // Preserve timestamps from Mem0 response for age-decay scoring
  // Preserve payload metadata (carries lain_feedback/lain_importance — free state).
  const mapped = (result.results ?? []).map((item: any) => ({
    id: item.id,
    memory: item.memory,
    score: item.score,
    created_at: item.created_at ?? item.createdAt,
    updated_at: item.updated_at ?? item.updatedAt,
    ...(item.metadata ? { metadata: item.metadata } : {}),
  }));
  const filtered = applyMinScoreFilter(mapped, resolveMinRecallScore());
  return rankRecallResults(filtered, query);
}

/**
 * Shared recall pipeline (Fase 0 feedback): touch-boost recency, attach
 * importance + feedback, drop archived, rank by adjusted score.
 * Used by both cached and direct search so every recall path agrees.
 */
export async function rankRecallResults<
  T extends { id: string; memory: string; score?: number; created_at?: string; updated_at?: string },
>(results: T[], query: string): Promise<RankedMemory[]> {
  // Boost recently-accessed memories by using touch timestamp as virtual updated_at
  let boostedResults: T[] = results;
  try {
    boostedResults = await Promise.all(
      results.map(async (r) => {
        const touchTs = getMemoryTouchTimestamp(r.id);
        if (touchTs) {
          const touchDate = new Date(touchTs).toISOString();
          // Use touch timestamp if more recent than actual updated_at
          const currentUpdated = r.updated_at ? new Date(r.updated_at).getTime() : 0;
          if (touchTs > currentUpdated) {
            return { ...r, updated_at: touchDate };
          }
        }
        return r;
      })
    );
  } catch {
    // Boost failed — use original results
  }

  // Fetch importance + feedback from memory-state (Qdrant payload authority,
  // excludes them. State rides free on mem0 metadata when present, so this
  // is usually zero extra round-trips. Never throws — degrades to defaults.
  type Enriched<U> = U & { importance: number | null; confidence: number; last_confirmed_at: string | null; status: FeedbackStatus; kind: FeedbackKind; title: string | null };
  let withSignals: Array<Enriched<T>> =
    boostedResults.map((r) => ({ ...r, importance: null, confidence: FEEDBACK_DEFAULTS.confidence, last_confirmed_at: null, status: 'active' as FeedbackStatus, kind: 'fact' as FeedbackKind, title: null }));
  try {
    const preloaded = new Map<string, unknown>();
    for (const r of boostedResults) {
      const meta = (r as { metadata?: unknown }).metadata;
      if (meta !== undefined) preloaded.set(r.id, meta);
    }
    const states = await getManyState(boostedResults.map((r) => r.id), preloaded);
    const maybe: Array<Enriched<T> | null> = boostedResults.map((r) => {
      const st = states.get(r.id);
      const feedback = st?.feedback ?? FEEDBACK_DEFAULTS;
      if (feedback.status === 'archived') return null;
      return {
        ...r,
        importance: st?.importance ?? null,
        confidence: feedback.confidence,
        last_confirmed_at: feedback.last_confirmed_at,
        status: feedback.status,
        kind: feedback.kind,
        title: feedback.title ?? null,
      };
    });
    withSignals = maybe.filter((r): r is Enriched<T> => r !== null);
  } catch {
    // Signal fetch failed — rank on raw scores with neutral defaults
  }

  const queryTerms = query.split(/\s+/).filter(t => t.length >= 3);
  return applyAgeDecayToResults(withSignals, queryTerms);
}

// ─── In-memory Mem0 Cache ───

const MEM0_CACHE_TTL = 300; // 5 minutes
const recallCache = new TtlCache<RankedMemory[]>({ maxEntries: 500 });

function mem0CacheKey(query: string, project?: string): string {
  const normalized = `${query}:${project || ''}`.toLowerCase().trim();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return `cache:mem0:${hash}`;
}

/**
 * Search memory with in-memory cache. Cache hit: ~0.5ms vs API call: ~200-500ms.
 */
export async function cachedSearchMemory(query: string, project?: string, limit: number = 10): Promise<RankedMemory[]> {
  const key = mem0CacheKey(query, project);

  // Try cache first
  try {
    const cached = recallCache.get(key);
    if (cached) {
      incrementMetric('cacheHits');
      return cached;
    }
  } catch {
    // Cache read failed — fall through to API
  }
  incrementMetric('cacheMisses');

  // Cache miss — full pipeline (touch-boost, signals, archived filter, rank)
  const withDecay = await searchMemory(query, project, limit);

  // Touch top-3 results to boost their relevance (fire-and-forget)
  // touchMemoryTimestamp also reinforces importance score
  for (const r of withDecay.slice(0, 3)) {
    if (r.id) touchMemoryTimestamp(r.id).catch(() => {});
  }

  // Cache the result
  try {
    recallCache.set(key, withDecay, MEM0_CACHE_TTL);
  } catch {
    // Non-critical
  }

  return withDecay;
}

/**
 * Invalidate Mem0 cache for a project when memories change (add/delete/consolidate).
 * Single-instance: clears the whole recall cache.
 */
export async function invalidateMem0Cache(project?: string): Promise<void> {
  void project;
  try {
    recallCache.clear();
  } catch {
    // Non-critical — cache will expire naturally
  }
}

export async function getMemories(project?: string, limit: number = 20): Promise<Array<{ id: string; memory: string; created_at?: string; updated_at?: string; metadata?: Record<string, unknown> } & MemoryFeedback>> {
  const m = getClient();
  const result = await m.getAll({
    // v3 requires snake_case entity keys in filters (camelCase throws).
    filters: { user_id: userId(project) },
    topK: limit,
  });
  // Preserve created_at/updated_at from Mem0 response
  const mapped = (result.results ?? []).map((item: any) => ({
    id: item.id,
    memory: item.memory,
    created_at: item.created_at ?? item.createdAt,
    updated_at: item.updated_at ?? item.updatedAt,
    ...(item.metadata ? { metadata: item.metadata } : {}),
  }));
  // Fase 0: feedback signals ride along for vault badges (single pipeline round-trip)
  return attachFeedback(mapped);
}
