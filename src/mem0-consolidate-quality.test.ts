import { describe, it, expect, mock, afterAll } from 'bun:test';

import * as realMem0aiOssNs from 'mem0ai/oss';
const realMem0aiOss = { ...realMem0aiOssNs };

// Must mock mem0ai/oss (loads sqlite3 native binary) before importing mem0.ts
mock.module('mem0ai/oss', () => ({
  Memory: class MockMemory {},
  OpenAILLM: class MockOpenAILLM {},
  OpenAIEmbedder: class MockOpenAIEmbedder {},
}));

const mem0 = await import('./mem0.js');

describe('consolidateMemories quality gate (item #6)', () => {
  const { scoreMemoryQuality, MIN_MEMORY_QUALITY } = mem0 as any;

  it('MIN_MEMORY_QUALITY is exported and is a positive number', () => {
    expect(typeof MIN_MEMORY_QUALITY).toBe('number');
    expect(MIN_MEMORY_QUALITY).toBeGreaterThan(0);
  });

  it('rejects a bare task-completion status string (below gate threshold)', () => {
    const lowQuality = 'task completed successfully';
    expect(scoreMemoryQuality(lowQuality)).toBeLessThan(MIN_MEMORY_QUALITY);
  });

  it('rejects "Server was restarted" noise (below gate threshold)', () => {
    expect(scoreMemoryQuality('Server was restarted via PM2')).toBeLessThan(MIN_MEMORY_QUALITY);
  });

  it('rejects bare deploy completion noise', () => {
    expect(scoreMemoryQuality('Build completed with 0 errors')).toBeLessThan(MIN_MEMORY_QUALITY);
  });

  it('accepts high-quality string with named entities and project context (at or above gate threshold)', () => {
    const highQuality =
      'Lucas configured lain to use Telegram as the primary messaging channel because WhatsApp is deprecated; ' +
      'the Telegram integration handles all inbound and outbound messages for the lain assistant.';
    expect(scoreMemoryQuality(highQuality)).toBeGreaterThanOrEqual(MIN_MEMORY_QUALITY);
  });

  it('accepts high-quality string with technical detail and specific context', () => {
    const highQuality =
      'The lain-core memory system uses Qdrant vector store with text-embedding-3-small for semantic search; ' +
      'Mem0 decomposes composite memories via gpt-4o-mini before storing individual atoms.';
    expect(scoreMemoryQuality(highQuality)).toBeGreaterThanOrEqual(MIN_MEMORY_QUALITY);
  });
});

afterAll(() => {
  mock.module('mem0ai/oss', () => realMem0aiOss);
});
