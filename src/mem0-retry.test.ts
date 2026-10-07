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
const withRetry = (mem0 as any).withRetry as typeof import('./mem0.js').withRetry;

const NO_DELAY = () => Promise.resolve();

describe('withRetry (item #3 — exponential backoff on 429/5xx)', () => {
  it('is exported from mem0.ts', () => {
    expect(typeof withRetry).toBe('function');
  });

  it('returns value immediately when fn succeeds on first attempt', async () => {
    let calls = 0;
    const result = await withRetry(
      () => { calls++; return Promise.resolve(42); },
      { delayFn: NO_DELAY }
    );
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries on HTTP 429 and resolves after third attempt', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        if (calls < 3) throw new Error('HTTP 429: Too Many Requests');
        return Promise.resolve('success');
      },
      { delayFn: NO_DELAY }
    );
    expect(result).toBe('success');
    expect(calls).toBe(3);
  });

  it('exhausts maxAttempts on persistent 429 and rethrows', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => { calls++; throw new Error('HTTP 429: rate limited'); },
        { maxAttempts: 3, delayFn: NO_DELAY }
      )
    ).rejects.toThrow('429');
    expect(calls).toBe(3);
  });

  it('throws immediately on non-retryable error (only 1 attempt)', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => { calls++; throw new Error('Invalid API key — not retryable'); },
        { delayFn: NO_DELAY }
      )
    ).rejects.toThrow('Invalid API key');
    expect(calls).toBe(1);
  });

  it('retries on 5xx (503) and exhausts attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => { calls++; throw new Error('Vercel AI Gateway 503: Service Unavailable'); },
        { maxAttempts: 3, delayFn: NO_DELAY }
      )
    ).rejects.toThrow('503');
    expect(calls).toBe(3);
  });

  it('retries on 500 (5xx)', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => { calls++; throw new Error('HTTP 500: Internal Server Error'); },
        { maxAttempts: 3, delayFn: NO_DELAY }
      )
    ).rejects.toThrow('500');
    expect(calls).toBe(3);
  });

  it('custom maxAttempts=1 never retries', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => { calls++; throw new Error('429 rate limit'); },
        { maxAttempts: 1, delayFn: NO_DELAY }
      )
    ).rejects.toThrow('429');
    expect(calls).toBe(1);
  });
});

afterAll(() => {
  mock.module('mem0ai/oss', () => realMem0aiOss);
});
