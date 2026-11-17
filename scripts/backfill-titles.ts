#!/usr/bin/env bun
/**
 * Backfill short titles for the diario archive (#6).
 *
 * Same model + same rules as the chat extractor (ideal 3 words, max 6),
 * N parallel workers (default 4, --concurrency=) with a small delay between
 * calls to stay polite; withRetry absorbs 429/5xx.
 *
 * Scope: project `diario` only (default), active AND archived (titles help
 * both in list display). Skips bundle digests (`[Bundle: ...`) and anything
 * that already has a title — idempotent, safe to re-run.
 *
 *   bun run scripts/backfill-titles.ts --dry-run [--project diario] [--limit 2000]
 *   bun run scripts/backfill-titles.ts --write
 *
 * Dry-run is the default. --write persists via setMemoryFeedback (merge —
 * votes and other signals are never clobbered).
 */
import {
  getMemories,
  setMemoryFeedback,
  withRetry,
  type MemoryFeedback,
} from '../src/mem0.js';
import { runFastLlmJson } from '../src/llm-client.js';
import { buildTitlePrompt, isTitleCandidate, normalizeChatTitle } from '../src/chat-extract.js';

const args = new Set(process.argv.slice(2));
const WRITE = args.has('--write');
const PROJECT = (process.argv.find((a) => a.startsWith('--project='))?.split('=')[1]) ?? 'diario';
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 2000);
const DELAY_MS = Number(process.argv.find((a) => a.startsWith('--delay='))?.split('=')[1] ?? 400);
const CONCURRENCY = Math.max(1, Number(process.argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? 4));
const TITLE_MAX_TOKENS = 1024;

type Item = { id: string; memory: string } & MemoryFeedback;

const items = (await getMemories(PROJECT, LIMIT)) as Item[];
console.log(`[backfill] project=${PROJECT} listed=${items.length} mode=${WRITE ? 'WRITE' : 'dry-run'}`);
const candidates = items.filter(isTitleCandidate);
console.log(`[backfill] candidates=${candidates.length} (skipped=${items.length - candidates.length} titled/bundle/empty)`);

let wrote = 0, failed = 0;
let cursor = 0;
async function worker() {
  while (true) {
    const i = cursor++;
    if (i >= candidates.length) return;
    const item = candidates[i];
    const fact = item.memory.trim();
    try {
      const res = await withRetry(() => runFastLlmJson<{ title?: unknown }>(buildTitlePrompt(fact), {
        maxTokens: TITLE_MAX_TOKENS,
        temperature: 0,
      }));
      const title = normalizeChatTitle(res?.title, fact);
      if (!title) {
        console.error(`[backfill] SKIP ${item.id} — empty title for: ${fact.slice(0, 60)}`);
        failed++;
        continue;
      }
      if (WRITE) {
        await setMemoryFeedback(item.id, { title });
        wrote++;
      }
      console.log(`[backfill] ${i + 1}/${candidates.length} ${item.id.slice(0, 8)} → "${title}"${WRITE ? '' : ' (dry)'}`);
    } catch (err) {
      console.error(`[backfill] FAIL ${item.id}:`, err instanceof Error ? err.message : err);
      failed++;
    }
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
console.log(`[backfill] DONE candidates=${candidates.length} wrote=${wrote} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
