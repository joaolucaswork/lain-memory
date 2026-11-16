/**
 * Redis cache for graphrag (graphrag split G3).
 *
 * Key-scoped get/set/invalidate plus the stats wrapper. TTLs are exported
 * for the query/extract/reconcile modules; the key prefix stays private.
 */

import { createHash } from 'crypto';
import { getRedis, isRedisAvailable } from '../redis.js';
import { INSTANCE_ID } from '../workspace.js';
import { getStats, normalizeProject } from './store.js';

const CACHE_PREFIX = 'cache:graphrag:';
export const CACHE_TTL_QUERY = 300;       // 5 min for query results
export const CACHE_TTL_DECISIONS = 300;   // 5 min for decision queries
export const CACHE_TTL_STATS = 60;        // 1 min for stats (changes often)
export const CACHE_TTL_PGS = 300;         // 5 min for PGS export
export const CACHE_TTL_EXTRACTION = 3600; // 1 hour for entity extraction (LLM calls — gpt-4o-mini)

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!isRedisAvailable()) return null;
  try {
    const cached = await getRedis().get(`${CACHE_PREFIX}${key}`);
    if (cached !== null) return JSON.parse(cached);
  } catch {}
  return null;
}

export async function cacheSet(key: string, value: unknown, ttl: number): Promise<void> {
  if (!isRedisAvailable()) return;
  getRedis().set(`${CACHE_PREFIX}${key}`, JSON.stringify(value), 'EX', ttl).catch(() => {});
}

export async function invalidateGraphCache(): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    const redis = getRedis();
    const p = INSTANCE_ID ? `lain:${INSTANCE_ID}:` : 'lain:';
    const stream = redis.scanStream({ match: `${p}${CACHE_PREFIX}*`, count: 100 });
    const keysToDelete: string[] = [];
    for await (const keys of stream) {
      keysToDelete.push(...(keys as string[]));
    }
    if (keysToDelete.length > 0) {
      const pipeline = redis.pipeline();
      for (const k of keysToDelete) {
        pipeline.del(k.slice(p.length));
      }
      await pipeline.exec();
    }
    console.log(`[graphrag] Cache invalidated (${keysToDelete.length} keys)`);
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
