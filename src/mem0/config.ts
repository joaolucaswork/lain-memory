/**
 * Mem0 client configuration (mem0 split M2).
 *
 * Owns the Mem0 SDK singleton, provider wiring (gateway patches), the
 * retry helper, and the user_id scheme. Sibling modules import getClient,
 * userId and withRetry from here; mem0.ts re-exports the public surface
 * (buildMem0Config, isMem0Configured, withRetry) so importers are unchanged.
 */

import { Memory, OpenAIEmbedder, OpenAILLM } from 'mem0ai/oss';
import { INSTANCE_ID } from '../workspace.js';
import { MASTER_TENANT, normalizeTenant } from '../tenants.js';

let client: Memory | null = null;

// Symbol used to guard against double-patching the OpenAILLM prototype
const kGatewayPatch = Symbol.for('lain.mem0.gatewayPatch');

function installGatewayPatch() {
  const proto = OpenAILLM.prototype as any;
  if (proto[kGatewayPatch]) return;
  const original = proto.generateResponse;
  proto.generateResponse = async function(messages: unknown, responseFormat: any, tools: unknown) {
    if (responseFormat?.type === 'json_object') {
      responseFormat = {
        type: 'json_schema',
        json_schema: {
          name: 'mem0_response',
          strict: false,
          schema: { type: 'object', additionalProperties: true, properties: {} },
        },
      };
    }
    return original.call(this, messages, responseFormat, tools);
  };
  proto[kGatewayPatch] = true;
}

// ─── Retry Helper (item #3 — exponential backoff on 429/5xx) ───

type DelayFn = (ms: number) => Promise<void>;
const DEFAULT_DELAY: DelayFn = ms => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /\b429\b|5\d\d/.test(err.message);
}

