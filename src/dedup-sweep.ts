/**
 * Deduplication sweep job for Lain memory system.
 *
 * Runs every 24 hours. Finds memories with high text similarity
 * (> 0.92 cosine) and deletes the older duplicate, keeping the most recent.
 *
 * Uses a simple TF-IDF-like cosine similarity on tokenized text,
 * avoiding LLM calls for performance.
 */

import { getMemories } from './mem0.js';
import { incrementMetric } from './mem-metrics.js';

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SIMILARITY_THRESHOLD = 0.92;

let sweepTimer: ReturnType<typeof setInterval> | undefined;

function tokenize(text: string): Map<string, number> {
  const tokens = text.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  return freq;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, countA] of a) {
    normA += countA * countA;
    const countB = b.get(term) ?? 0;
    dot += countA * countB;
  }
  for (const [, countB] of b) normB += countB * countB;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function runDedupSweep(): Promise<{ duplicatesRemoved: number }> {
  console.log('[dedup] Starting deduplication sweep...');
  const memories = await getMemories(undefined, 500);
  let duplicatesRemoved = 0;
  const deleted = new Set<string>();
  // Fase 4: collect hygiene candidates; archive as one policy batch
  // (trash + audit) instead of direct hard deletes.
  const doomed = new Map<string, number>();

  const tokenized = memories.map(m => ({ ...m, tokens: tokenize(m.memory) }));

  for (let i = 0; i < tokenized.length; i++) {
    if (deleted.has(tokenized[i].id)) continue;
    for (let j = i + 1; j < tokenized.length; j++) {
      if (deleted.has(tokenized[j].id)) continue;
      const sim = cosineSimilarity(tokenized[i].tokens, tokenized[j].tokens);
      if (sim >= SIMILARITY_THRESHOLD) {
        // Keep most recent, archive the other
        const tsA = tokenized[i].updated_at ?? tokenized[i].created_at ?? '';
        const tsB = tokenized[j].updated_at ?? tokenized[j].created_at ?? '';
        const deleteIdx = tsA >= tsB ? j : i;
        const deleteId = tokenized[deleteIdx].id;
        deleted.add(deleteId);
        const prev = doomed.get(deleteId) ?? 0;
        doomed.set(deleteId, Math.max(prev, sim));
      }
    }
  }

  if (doomed.size > 0) {
    const { deleteMemoriesWithPolicy } = await import('./mem0.js');
    const bestSim = [...doomed.values()].reduce((a, b) => Math.max(a, b), 0);
    const report = await deleteMemoriesWithPolicy({
      ids: [...doomed.keys()],
      project: undefined,
      reason: `near-duplicate global memory (cosine >= ${SIMILARITY_THRESHOLD}, best sim=${bestSim.toFixed(3)})`,
      trigger: 'dedup-sweep',
    });
    duplicatesRemoved = report.archived.length;
    for (const id of report.archived) {
      incrementMetric('deduplicationsRun');
      console.log(`[dedup] Archived duplicate ${id.slice(0, 8)} (sim=${(doomed.get(id) ?? 0).toFixed(3)})`);
    }
    for (const f of report.failed) {
      console.error(`[dedup] Failed to archive ${f.id}:`, f.error);
    }
  }

  console.log(`[dedup] Sweep complete: removed ${duplicatesRemoved} duplicates`);
  return { duplicatesRemoved };
}

export function startDedupSweep(): void {
  // Run once on startup after a delay, then every 24h
  setTimeout(() => runDedupSweep().catch(err => console.error('[dedup] sweep error:', err)), 5 * 60 * 1000);
  sweepTimer = setInterval(
    () => runDedupSweep().catch(err => console.error('[dedup] sweep error:', err)),
    SWEEP_INTERVAL_MS,
  );
}

export function stopDedupSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}
