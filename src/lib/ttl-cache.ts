/**
 * In-memory TTL cache (single-instance replacement for Redis caches).
 *
 * WHY: Redis was pure cache/L2 after #8–#11 (Qdrant is authority).
 * For a single-instance basic product the process-local Map keeps ~80%
 * of the latency win with zero infra. Loses content on restart —
 * acceptable by design. Multi-instance would need Upstash; keep call
 * sites isolated so the swap is local.
 */

export interface TtlCacheOptions {
  maxEntries?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 1000;

export class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private maxEntries: number;

  constructor(opts?: TtlCacheOptions) {
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlSec: number): void {
    this.evictExpired();
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      this.evictOldest();
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  private evictExpired(): void {
    if (this.store.size < this.maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) this.store.delete(key);
      if (this.store.size < this.maxEntries) break;
    }
  }

  private evictOldest(): void {
    const oldest = this.store.keys().next();
    if (!oldest.done) this.store.delete(oldest.value);
  }
}
