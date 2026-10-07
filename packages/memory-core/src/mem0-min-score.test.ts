import { describe, it, expect, mock, afterAll } from 'bun:test';

import * as realMem0aiOssNs from 'mem0ai/oss';
const realMem0aiOss = { ...realMem0aiOssNs };

// Must mock mem0ai/oss (it loads sqlite3 native binary) before importing mem0.ts
mock.module('mem0ai/oss', () => ({
  Memory: class MockMemory {},
  OpenAILLM: class MockOpenAILLM {},
  OpenAIEmbedder: class MockOpenAIEmbedder {},
}));

// Dynamic import AFTER mocks are set up
const mem0 = await import('./mem0.js');

describe('applyMinScoreFilter (item #2 — min-score threshold)', () => {
  const { applyMinScoreFilter } = mem0 as any;

  it('is exported from mem0.ts', () => {
    expect(typeof applyMinScoreFilter).toBe('function');
  });

  it('returns all results when minScore is 0 (disabled)', () => {
    const results = [
      { id: '1', memory: 'a', score: 0.2 },
      { id: '2', memory: 'b', score: 0.38 },
      { id: '3', memory: 'c', score: 0.9 },
    ];
    expect(applyMinScoreFilter(results, 0)).toHaveLength(3);
  });

  it('returns all results when minScore is negative', () => {
    const results = [{ id: '1', memory: 'a', score: 0.1 }];
    expect(applyMinScoreFilter(results, -1)).toHaveLength(1);
  });

  it('filters out results with score below threshold when threshold > 0', () => {
    const results = [
      { id: '1', memory: 'low', score: 0.2 },
      { id: '2', memory: 'exact', score: 0.38 },
      { id: '3', memory: 'high', score: 0.9 },
    ];
    const filtered = applyMinScoreFilter(results, 0.38);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((r: any) => r.id)).toEqual(['2', '3']);
  });

  it('keeps result with score exactly equal to threshold', () => {
    const results = [{ id: '1', memory: 'exact', score: 0.38 }];
    expect(applyMinScoreFilter(results, 0.38)).toHaveLength(1);
  });

  it('drops result with undefined score when threshold > 0', () => {
    const results = [{ id: '1', memory: 'no-score' }];
    expect(applyMinScoreFilter(results, 0.3)).toHaveLength(0);
  });

  it('returns empty array unchanged regardless of threshold', () => {
    expect(applyMinScoreFilter([], 0.5)).toHaveLength(0);
  });

  it('env LAIN_MIN_RECALL_SCORE=0 means no filtering (default is disabled)', () => {
    const results = [
      { id: '1', memory: 'very-low', score: 0.05 },
      { id: '2', memory: 'mid', score: 0.5 },
    ];
    expect(applyMinScoreFilter(results, 0)).toHaveLength(2);
  });
});

afterAll(() => {
  mock.module('mem0ai/oss', () => realMem0aiOss);
});
