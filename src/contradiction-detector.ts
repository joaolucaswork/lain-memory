// server/src/contradiction-detector.ts

import { createHash } from 'crypto';
import { TtlCache } from './lib/ttl-cache.js';

export type MemoryActionType = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

export interface MemoryAction {
  action: MemoryActionType;
  supersedes: string[];
  reason: string;
}

export interface SimilarMemory {
  id: string;
  memory: string;
  score: number;
}

// ─── In-memory Cache ───

const CACHE_TTL = 3600;
const contradictionCache = new TtlCache<MemoryAction>({ maxEntries: 500 });

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    return (contradictionCache.get(key) as T | null) ?? null;
  } catch { return null; }
}

async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    contradictionCache.set(key, value as MemoryAction, CACHE_TTL);
  } catch { /* non-critical */ }
}

function buildCacheKey(newMemory: string, similarMemories: SimilarMemory[], language?: string, bundleMode?: boolean): string {
  const sortedTexts = [...similarMemories]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(m => m.memory)
    .join('|');
  // Include language in hash so different hints don't collide
  const langTag = language ? `lang:${language}||` : '';
  const contentHash = hashText(langTag + newMemory + '||' + sortedTexts);
  return `g4m:${bundleMode ? 'b1' : 'b0'}:${contentHash}`;
}

export async function classifyMemoryAction(
  newMemory: string,
  similarMemories: SimilarMemory[],
  language?: string,
  bundleMode?: boolean
): Promise<MemoryAction> {
  // No similar memories → always ADD
  if (similarMemories.length === 0) {
    return { action: 'ADD', supersedes: [], reason: 'No similar memories found' };
  }

  // Check for exact/near-exact duplicates first (fast path, no LLM)
  for (const existing of similarMemories) {
    const similarity = jaccardSimilarity(newMemory, existing.memory);
    if (similarity > 0.85) {
      return { action: 'NOOP', supersedes: [], reason: `Near-duplicate of ${existing.id} (similarity: ${similarity.toFixed(2)})` };
    }
  }

  // Check in-memory cache before calling LLM
  const cacheKey = buildCacheKey(newMemory, similarMemories, language, bundleMode);
  const cached = await cacheGet<MemoryAction>(cacheKey);
  if (process.env.LAIN_BENCH === '1') {
    console.log(JSON.stringify({
      tag: '[bench]', ts: Date.now(), file: 'contradiction-detector',
      func: 'classifyMemoryAction', cache_hit: !!cached,
      dedup_decision: cached ? cached.action : null,
    }));
  }
  if (cached) return cached;

  // Use LLM to classify relationship
  try {
    const { runFastLlmJson } = await import('./llm-client.js');
    const existingList = similarMemories
      .map((m, i) => `[${i}] (id: ${m.id}) ${m.memory}`)
      .join('\n');

    const langHint = language
      ? `Both new and existing memories may be in ${language}; consider semantic equivalence across languages when classifying.\n\n`
      : '';

    const bundleHint = bundleMode
      ? 'Note: This NEW MEMORY is a BUNDLE/SUMMARY, not a subset of EXISTING. Treat it as canonical even if EXISTING contains atomic facts that overlap. Prefer UPDATE over NOOP when the bundle covers multiple existing atoms.\n\n'
      : '';

    const result = await runFastLlmJson<{
      action: MemoryActionType;
      supersedes: number[];
      reason: string;
    }>(`${langHint}${bundleHint}You are a memory conflict detector. Compare a NEW memory against EXISTING memories and decide the action.

Actions:
- ADD: New memory has genuinely new information not covered by existing ones. Save it.
- UPDATE: New memory corrects, updates, or extends an existing one. The old one should be superseded.
- DELETE: New memory directly contradicts an existing one. The old one is wrong/outdated and should be superseded.
- NOOP: New memory is a duplicate or subset of existing. Don't save it.

IMPORTANT: If the new memory says something DIFFERENT about the same subject as an existing memory, that's UPDATE or DELETE, not ADD.
Examples:
- Existing: "X is used on Droplet and Vercel" → New: "X is used ONLY on Vercel" → DELETE (corrects wrong info), supersedes the existing
- Existing: "Project uses PostgreSQL" → New: "Project migrated to MySQL" → DELETE (outdated), supersedes
- Existing: "Deploy process requires PR" → New: "Deploy process requires PR and manual trigger" → UPDATE (extends), supersedes

SPECIFICITY GUARD: never UPDATE or DELETE a more specific existing memory with a vaguer new one. If the NEW memory contains pronouns or demonstratives without an explicit referent ("isso", "essa mistura", "ele", "lá") while the EXISTING states the referent explicitly, the new memory adds no information — return NOOP (the existing already covers it). Only supersede when the new memory is at least as specific and self-contained as the one it replaces.

NEW MEMORY:
${newMemory}

EXISTING MEMORIES:
${existingList}

Return JSON: {"action": "ADD|UPDATE|DELETE|NOOP", "supersedes": [indices of existing memories to supersede], "reason": "brief explanation"}`, { maxTokens: 512 });

    if (!result || !result.action) {
      return { action: 'ADD', supersedes: [], reason: 'LLM classification failed, defaulting to ADD' };
    }

    const supersededIds = (result.supersedes || [])
      .filter((idx: number) => idx >= 0 && idx < similarMemories.length)
      .map((idx: number) => similarMemories[idx].id);

    const finalResult: MemoryAction = {
      action: result.action,
      supersedes: supersededIds,
      reason: result.reason || '',
    };
    if (process.env.LAIN_BENCH === '1') {
      console.log(JSON.stringify({
        tag: '[bench]', ts: Date.now(), file: 'contradiction-detector',
        func: 'classifyMemoryAction', cache_hit: false,
        dedup_decision: finalResult.action,
      }));
    }
    cacheSet(cacheKey, finalResult);
    return finalResult;
  } catch (err) {
    console.error('[contradiction-detector] LLM classification failed:', err);
    return { action: 'ADD', supersedes: [], reason: 'LLM error, defaulting to ADD' };
  }
}

export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
  if (wordsA.size === 0 || wordsB.size === 0) return 0.0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  return intersection / (wordsA.size + wordsB.size - intersection);
}
