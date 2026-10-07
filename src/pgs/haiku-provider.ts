/**
 * LLM Provider adapters for PGS.
 *
 * Primary: OpenAI-compatible chat-completions endpoint (unified llm-client schema).
 * Without LAIN_LLM_* set this is plain api.openai.com — identical to before.
 */

import type { LLMProvider } from './defaults.js';

/**
 * Resolve the PGS endpoint: explicit LAIN_LLM_BASE_URL opts into the unified
 * endpoint; otherwise keep the historical direct-OpenAI default.
 */
function getPgsBaseUrl(): string {
  return process.env.LAIN_LLM_BASE_URL || 'https://api.openai.com/v1';
}

function getPgsApiKey(): string {
  const apiKey = process.env.LAIN_LLM_API_KEY
    || process.env.LAIN_OPENAI_API_KEY
    || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('No LLM API key found (LAIN_LLM_API_KEY, LAIN_OPENAI_API_KEY or OPENAI_API_KEY)');
  return apiKey;
}

/**
 * Create an OpenAI-based LLM provider for PGS sweeps/synthesis.
 * Uses gpt-4o-mini for sweeps (fast, cheap) or gpt-4o for synthesis.
 */
export function createOpenAIProvider(model = 'gpt-4o-mini'): LLMProvider {
  const apiKey = getPgsApiKey();
  const baseURL = getPgsBaseUrl();

  return {
    async generate({ instructions, input, maxTokens }) {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: input },
          ],
          max_tokens: maxTokens,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`LLM API error (${response.status}): ${error}`);
      }

      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      return { content: data.choices[0]?.message?.content || '' };
    },
  };
}

/**
 * Create the default PGS providers — sweep (fast) + synthesis (capable).
 */
export function createPGSProviders(): { sweepProvider: LLMProvider; synthesisProvider: LLMProvider } {
  return {
    sweepProvider: createOpenAIProvider('gpt-4o-mini'),
    synthesisProvider: createOpenAIProvider('gpt-4o-mini'),
  };
}

/**
 * Adapter over the shared llm-client (fast model) as a PGS provider.
 */
export function createLlmProvider(): LLMProvider {
  return {
    async generate({ instructions, input }) {
      const { runHaiku } = await import('../llm-client.js');
      const prompt = `${instructions}\n\n---\n\n${input}`;
      const content = await runHaiku(prompt);
      return { content };
    },
  };
}

/** @deprecated Use createLlmProvider. */
export const createHaikuProvider = createLlmProvider;
