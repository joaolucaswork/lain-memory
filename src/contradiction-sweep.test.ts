import { describe, it, expect, mock } from 'bun:test';

import * as realMem0aiOssNs from 'mem0ai/oss';
const realMem0aiOss = { ...realMem0aiOssNs };

// Must mock mem0ai/oss (loads sqlite3 native binary) before importing mem0.ts
mock.module('mem0ai/oss', () => ({
  Memory: class MockMemory {},
  OpenAILLM: class MockOpenAILLM {},
  OpenAIEmbedder: class MockOpenAIEmbedder {},
}));

const mem0 = await import('./mem0.js');
const {
  nextSliceIndices,
  getContradictionFetchLimit,
  getContradictionSliceSize,
  getContradictionMaxLlm,
  getContradictionCursor,
  setContradictionCursor,
} = mem0 as any;

describe('nextSliceIndices', () => {
  it('returns empty for empty store', () => {
    expect(nextSliceIndices(0, 0, 20)).toEqual([]);
  });

  it('returns first slice from cursor 0', () => {
    expect(nextSliceIndices(100, 0, 20)).toEqual([...Array(20).keys()]);
  });

  it('wraps around the end', () => {
    expect(nextSliceIndices(100, 90, 20)).toEqual([
      90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it('caps at total when size > total', () => {
    expect(nextSliceIndices(5, 3, 20)).toEqual([3, 4, 0, 1, 2]);
  });
});

describe('pending merge gate (item 2)', () => {
  const { isPendingMergeEnabled } = mem0 as any;

  it('is off by default', () => {
    expect(isPendingMergeEnabled({})).toBe(false);
  });

  it('enables on true/1', () => {
    expect(isPendingMergeEnabled({ LAIN_PENDING_MERGE_ENABLED: 'true' })).toBe(true);
    expect(isPendingMergeEnabled({ LAIN_PENDING_MERGE_ENABLED: '1' })).toBe(true);
    expect(isPendingMergeEnabled({ LAIN_PENDING_MERGE_ENABLED: 'false' })).toBe(false);
  });
});

describe('contradiction sweep env', () => {
  it('defaults when unset', () => {
    expect(getContradictionFetchLimit({})).toBe(200);
    expect(getContradictionSliceSize({})).toBe(20);
    expect(getContradictionMaxLlm({})).toBe(10);
  });

  it('clamps invalid values', () => {
    expect(getContradictionFetchLimit({ LAIN_CONTRADICTION_FETCH: '0' })).toBe(200);
    expect(getContradictionSliceSize({ LAIN_CONTRADICTION_SLICE: '9999' })).toBe(100);
    expect(getContradictionMaxLlm({ LAIN_CONTRADICTION_MAX_LLM: '-3' })).toBe(10);
  });
});

describe('contradiction cursor fallback (no Redis in tests)', () => {
  it('round-trips in-memory cursor', async () => {
    await setContradictionCursor('test-scope-cursor', 42);
    expect(await getContradictionCursor('test-scope-cursor')).toBe(42);
  });
});
