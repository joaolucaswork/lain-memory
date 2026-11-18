import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';

import * as realMem0aiOssNs from 'mem0ai/oss';
const realMem0aiOss = { ...realMem0aiOssNs };

// Must mock mem0ai/oss before importing mem0.ts (native sqlite binary).
const searchCalls: Array<{ query: unknown; topK: unknown }> = [];
const FIXTURE_NOW = new Date().toISOString();
const cannedResults = Array.from({ length: 12 }, (_, i) => ({
  id: `mem-${String(i + 1).padStart(2, '0')}`,
  memory: `recall cache fixture ${i + 1} commonterm`,
  score: 0.99 - i * 0.01,
  created_at: FIXTURE_NOW,
  updated_at: FIXTURE_NOW,
}));

mock.module('mem0ai/oss', () => ({
  Memory: class MockMemory {
    constructor(..._args: unknown[]) {}
    async search(query: unknown, opts: any) {
      searchCalls.push({ query, topK: opts?.topK });
      const topK = opts?.topK ?? 10;
      return { results: cannedResults.slice(0, topK) };
    }
    async getAll() {
      return { results: [] };
    }
    async add(messages: unknown, _config: unknown) {
      return { results: [{ id: 'new-id', memory: (messages as any)?.[0]?.content ?? '' }] };
    }
    async delete(_id: string) {
      return { message: 'deleted' };
    }
  },
  OpenAILLM: class MockOpenAILLM {},
  OpenAIEmbedder: class MockOpenAIEmbedder {},
}));

// Dynamic import AFTER mocks are set up
const mem0 = await import('./mem0.js');
const { __resetClientForTests } = await import('./mem0/config.js');

const QUERY = 'commonterm fixture';
const PROJECT = 'proj-cache';
const TENANT = 'lucas';

describe('cachedSearchMemory respects limit (recall cache)', () => {
  const savedKey = process.env.LAIN_OPENAI_API_KEY;
  const savedMinScore = process.env.LAIN_MIN_RECALL_SCORE;

  beforeEach(async () => {
    process.env.LAIN_OPENAI_API_KEY = 'sk-test-recall';
    process.env.LAIN_MIN_RECALL_SCORE = '0';
    searchCalls.length = 0;
    (__resetClientForTests as () => void)();
    await (mem0 as any).invalidateMem0Cache();
  });

  afterEach(async () => {
    await (mem0 as any).invalidateMem0Cache();
    (__resetClientForTests as () => void)();
    if (savedKey !== undefined) process.env.LAIN_OPENAI_API_KEY = savedKey;
    else delete process.env.LAIN_OPENAI_API_KEY;
    if (savedMinScore !== undefined) process.env.LAIN_MIN_RECALL_SCORE = savedMinScore;
    else delete process.env.LAIN_MIN_RECALL_SCORE;
  });

  it('limit 3 then 10 returns 3 then 10 ids in order', async () => {
    const first = await (mem0 as any).cachedSearchMemory(QUERY, PROJECT, 3, TENANT);
    const second = await (mem0 as any).cachedSearchMemory(QUERY, PROJECT, 10, TENANT);
    expect(first.map((r: any) => r.id)).toEqual(['mem-01', 'mem-02', 'mem-03']);
    expect(second.map((r: any) => r.id)).toEqual([
      'mem-01', 'mem-02', 'mem-03', 'mem-04', 'mem-05',
      'mem-06', 'mem-07', 'mem-08', 'mem-09', 'mem-10',
    ]);
  });

  it('limit 10 then 3 returns 10 then 3 ids in order', async () => {
    const first = await (mem0 as any).cachedSearchMemory(QUERY, PROJECT, 10, TENANT);
    const second = await (mem0 as any).cachedSearchMemory(QUERY, PROJECT, 3, TENANT);
    expect(first.map((r: any) => r.id)).toEqual([
      'mem-01', 'mem-02', 'mem-03', 'mem-04', 'mem-05',
      'mem-06', 'mem-07', 'mem-08', 'mem-09', 'mem-10',
    ]);
    expect(second.map((r: any) => r.id)).toEqual(['mem-01', 'mem-02', 'mem-03']);
  });

  it('omitted limit defaults to 10 and reuses the cache', async () => {
    const first = await (mem0 as any).cachedSearchMemory(QUERY, PROJECT, undefined, TENANT);
    const second = await (mem0 as any).cachedSearchMemory(QUERY, PROJECT, 10, TENANT);
    expect(first.map((r: any) => r.id)).toEqual(second.map((r: any) => r.id));
    expect(first).toHaveLength(10);
    expect(searchCalls).toHaveLength(1);
  });

  it('repeating the same params hits the cache', async () => {
    const first = await (mem0 as any).cachedSearchMemory(QUERY, PROJECT, 3, TENANT);
    const second = await (mem0 as any).cachedSearchMemory(QUERY, PROJECT, 3, TENANT);
    expect(second.map((r: any) => r.id)).toEqual(first.map((r: any) => r.id));
    expect(searchCalls).toHaveLength(1);
  });

  it('matches uncached search for each limit', async () => {
    await (mem0 as any).invalidateMem0Cache();
    const uncached3 = await (mem0 as any).searchMemory(QUERY, PROJECT, 3, TENANT);
    await (mem0 as any).invalidateMem0Cache();
    const cached3 = await (mem0 as any).cachedSearchMemory(QUERY, PROJECT, 3, TENANT);
    expect(cached3.map((r: any) => r.id)).toEqual(uncached3.map((r: any) => r.id));

    await (mem0 as any).invalidateMem0Cache();
    searchCalls.length = 0;
    const uncached10 = await (mem0 as any).searchMemory(QUERY, PROJECT, 10, TENANT);
    await (mem0 as any).invalidateMem0Cache();
    const cached10 = await (mem0 as any).cachedSearchMemory(QUERY, PROJECT, 10, TENANT);
    expect(cached10.map((r: any) => r.id)).toEqual(uncached10.map((r: any) => r.id));
  });
});

afterAll(() => {
  mock.module('mem0ai/oss', () => realMem0aiOss);
});
