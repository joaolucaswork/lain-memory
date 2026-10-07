/**
 * Shared LLM client — any OpenAI-compatible chat-completions endpoint.
 * Works with OpenRouter, Vercel AI Gateway, LiteLLM, Ollama, plain OpenAI, etc.
 *
 * The `runHaiku*` export names are aliases kept for existing callers —
 * prefer the `runFastLlm*` names in new code.
 *
 * Env vars (new unified schema — LAIN_LLM_* wins, legacy keys are fallbacks):
 *   LAIN_LLM_BASE_URL    — OpenAI-compatible base URL (default: https://openrouter.ai/api/v1)
 *   LAIN_LLM_API_KEY     — API key (fallback: OPENROUTER_API_KEY, then AI_GATEWAY_API_KEY,
 *                          then LAIN_OPENAI_API_KEY / OPENAI_API_KEY)
 *   LAIN_FAST_MODEL      — model for fast calls (default: deepseek/deepseek-v4-flash)
 *   LAIN_STANDARD_MODEL  — model for standard calls (default: deepseek/deepseek-v4-flash)
 *
 * Used by the memory path (conflict detection, enrichment, GraphRAG, seed
 * extraction, consolidation) — no Claude Code CLI dependency anywhere here.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Resolve the chat-completions base URL.
 * Explicit LAIN_LLM_BASE_URL wins; otherwise reuse the Mem0 gateway URL when set
 * (today that is OpenRouter — same effective endpoint as the old hardcoded one),
 * otherwise fall back to the OpenRouter default.
 */
export function getLlmBaseUrl(): string {
  return process.env.LAIN_LLM_BASE_URL
    || process.env.AI_GATEWAY_BASE_URL
    || DEFAULT_BASE_URL;
}

/**
 * Resolve the LLM API key. New LAIN_LLM_API_KEY wins; legacy keys follow in the
 * order that preserves current behavior (chat client historically used OPENROUTER_API_KEY).
 */
export function getLlmApiKey(): string {
  const key = process.env.LAIN_LLM_API_KEY
    || process.env.OPENROUTER_API_KEY
    || process.env.AI_GATEWAY_API_KEY
    || process.env.LAIN_OPENAI_API_KEY
    || process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      'No LLM API key set (need LAIN_LLM_API_KEY or one of OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, LAIN_OPENAI_API_KEY, OPENAI_API_KEY)'
    );
  }
  return key;
}

export function getFastModel(): string {
  return process.env.LAIN_FAST_MODEL || 'deepseek/deepseek-v4-flash';
}

export function getStandardModel(): string {
  return process.env.LAIN_STANDARD_MODEL || 'deepseek/deepseek-v4-flash';
}

export interface ChatCallOpts {
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  systemPrompt?: string;
  /**
   * OpenRouter provider routing object (e.g. `{ preferred_max_latency: { p90: 5 } }`).
   * `undefined` (default) uses the default routing below; `null` forces omission.
   */
  provider?: Record<string, unknown> | null;
}

/**
 * Default provider routing for chat calls: soft latency preference
 * (reorder only — never 404s) applied ONLY when the base URL is OpenRouter.
 * Non-OpenRouter endpoints (Vercel gateway, Ollama, plain OpenAI) don't
 * understand the `provider` field, so it is omitted there.
 * Kill switch: LAIN_LLM_PROVIDER_ROUTING=off (also 0/false/no).
 */
export function getDefaultProviderRouting(): Record<string, unknown> | undefined {
  const flag = (process.env.LAIN_LLM_PROVIDER_ROUTING || 'on').toLowerCase();
  if (flag === 'off' || flag === '0' || flag === 'false' || flag === 'no') return undefined;
  let host = '';
  try {
    host = new URL(getLlmBaseUrl()).hostname;
  } catch {
    return undefined;
  }
  if (!host.endsWith('openrouter.ai')) return undefined;
  return { preferred_max_latency: { p90: 5 } };
}

async function callChatCompletions(prompt: string, opts: {
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  systemPrompt?: string;
  provider?: Record<string, unknown> | null;
}): Promise<string> {
  const baseURL = getLlmBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? 15_000);
  const provider = opts.provider === undefined ? getDefaultProviderRouting() : opts.provider;

  try {
    const _benchT0 = process.env.LAIN_BENCH === '1' ? Date.now() : 0;
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getLlmApiKey()}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: opts.systemPrompt ?? 'You are a fast, concise assistant. Respond in the same language as the user. No preamble, no filler.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.3,
        ...(provider ? { provider } : {}),
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status} (${baseURL}): ${errBody.slice(0, 200)}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('LLM returned empty response');

    if (process.env.LAIN_BENCH === '1') {
      console.log(JSON.stringify({
        tag: '[bench]', ts: Date.now(), file: 'llm-client', func: 'callChatCompletions',
        model_used: opts.model, endpoint: baseURL, latency_ms: Date.now() - _benchT0,
        prompt_tokens: data.usage?.prompt_tokens ?? null,
        completion_tokens: data.usage?.completion_tokens ?? null,
        cache_hit: null, dedup_decision: null, source_id: null,
      }));
    }

    return content;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`LLM timeout (${opts.timeout ?? 15_000}ms)`);
    }
    throw err;
  }
}

/**
 * Fast LLM call. ~1-2s response time.
 */
export async function runFastLlm(prompt: string, opts?: ChatCallOpts): Promise<string> {
  return callChatCompletions(prompt, { model: getFastModel(), timeout: 15_000, ...opts });
}

export async function runStandardLlm(prompt: string, opts?: ChatCallOpts): Promise<string> {
  return callChatCompletions(prompt, { model: getStandardModel(), timeout: 90_000, ...opts });
}

export async function runStandardLlmJson<T>(prompt: string, opts?: ChatCallOpts): Promise<T> {
  const result = await runStandardLlm(prompt, opts);
  return parseJsonFromLlm<T>(result);
}

export async function runFastLlmJson<T>(prompt: string, opts?: ChatCallOpts): Promise<T> {
  const result = await runFastLlm(prompt, opts);
  return parseJsonFromLlm<T>(result);
}

/** Robustly extract JSON from LLM output that may contain surrounding text. */
function parseJsonFromLlm<T>(raw: string): T {
  const text = raw.trim();

  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock?.[1]) {
    try { return JSON.parse(codeBlock[1].trim()); } catch {}
  }

  try { return JSON.parse(text); } catch {}

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(candidate); } catch {}
    const fixed = candidate.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(fixed); } catch {}
  }

  throw new Error(`Failed to parse JSON from LLM output: ${text.slice(0, 200)}`);
}

/**
 * Lightweight call for quick summaries (session-context, checkpoint).
 * Returns trimmed output or null on failure.
 */
export function callFastLlmSafe(prompt: string, opts?: ChatCallOpts): Promise<string | null> {
  return callChatCompletions(prompt, {
    model: getFastModel(),
    maxTokens: 1024,
    timeout: 15_000,
    ...opts,
  }).then(r => r || null).catch(() => null);
}

// ─── Legacy haiku.* aliases (deprecated — prefer the runFastLlm* names) ───

/** @deprecated Use runFastLlm — same function, clearer name. */
export const runHaikuFast = runFastLlm;
/** @deprecated Use runStandardLlm. */
export const runHaiku = runStandardLlm;
/** @deprecated Use runStandardLlmJson. */
export const runHaikuJson = runStandardLlmJson;
/** @deprecated Alias of runFastLlmJson. */
export const runHaikuFastJson = runFastLlmJson;
/** @deprecated Use callFastLlmSafe. */
export const callHaiku = callFastLlmSafe;
