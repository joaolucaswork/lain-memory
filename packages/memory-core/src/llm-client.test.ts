import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  getLlmBaseUrl, getLlmApiKey, getFastModel, getStandardModel,
  getDefaultProviderRouting, runFastLlm, runFastLlmJson,
} from './llm-client.js';

const KEYS = [
  'LAIN_LLM_BASE_URL',
  'LAIN_LLM_API_KEY',
  'LAIN_FAST_MODEL',
  'LAIN_STANDARD_MODEL',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'AI_GATEWAY_BASE_URL',
  'LAIN_OPENAI_API_KEY',
  'OPENAI_API_KEY',
] as const;

describe('llm-client env resolution', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  });

  afterEach(() => {
    KEYS.forEach(k => {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    });
  });

  it('A — default base URL is OpenRouter when nothing is set', () => {
    expect(getLlmBaseUrl()).toBe('https://openrouter.ai/api/v1');
  });

  it('B — LAIN_LLM_BASE_URL wins over AI_GATEWAY_BASE_URL', () => {
    process.env.AI_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';
    process.env.LAIN_LLM_BASE_URL = 'http://localhost:11434/v1';
    expect(getLlmBaseUrl()).toBe('http://localhost:11434/v1');
  });

  it('C — AI_GATEWAY_BASE_URL is used when LAIN_LLM_BASE_URL is absent', () => {
    process.env.AI_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';
    expect(getLlmBaseUrl()).toBe('https://ai-gateway.vercel.sh/v1');
  });

  it('D — LAIN_LLM_API_KEY wins over legacy keys', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.LAIN_LLM_API_KEY = 'new-key';
    expect(getLlmApiKey()).toBe('new-key');
  });

  it('E — legacy key order preserved (OPENROUTER > GATEWAY > LAIN_OPENAI > OPENAI)', () => {
    process.env.OPENAI_API_KEY = 'oai-key';
    process.env.LAIN_OPENAI_API_KEY = 'lain-key';
    process.env.AI_GATEWAY_API_KEY = 'gw-key';
    process.env.OPENROUTER_API_KEY = 'or-key';
    expect(getLlmApiKey()).toBe('or-key');
    delete process.env.OPENROUTER_API_KEY;
    expect(getLlmApiKey()).toBe('gw-key');
    delete process.env.AI_GATEWAY_API_KEY;
    expect(getLlmApiKey()).toBe('lain-key');
    delete process.env.LAIN_OPENAI_API_KEY;
    expect(getLlmApiKey()).toBe('oai-key');
  });

  it('F — throws when no key is set at all', () => {
    expect(() => getLlmApiKey()).toThrow();
  });

  it('G — model defaults and overrides', () => {
    expect(getFastModel()).toBe('deepseek/deepseek-v4-flash');
    expect(getStandardModel()).toBe('deepseek/deepseek-v4-flash');
    process.env.LAIN_FAST_MODEL = 'xai/grok-4';
    process.env.LAIN_STANDARD_MODEL = 'openai/gpt-5';
    expect(getFastModel()).toBe('xai/grok-4');
    expect(getStandardModel()).toBe('openai/gpt-5');
  });
});

describe('llm-client provider routing', () => {
  const saved: Record<string, string | undefined> = {};
  const ROUTING_KEYS = [...KEYS, 'LAIN_LLM_PROVIDER_ROUTING'] as const;
  let bodies: any[];
  let origFetch: typeof fetch;

  const fakeFetch = (content: string) => mock(async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  }) as unknown as typeof fetch;

  beforeEach(() => {
    ROUTING_KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
    bodies = [];
    origFetch = globalThis.fetch;
    process.env.LAIN_LLM_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    ROUTING_KEYS.forEach(k => {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    });
  });

  it('H — default soft routing sent on OpenRouter base', async () => {
    process.env.LAIN_LLM_BASE_URL = 'https://openrouter.ai/api/v1';
    expect(getDefaultProviderRouting()).toEqual({ preferred_max_latency: { p90: 5 } });
    globalThis.fetch = fakeFetch('ok');
    await runFastLlm('hi');
    expect(bodies[0].provider).toEqual({ preferred_max_latency: { p90: 5 } });
    expect(bodies[0].max_tokens).toBe(4096);
  });

  it('I — provider omitted on non-OpenRouter bases', async () => {
    for (const base of ['https://ai-gateway.vercel.sh/v1', 'http://localhost:11434/v1']) {
      process.env.LAIN_LLM_BASE_URL = base;
      expect(getDefaultProviderRouting()).toBeUndefined();
      globalThis.fetch = fakeFetch('ok');
      await runFastLlm('hi');
      expect(bodies[bodies.length - 1]).not.toHaveProperty('provider');
    }
  });

  it('J — kill-switch off/0/false/no omits provider on OpenRouter', async () => {
    process.env.LAIN_LLM_BASE_URL = 'https://openrouter.ai/api/v1';
    for (const off of ['off', '0', 'false', 'no', 'OFF']) {
      process.env.LAIN_LLM_PROVIDER_ROUTING = off;
      expect(getDefaultProviderRouting()).toBeUndefined();
      globalThis.fetch = fakeFetch('ok');
      await runFastLlm('hi');
      expect(bodies[bodies.length - 1]).not.toHaveProperty('provider');
    }
  });

  it('K — maxTokens opt passed through + JSON parsed', async () => {
    process.env.LAIN_LLM_BASE_URL = 'https://openrouter.ai/api/v1';
    globalThis.fetch = fakeFetch('{"action":"ADD","supersedes":[],"reason":"t"}');
    const r = await runFastLlmJson<{ action: string }>('hi', { maxTokens: 512 });
    expect(r).toEqual({ action: 'ADD', supersedes: [], reason: 't' });
    expect(bodies[0].max_tokens).toBe(512);
    expect(bodies[0].provider).toEqual({ preferred_max_latency: { p90: 5 } });
  });

  it('L — explicit provider override wins; null forces omission', async () => {
    process.env.LAIN_LLM_BASE_URL = 'https://openrouter.ai/api/v1';
    globalThis.fetch = fakeFetch('ok');
    await runFastLlm('hi', { provider: { order: ['x'] } });
    expect(bodies[0].provider).toEqual({ order: ['x'] });
    await runFastLlm('hi', { provider: null });
    expect(bodies[1]).not.toHaveProperty('provider');
  });
});
