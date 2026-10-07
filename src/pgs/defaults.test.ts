import { describe, expect, test } from 'bun:test';
import { PGS_DEFAULTS } from './defaults.js';

describe('PGS Defaults', () => {
  test('has all required config fields', () => {
    expect(PGS_DEFAULTS.maxConcurrentSweeps).toBe(5);
    expect(PGS_DEFAULTS.minCommunitySize).toBe(3);
    expect(PGS_DEFAULTS.targetPartitionMax).toBe(500);
    expect(PGS_DEFAULTS.maxSweepPartitions).toBe(15);
    expect(PGS_DEFAULTS.partitionRelevanceThreshold).toBe(0.25);
    expect(PGS_DEFAULTS.sweepMaxTokens).toBe(6000);
    expect(PGS_DEFAULTS.synthesisMaxTokens).toBe(16000);
  });

  test('minCommunitySize adapted for small graphs', () => {
    expect(PGS_DEFAULTS.minCommunitySize).toBeLessThan(30);
  });
});
