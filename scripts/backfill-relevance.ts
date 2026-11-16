#!/usr/bin/env bun
/**
 * Backfill de ratings do extrator para memórias antigas de chat (molde: backfill-titles).
 *
 * Candidatas: metadata.source === 'chat' no project diario (+ sem source com
 * --include-untagged). Pula digests (BUNDLE_PREFIX) e as que já têm relevance
 * em memory-state (o marcador gravado por esta tarefa e pela Tarefa B).
 *
 * Para cada uma: rateChatFact (só o texto do fato) → grava importância
 * (mapeamento da Tarefa B), kind, sensitive e relevance via memory-state.
 * Confirmadas (confidence 1.0 ou correct_count > 0): importância =
 * max(atual, mapeada) e o kind atual é preservado.
 *
 *   bun run scripts/backfill-relevance.ts [--dry-run] [--limit N] [--include-untagged]
 *
 * Padrão GRAVA; --dry-run só imprime a nota proposta. 1s entre chamadas.
 * Falha numa memória loga e segue. Segunda execução não reprocessa nada.
 */
import { getMemories, withRetry } from '../src/mem0.js';
import {
  readQdrantState,
  setImportance,
  setFeedback,
  setRelevance,
} from '../src/memory-state.js';
import {
  BUNDLE_PREFIX,
  rateChatFact,
  relevanceToImportance,
} from '../src/chat-extract.js';

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY_RUN = args.has('--dry-run');
const INCLUDE_UNTAGGED = args.has('--include-untagged');
function flagValue(name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}
const LIMIT = Number(flagValue('--limit') ?? Number.POSITIVE_INFINITY);
const PROJECT = 'diario';
const LIST_CAP = 5000;
const PAUSE_MS = 1000;

interface Candidate { id: string; memory: string }

function sourceOf(m: { metadata?: unknown }): string {
  const meta = (m as { metadata?: Record<string, unknown> }).metadata;
  return typeof meta?.['source'] === 'string' ? (meta['source'] as string) : '';
}

/** Universo chat (formato Tarefa A) para a distribuição final. */
function printDistribution(labeled: Array<{ importance: number | null }>): void {
  const buckets: Record<string, number> = {
    '0.1-0.2': 0, '0.3-0.4': 0, '0.5': 0, '0.6-0.7': 0, '0.8+': 0, 'sem nota': 0,
  };
  for (const e of labeled) {
    const v = e.importance;
    if (v === null) buckets['sem nota']++;
    else if (v <= 0.2) buckets['0.1-0.2']++;
    else if (v <= 0.4) buckets['0.3-0.4']++;
    else if (v === 0.5) buckets['0.5']++;
    else if (v <= 0.7) buckets['0.6-0.7']++;
    else buckets['0.8+']++;
  }
  console.log(`importância — memórias de chat: total=${labeled.length}`);
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: ${v}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const all = await getMemories(PROJECT, LIST_CAP);
  const inScope = all.filter((m) => {
    const s = sourceOf(m);
    if (s === 'chat') return true;
    return INCLUDE_UNTAGGED && s === '';
  });
  const fresh = inScope.filter((m) => !(m.memory ?? '').trimStart().startsWith(BUNDLE_PREFIX));
  const skippedDigest = inScope.length - fresh.length;

  const states = await readQdrantState(fresh.map((m) => m.id));
  const candidates: Candidate[] = [];
  let skippedRated = 0;
  let errors = 0;
  for (const m of fresh) {
    const st = states.get(m.id);
    if (!st || !st.answered || !st.exists) { errors++; continue; } // sem resposta / sumiu — tenta na próxima
    if (st.relevance !== null) { skippedRated++; continue; }
    candidates.push({ id: m.id, memory: m.memory });
  }
  const queue = candidates.slice(0, LIMIT);
  console.log(`[backfill] project=${PROJECT} candidatas=${candidates.length} modo=${DRY_RUN ? 'dry-run' : 'WRITE'}` +
    ` (digests=${skippedDigest} já-avaliadas=${skippedRated} sem-resposta-ou-erro=${errors})`);

  let processed = 0;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    try {
      const rating = await withRetry(() => rateChatFact(item.memory));
      const cur = (await readQdrantState([item.id])).get(item.id);
      const fb = cur?.feedback;
      const confirmed = (fb?.confidence ?? 0) === 1.0 || (fb?.correct_count ?? 0) > 0;
      const mapped = relevanceToImportance(rating.relevance);
      const target = confirmed ? Math.max(cur?.importance ?? mapped, mapped) : mapped;
      const kindPatch = !confirmed && (fb?.kind ?? 'fact') !== rating.kind ? rating.kind : null;
      const sensPatch = (fb?.sensitive ?? false) !== rating.sensitive ? rating.sensitive : null;
      if (DRY_RUN) {
        console.log(`[dry] ${item.id.slice(0, 8)} R${rating.relevance}→${target}` +
          (confirmed ? ' (confirmada: max, kind preservado)' : '') +
          (kindPatch ? ` kind→${kindPatch}` : '') + (sensPatch !== null ? ` sens→${sensPatch}` : '') +
          ` | ${item.memory.slice(0, 80)}`);
      } else {
        // Importância/kind/sensitive primeiro, relevance por último: falha no
        // meio deixa a memória sem marcador e a próxima execução a retoma.
        if (cur?.importance !== target) await setImportance(item.id, target);
        if (kindPatch !== null || sensPatch !== null) {
          await setFeedback(item.id, {
            ...(kindPatch !== null ? { kind: kindPatch } : {}),
            ...(sensPatch !== null ? { sensitive: sensPatch } : {}),
          });
        }
        await setRelevance(item.id, rating.relevance);
        console.log(`[backfill] ${i + 1}/${queue.length} ${item.id.slice(0, 8)} R${rating.relevance}→${target}${confirmed ? ' (confirmada)' : ''}`);
      }
      processed++;
    } catch (err) {
      console.error(`[backfill] FAIL ${item.id}:`, err instanceof Error ? err.message : String(err));
      errors++;
    }
    if (i < queue.length - 1) await sleep(PAUSE_MS);
  }

  // Distribuição nova no formato da Tarefa A (só source === 'chat').
  const chatIds = inScope.filter((m) => sourceOf(m) === 'chat').map((m) => m.id);
  const after = await readQdrantState(chatIds);
  printDistribution(chatIds.map((id) => ({ importance: after.get(id)?.importance ?? null })));
  console.log(`[backfill] DONE processadas=${processed} puladas=${skippedDigest + skippedRated} erros=${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

await main().catch((err) => {
  console.error('[backfill] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
