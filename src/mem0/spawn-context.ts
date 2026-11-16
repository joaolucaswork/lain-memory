/**
 * Spawn context (mem0 split M9a).
 *
 * getContextForSpawn: global + project recall composed into a char-budgeted
 * context block. Pure text query building (no LLM) + cached recall.
 */

import { cachedSearchMemory } from './read.js';
import type { MemoryLimits } from './types.js';

// ─── Progressive Context (Patch 5 → v2: dynamic char budget) ───

const DEFAULT_MAX_CONTEXT_CHARS = 6000;

/**
 * Get formatted memory context for Claude spawner.
 * Progressive loading: prioritizes by relevance, respects char budget.
 * Budget is dynamic based on task complexity (passed by spawner).
 * Fetches global memories + project-specific semantic search.
 */

// ─── Query Optimization (no LLM — pure text processing) ───

const QUERY_STOPWORDS = new Set([
  // Portuguese filler
  'que', 'nao', 'não', 'pra', 'pro', 'com', 'uma', 'uns', 'tem', 'tá', 'ta',
  'vai', 'vou', 'esse', 'essa', 'isso', 'isto', 'aqui', 'ali', 'ele', 'ela',
  'eles', 'elas', 'como', 'mais', 'mas', 'nos', 'nas', 'dos', 'das', 'pelo',
  'pela', 'por', 'para', 'sem', 'sob', 'sobre', 'entre', 'ate', 'até',
  'quando', 'onde', 'quem', 'qual', 'sera', 'será', 'seria', 'pode', 'deve',
  'precisa', 'caso', 'entao', 'então', 'depois', 'antes', 'ainda', 'tambem',
  'também', 'porque', 'porquê', 'voce', 'você', 'gente', 'tipo', 'coisa',
  'certo', 'bom', 'sim', 'olha', 'veja', 'faz', 'fez', 'fazer',
  'usuario', 'usuário', 'reclamando', 'falando', 'dizendo', 'pedindo',
  // English filler
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has',
  'been', 'will', 'what', 'when', 'where', 'which', 'would', 'should',
  'could', 'does', 'into', 'just', 'also', 'about', 'some', 'very',
  'need', 'want', 'check', 'look', 'see', 'know', 'think', 'make',
]);

/**
 * Extract key terms from a message for optimized memory search.
 * No LLM — pure text processing. Removes filler, keeps domain terms.
 */
function buildSearchQuery(message: string, project?: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/[^\w\sáàâãéèêíìîóòôõúùûçñ]/g, ' ') // keep letters + accented chars
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalized.split(' ')
    .filter(w => w.length >= 3 && !QUERY_STOPWORDS.has(w));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique = words.filter(w => {
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });

  // Prepend project name if available (boosts project-relevant results)
  const query = project
    ? `${project} ${unique.join(' ')}`
    : unique.join(' ');

  // If query is too short after filtering, fall back to original
  return query.length >= 5 ? query : message;
}

export async function getContextForSpawn(message: string, project?: string, charBudget?: number, limits?: MemoryLimits): Promise<string> {
  // Early exit if memory is completely disabled for this tier
  if (limits && limits.globalLimit === 0 && limits.projectLimit === 0) {
    return '';
  }

  const effectiveGlobalLimit = limits?.globalLimit ?? 15;
  const effectiveProjectLimit = limits?.projectLimit ?? 15;

  // Build optimized search query (no LLM — pure text processing)
  const searchQuery = buildSearchQuery(message, project);

  // Parallel calls with individual error handling
  const globalMemsPromise = effectiveGlobalLimit > 0
    ? (async () => {
        try {
          return await cachedSearchMemory(searchQuery, undefined, effectiveGlobalLimit) as { memory: string; score?: number }[];
        } catch { return []; }
      })()
    : Promise.resolve([] as { memory: string; score?: number }[]);

  const projectMemsPromise = (project && effectiveProjectLimit > 0)
    ? (async () => {
        try {
          const t0 = Date.now();
          const results = await cachedSearchMemory(searchQuery, project, effectiveProjectLimit) as { memory: string; score?: number }[];
          if (effectiveGlobalLimit === 5 && effectiveProjectLimit === 5) {
            console.log(`[recall:simple] project memories fetched in ${Date.now() - t0}ms (${results.length} results)`);
          }
          return results;
        } catch { return []; }
      })()
    : Promise.resolve([] as { memory: string; score?: number }[]);

  const [globalList, projectList] = await Promise.all([
    globalMemsPromise, projectMemsPromise,
  ]);

  // Build context with progressive loading (budget-aware)
  let budget = charBudget ?? DEFAULT_MAX_CONTEXT_CHARS;
  const globalLines: string[] = [];
  const projectLines: string[] = [];

  // 1. Global memories (highest priority — user prefs/facts)
  for (const m of globalList) {
    const line = `- ${m.memory}`;
    if (budget - line.length < 0) break;
    globalLines.push(line);
    budget -= line.length;
  }

  // 2. Project memories sorted by relevance score (higher = more relevant)
  if (projectList.length > 0) {
    const sorted = [...projectList].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (const m of sorted) {
      const line = `- ${m.memory}`;
      if (budget - line.length < 0) break;
      projectLines.push(line);
      budget -= line.length;
    }
  }

  if (globalLines.length === 0 && projectLines.length === 0) return '';

  // Build output with typed block headers for clear agent navigation
  const parts: string[] = [];
  if (globalLines.length > 0) {
    parts.push('## Global (preferences & facts)');
    parts.push(...globalLines);
  }
  if (projectLines.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(`## Project: ${project}`);
    parts.push(...projectLines);
  }

  return parts.join('\n');
}
