/**
 * In-memory cache for graphrag (graphrag split G3).
 *
 * Key-scoped get/set/invalidate plus the stats wrapper. TTLs are exported
 * for the query/extract/reconcile modules; single-instance Map replaces Redis.
 */

import { createHash } from 'crypto';
import { TtlCache } from '../lib/ttl-cache.js';
import { getStats, normalizeProject } from './store.js';

export const CACHE_TTL_QUERY = 300;       // 5 min for query results
export const CACHE_TTL_DECISIONS = 300;   // 5 min for decision queries
export const CACHE_TTL_STATS = 60;        // 1 min for stats (changes often)
export const CACHE_TTL_PGS = 300;         // 5 min for PGS export
export const CACHE_TTL_EXTRACTION = 3600; // 1 hour for entity extraction (LLM calls — gpt-4o-mini)

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const graphCache = new TtlCache<unknown>({ maxEntries: 500 });

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    return (graphCache.get(key) as T | null) ?? null;
  } catch { return null; }
}

export async function cacheSet(key: string, value: unknown, ttl: number): Promise<void> {
  try {
    graphCache.set(key, value, ttl);
  } catch { /* non-critical */ }
}

export async function invalidateGraphCache(): Promise<void> {
  try {
    graphCache.clear();
    console.log('[graphrag] Cache invalidated');
  } catch (err) {
    console.error('[graphrag] Cache invalidation error:', err);
  }
}

export async function cachedGetStats(project?: string): Promise<{ nodes: number; edges: number; types: Record<string, number> }> {
  const scopeSuffix = project ? normalizeProject(project) : '';
  const cached = await cacheGet<{ nodes: number; edges: number; types: Record<string, number> }>(`stats:${scopeSuffix}`);
  if (cached) return cached;
  const result = getStats(project);
  await cacheSet(`stats:${scopeSuffix}`, result, CACHE_TTL_STATS);
  return result;
}
