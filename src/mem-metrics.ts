/**
 * In-memory metrics counters for the Lain memory system.
 *
 * Lightweight, zero-dependency counters incremented at key memory operations.
 * Exposed via GET /api/memory/metrics.
 */

export const metrics = {
  memoriesAdded: 0,
  memoriesRejected: 0,
  deduplicationsRun: 0,
  coldPurged: 0,
  coldDryPurged: 0,
  cacheHits: 0,
  cacheMisses: 0,
};

export function incrementMetric(key: keyof typeof metrics): void {
  metrics[key]++;
}

export function getMetrics(): typeof metrics {
  return { ...metrics };
}
