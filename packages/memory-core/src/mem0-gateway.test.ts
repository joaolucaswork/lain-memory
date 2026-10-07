import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as mem0Module from './mem0.js';
import { OpenAIEmbedder } from 'mem0ai/oss';

const buildMem0Config = (mem0Module as any).buildMem0Config as (() => {
  embedder: { provider: string; config: Record<string, unknown> };
  llm: { provider: string; config: Record<string, unknown> };
}) | undefined;

const GATEWAY_KEY = 'gw-test-key';
const OPENAI_KEY  = 'sk-test-openai-key';

describe('buildMem0Config — AI Gateway routing', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL', 'LAIN_OPENAI_API_KEY', 'LAIN_LLM_API_KEY', 'LAIN_LLM_BASE_URL', 'LAIN_LLM_MODEL', 'LAIN_EMBED_MODEL'] as const;

  beforeEach(() => {
    KEYS.forEach(k => { saved[k] = process.env[k]; });
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_BASE_URL;
    delete process.env.LAIN_LLM_API_KEY;
    delete process.env.LAIN_LLM_BASE_URL;
    delete process.env.LAIN_LLM_MODEL;
    delete process.env.LAIN_EMBED_MODEL;
    process.env.LAIN_OPENAI_API_KEY = OPENAI_KEY;
  });

  afterEach(() => {
    KEYS.forEach(k => {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    });
  });

  it('A — gateway: baseURL and prefixed model names when AI_GATEWAY_API_KEY is set', () => {
    if (!buildMem0Config) throw new TypeError('buildMem0Config is not exported from mem0.ts');
    process.env.AI_GATEWAY_API_KEY = GATEWAY_KEY;
    const cfg = buildMem0Config();
    expect(cfg.embedder.config.baseURL).toBe('https://ai-gateway.vercel.sh/v1');
    expect(cfg.embedder.config.model).toBe('openai/text-embedding-3-small');
    expect(cfg.embedder.config.apiKey).toBe(GATEWAY_KEY);
    expect(cfg.llm.config.baseURL).toBe('https://ai-gateway.vercel.sh/v1');
    expect(cfg.llm.config.model).toBe('openai/gpt-4o-mini');
    expect(cfg.llm.config.apiKey).toBe(GATEWAY_KEY);
  });

  it('B — direct OpenAI: no baseURL and bare model names when AI_GATEWAY_API_KEY is absent', () => {
    if (!buildMem0Config) throw new TypeError('buildMem0Config is not exported from mem0.ts');
    const cfg = buildMem0Config();
    expect(cfg.embedder.config.baseURL).toBeUndefined();
    expect(cfg.embedder.config.model).toBe('text-embedding-3-small');
    expect(cfg.embedder.config.apiKey).toBe(OPENAI_KEY);
    expect(cfg.llm.config.baseURL).toBeUndefined();
    expect(cfg.llm.config.model).toBe('gpt-4o-mini');
    expect(cfg.llm.config.apiKey).toBe(OPENAI_KEY);
  });

  it('C — custom AI_GATEWAY_BASE_URL overrides default gateway URL', () => {
    if (!buildMem0Config) throw new TypeError('buildMem0Config is not exported from mem0.ts');
    process.env.AI_GATEWAY_API_KEY = GATEWAY_KEY;
    process.env.AI_GATEWAY_BASE_URL = 'https://custom.gateway.example/v1';
    const cfg = buildMem0Config();
    expect(cfg.embedder.config.baseURL).toBe('https://custom.gateway.example/v1');
    expect(cfg.llm.config.baseURL).toBe('https://custom.gateway.example/v1');
  });

  it('D — OpenRouter: baseURL and prefixed model names for openrouter.ai gateway', () => {
    if (!buildMem0Config) throw new TypeError('buildMem0Config is not exported from mem0.ts');
    process.env.AI_GATEWAY_API_KEY = GATEWAY_KEY;
    process.env.AI_GATEWAY_BASE_URL = 'https://openrouter.ai/api/v1';
    const cfg = buildMem0Config();
    expect(cfg.embedder.config.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(cfg.embedder.config.model).toBe('openai/text-embedding-3-small');
    expect(cfg.embedder.config.apiKey).toBe(GATEWAY_KEY);
    expect(cfg.llm.config.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(cfg.llm.config.model).toBe('openai/gpt-4o-mini');
    expect(cfg.llm.config.apiKey).toBe(GATEWAY_KEY);
  });

  it('G — LAIN_LLM_* overrides legacy AI_GATEWAY_* (unified schema wins)', () => {
    if (!buildMem0Config) throw new TypeError('buildMem0Config is not exported from mem0.ts');
    process.env.AI_GATEWAY_API_KEY = GATEWAY_KEY;
    process.env.AI_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';
    process.env.LAIN_LLM_API_KEY = 'new-key';
    process.env.LAIN_LLM_BASE_URL = 'http://localhost:11434/v1';
    const cfg = buildMem0Config();
    expect(cfg.embedder.config.baseURL).toBe('http://localhost:11434/v1');
    expect(cfg.embedder.config.apiKey).toBe('new-key');
    expect(cfg.llm.config.baseURL).toBe('http://localhost:11434/v1');
    expect(cfg.llm.config.apiKey).toBe('new-key');
  });

  it('H — LAIN_LLM_API_KEY alone behaves like a gateway key (vercel default base)', () => {
    if (!buildMem0Config) throw new TypeError('buildMem0Config is not exported from mem0.ts');
    process.env.LAIN_LLM_API_KEY = 'new-key';
    const cfg = buildMem0Config();
    expect(cfg.embedder.config.baseURL).toBe('https://ai-gateway.vercel.sh/v1');
    expect(cfg.embedder.config.model).toBe('openai/text-embedding-3-small');
    expect(cfg.llm.config.model).toBe('openai/gpt-4o-mini');
    expect(cfg.llm.config.apiKey).toBe('new-key');
  });

  it('I — LAIN_LLM_MODEL / LAIN_EMBED_MODEL override Mem0 models', () => {
    if (!buildMem0Config) throw new TypeError('buildMem0Config is not exported from mem0.ts');
    process.env.AI_GATEWAY_API_KEY = GATEWAY_KEY;
    process.env.LAIN_LLM_MODEL = 'custom/llm';
    process.env.LAIN_EMBED_MODEL = 'custom/embed';
    const cfg = buildMem0Config();
    expect(cfg.llm.config.model).toBe('custom/llm');
    expect(cfg.embedder.config.model).toBe('custom/embed');
  });
});

describe('installEmbedderGatewayPatch — provider pin (OpenRouter)', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL', 'LAIN_OPENAI_API_KEY', 'LAIN_LLM_API_KEY', 'LAIN_LLM_BASE_URL', 'LAIN_LLM_MODEL', 'LAIN_EMBED_MODEL'] as const;
  beforeEach(() => {
    KEYS.forEach(k => { saved[k] = process.env[k]; });
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.AI_GATEWAY_BASE_URL;
    delete process.env.LAIN_LLM_API_KEY;
    delete process.env.LAIN_LLM_BASE_URL;
    delete process.env.LAIN_LLM_MODEL;
    delete process.env.LAIN_EMBED_MODEL;
    process.env.LAIN_OPENAI_API_KEY = OPENAI_KEY;
    delete (OpenAIEmbedder.prototype as any)[Symbol.for('lain.mem0.embedderGatewayPatch')];
  });
  afterEach(() => {
    KEYS.forEach(k => { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; });
    delete (OpenAIEmbedder.prototype as any)[Symbol.for('lain.mem0.embedderGatewayPatch')];
  });

  function makeMockEmbedder() {
    const calls: any[] = [];
    const mockClient: any = {
      apiKey: 'gw-test-key',
      embeddings: { create: async (params: any) => { calls.push(params); return { data: [{ embedding: [0.1, 0.2] }] }; } },
    };
    function MockOpenAI(this: any) { return mockClient; }
    mockClient.constructor = MockOpenAI;
    const embedder: any = new OpenAIEmbedder({ model: 'openai/text-embedding-3-small', apiKey: 'gw-test-key' } as any);
    embedder.openai = mockClient;
    return { embedder, calls };
  }

  it('E — provider pin: embeddings.create receives provider.order=[openai] for openrouter.ai gateway', async () => {
    process.env.AI_GATEWAY_API_KEY = GATEWAY_KEY;
    process.env.AI_GATEWAY_BASE_URL = 'https://openrouter.ai/api/v1';
    const { embedder, calls } = makeMockEmbedder();
    buildMem0Config!();
    await embedder.embed('test text');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveProperty('provider');
    expect(calls[0].provider).toEqual({ order: ['openai'] });
  });

  it('F — no provider pin for Vercel gateway (backward compat)', async () => {
    process.env.AI_GATEWAY_API_KEY = GATEWAY_KEY;
    process.env.AI_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';
    const { embedder, calls } = makeMockEmbedder();
    buildMem0Config!();
    await embedder.embed('test text');
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('provider');
  });
});