/**
 * Retry wrapper with exponential backoff for transient HTTP errors.
 * Retries on 429 (rate-limit) and 5xx (server error) only.
 * Rethrows immediately on any other error class.
 * delayFn is injectable so tests do not sleep.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxAttempts?: number; baseDelayMs?: number; delayFn?: DelayFn }
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  const delay = opts?.delayFn ?? DEFAULT_DELAY;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === maxAttempts - 1) throw err;
      const jitter = Math.random() * 0.5 * baseDelayMs;
      await delay(baseDelayMs * Math.pow(2, attempt) + jitter);
    }
  }
  throw lastErr;
}

const kEmbedderGatewayPatch = Symbol.for('lain.mem0.embedderGatewayPatch');
const kEmbedderOriginal = Symbol.for('lain.mem0.embedderOriginal');

function installEmbedderGatewayPatch(baseURL: string, providerPin?: Record<string, unknown>) {
  const proto = OpenAIEmbedder.prototype as any;
  if (proto[kEmbedderGatewayPatch]) return;
  // Capture the TRUE pristine methods once, ever — so re-patching (after a guard
  // reset, e.g. in tests) always wraps the original, never a previous wrapper.
  if (!proto[kEmbedderOriginal]) {
    proto[kEmbedderOriginal] = { embed: proto.embed, embedBatch: proto.embedBatch };
  }
  const originalEmbed = proto[kEmbedderOriginal].embed;
  const originalEmbedBatch = proto[kEmbedderOriginal].embedBatch;
  function ensureGatewayClient(this: any) {
    if (this._gatewayClientReplaced) return;
    const OpenAIClass = this.openai.constructor;
    const rawClient = new OpenAIClass({ apiKey: this.openai.apiKey, baseURL });
    if (providerPin) {
      const origCreate = rawClient.embeddings.create.bind(rawClient.embeddings);
      rawClient.embeddings.create = (params: any, opts?: any) => origCreate({ ...params, ...providerPin }, opts);
    }
    this.openai = rawClient;
    this._gatewayClientReplaced = true;
  }
  proto.embed = async function(text: string) {
    ensureGatewayClient.call(this);
    return withRetry(() => originalEmbed.call(this, text));
  };
  proto.embedBatch = async function(texts: string[]) {
    ensureGatewayClient.call(this);
    return withRetry(() => originalEmbedBatch.call(this, texts));
  };
  proto[kEmbedderGatewayPatch] = true;
}

export function buildMem0Config() {
  // Unified LLM resolution (llm-client schema): LAIN_LLM_* wins, legacy
  // AI_GATEWAY_* is the fallback. With no LAIN_LLM_* set the result is
  // identical to the pre-unification behavior.
  const gatewayKey  = process.env.LAIN_LLM_API_KEY || process.env.AI_GATEWAY_API_KEY;
  const gatewayBase = process.env.LAIN_LLM_BASE_URL
    || process.env.AI_GATEWAY_BASE_URL
    || (gatewayKey ? 'https://ai-gateway.vercel.sh/v1' : undefined);
  const openaiKey   = process.env.LAIN_OPENAI_API_KEY;
  const useGateway  = Boolean(gatewayKey);
  const apiKey      = useGateway ? gatewayKey : openaiKey;
  // Mem0's internal LLM (fact extraction) and embeddings models. Explicit
  // LAIN_LLM_MODEL / LAIN_EMBED_MODEL win; otherwise keep the previous
  // gateway-prefixed vs bare defaults (NOT LAIN_FAST_MODEL — that drives the
  // chat client in llm-client.ts and may name a non-OpenAI model).
  const embedModel  = process.env.LAIN_EMBED_MODEL
    ?? (useGateway ? 'openai/text-embedding-3-small' : 'text-embedding-3-small');
  // Provider is openai_structured (not openai): it forwards Mem0's
  // response_format:json_object untouched. The plain openai path goes through
  // installGatewayPatch, which rewrites the request as an empty-properties
  // json_schema — gpt-4o-mini tolerates it, Haiku does not, and Mem0's zod
  // parse then silently yields zero atoms. Verified matrix (Nov 2026):
  // openai_structured + Haiku via OpenRouter extracts normally, so the model
  // follows LAIN_LLM_MODEL again — no separate pin needed.
  const llmModel = process.env.LAIN_LLM_MODEL
    ?? (useGateway ? 'openai/gpt-4o-mini' : 'gpt-4o-mini');
  if (useGateway) {
    installGatewayPatch();
    const isOpenRouter = Boolean(gatewayBase) && (() => {
      try { return new URL(gatewayBase!).hostname.endsWith('openrouter.ai'); }
      catch { return false; }
    })();
    installEmbedderGatewayPatch(
      gatewayBase!,
      isOpenRouter ? { provider: { order: ['openai'] } } : undefined,
    );
  }
  return {
    embedder: {
      provider: 'openai' as const,
      config: { apiKey, model: embedModel, ...(useGateway ? { baseURL: gatewayBase } : {}) },
    },
    llm: {
      // NOTE (verified against mem0ai 3.3.1 dist/oss source): the OpenAI LLM
      // class sends no max_tokens and no provider routing — only apiKey,
      // baseURL, model, timeout are honored. So mem0's internal extraction
      // can't be latency-pinned from here; bound it via LAIN_LLM_MODEL choice.
      // Deliberately no `timeout`: a slow extraction should delay, not fail,
      // the save (fail-fast here would lose the memory).
      // Provider openai_structured forwards response_format:json_object
      // untouched (see above) — required for non-OpenAI models.
      provider: 'openai_structured' as const,
      config: { apiKey, model: llmModel, ...(useGateway ? { baseURL: gatewayBase } : {}) },
    },
  };
}

export function getClient(): Memory {
  if (!client) {
    const qdrantHost = process.env.QDRANT_HOST || 'localhost';
    const qdrantPort = parseInt(process.env.QDRANT_PORT || '6333', 10);

    if (!process.env.LAIN_OPENAI_API_KEY && !process.env.AI_GATEWAY_API_KEY && !process.env.LAIN_LLM_API_KEY) {
      throw new Error('LAIN_LLM_API_KEY (or LAIN_OPENAI_API_KEY / AI_GATEWAY_API_KEY) not set — required for Mem0 OSS embeddings');
    }

    const { embedder, llm } = buildMem0Config();

    client = new Memory({
      embedder,
      vectorStore: {
        provider: 'qdrant',
        config: {
          host: qdrantHost,
          port: qdrantPort,
          collectionName: INSTANCE_ID ? `mem0-${INSTANCE_ID}` : 'mem0',
          ...(process.env.LAIN_QDRANT_API_KEY ? { apiKey: process.env.LAIN_QDRANT_API_KEY } : {}),
        },
      },
      llm,
      disableHistory: true,
    });
  }
  return client;
}

/** Test-only: drop the singleton so mock Memory classes don't leak across test files. */
export function __resetClientForTests(): void {
  client = null;
}

export function userId(project?: string, tenant: string = MASTER_TENANT): string {
  // mem0 rejeita user_id com whitespace — sanitiza para projetos com espaço (ex "lain::latency fixes").
  // Multitenant: o tenant prefixa o user_id (`<tenant>` / `<tenant>:<projeto>`).
  // Master (`lucas`) reproduz o esquema legado byte-identical: `lucas[:projeto].
  const t = normalizeTenant(tenant) || MASTER_TENANT;
  const clean = project?.trim().replace(/\s+/g, '_');
  return clean ? `${t}:${clean}` : t;
}

export function isMem0Configured(): boolean {
  return !!(process.env.QDRANT_HOST || process.env.LAIN_OPENAI_API_KEY);
}
