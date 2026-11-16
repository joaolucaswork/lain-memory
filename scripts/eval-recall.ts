#!/usr/bin/env bun
/**
 * Eval de recall — MEDIÇÃO, não muda o ranking.
 *
 * Para cada caso em eval-recall.cases.json: POST /api/memory/recall
 * (limit 10, debug:true) e registra hit@1, hit@5, posição do primeiro
 * acerto, adjustedScore e importance dele.
 *
 * Também imprime a distribuição atual de importância das memórias de
 * chat (metadata.source === 'chat'), lida via memory-state (autoridade
 * Qdrant, sem L2/defaults) — o número de referência para comparar depois.
 *
 *   LAIN_MEMORY_URL=http://127.0.0.1:3341 LAIN_MEMORY_API_KEY=... \
 *     bun run scripts/eval-recall.ts [--project diario] [--cases scripts/eval-recall.cases.json]
 *
 * Saída: tabela no stdout + JSON em scripts/eval-results/<timestamp>.json
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMemories } from '../src/mem0.js';
import { readQdrantState } from '../src/memory-state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (name: string, def: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def;

const BASE = (process.env.LAIN_MEMORY_URL ?? 'http://127.0.0.1:3341').replace(/\/$/, '');
const KEY = process.env.LAIN_MEMORY_API_KEY ?? process.env.LAIN_API_KEY ?? '';
const PROJECT = argOf('project', 'diario');
const CASES_FILE = argOf('cases', join(HERE, 'eval-recall.cases.json'));
const LIMIT = 10;

interface EvalCase { q: string; expect: string[]; skip?: boolean }
interface Hit {
  id: string;
  memory: string;
  score?: number;
  adjustedScore?: number;
  importance?: number | null;
}
interface CaseResult {
  q: string;
  expects: string[];
  position: number;
  hit1: boolean;
  hit5: boolean;
  adjustedScore: number | null;
  importance: number | null;
  matchedId: string | null;
  total: number;
}

/** recall via HTTP com debug:true (garante adjustedScore + importance). */
async function recall(query: string): Promise<Hit[]> {
  const res = await fetch(`${BASE}/api/memory/recall`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
    },
    body: JSON.stringify({ query, project: PROJECT, limit: LIMIT, debug: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`recall HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Hit[];
}

/** Menor índice cujo texto contém o substring (case-insensitive), -1 se nenhum. */
function firstMatch(hits: Hit[], expects: string[]): number {
  let best = -1;
  for (const e of expects) {
    const needle = e.toLowerCase();
    const idx = hits.findIndex((h) => (h.memory ?? '').toLowerCase().includes(needle));
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

function scoreCase(q: string, expects: string[], hits: Hit[]): CaseResult {
  const position = firstMatch(hits, expects);
  const m = position >= 0 ? hits[position] : null;
  return {
    q, expects, position,
    hit1: position === 0,
    hit5: position >= 0 && position < 5,
    adjustedScore: m?.adjustedScore ?? null,
    importance: m?.importance ?? null,
    matchedId: m?.id ?? null,
    total: hits.length,
  };
}

type Bucket = '0.1-0.2' | '0.3-0.4' | '0.5' | '0.6-0.7' | '0.8+' | 'sem nota' | 'sem resposta';

function bucketOf(v: number | null, answered: boolean): Bucket {
  if (!answered) return 'sem resposta';
  if (v === null) return 'sem nota';
  if (v <= 0.2) return '0.1-0.2';
  if (v <= 0.4) return '0.3-0.4';
  if (v === 0.5) return '0.5';
  if (v <= 0.7) return '0.6-0.7';
  return '0.8+';
}

/** Distribuição de importância das memórias de chat, via memory-state (Qdrant). */
async function chatImportanceDistribution(): Promise<{ total: number; buckets: Record<Bucket, number> }> {
  const all = await getMemories(PROJECT, 5000);
  const chat = all.filter((m) => (m.metadata as Record<string, unknown> | undefined)?.['source'] === 'chat');
  const states = await readQdrantState(chat.map((m) => m.id));
  const buckets: Record<Bucket, number> = {
    '0.1-0.2': 0, '0.3-0.4': 0, '0.5': 0, '0.6-0.7': 0, '0.8+': 0, 'sem nota': 0, 'sem resposta': 0,
  };
  for (const m of chat) {
    const st = states.get(m.id);
    buckets[bucketOf(st?.importance ?? null, st?.answered ?? false)]++;
  }
  return { total: chat.length, buckets };
}

function printCases(rows: CaseResult[]): void {
  console.log(`\nrecall eval — project=${PROJECT} limit=${LIMIT} casos=${rows.length}`);
  console.log('pos | h@1 | h@5 | adjScore | impor | pergunta');
  for (const r of rows) {
    const pos = r.position >= 0 ? String(r.position).padStart(3) : '  -';
    const adj = r.adjustedScore !== null ? r.adjustedScore.toFixed(3) : '  -  ';
    const imp = r.importance !== null ? String(r.importance).padStart(5) : '  -  ';
    console.log(`${pos} | ${r.hit1 ? 'sim' : 'não'} | ${r.hit5 ? 'sim' : 'não'} | ${adj}    | ${imp} | ${r.q.slice(0, 60)}`);
  }
  const h1 = rows.filter((r) => r.hit1).length;
  const h5 = rows.filter((r) => r.hit5).length;
  console.log(`resumo: hit@1 ${h1}/${rows.length}  hit@5 ${h5}/${rows.length}`);
}

async function main(): Promise<void> {
  const raw = await readFile(CASES_FILE, 'utf-8');
  const cases = (JSON.parse(raw) as EvalCase[]).filter((c) => !c.skip && c.expect.length > 0);
  // TODO: completar scripts/eval-recall.cases.json com ~15 perguntas pessoais.
  if (cases.length === 0) throw new Error('nenhum caso avaliável (só TODOs pulados)');

  const rows: CaseResult[] = [];
  for (const c of cases) rows.push(scoreCase(c.q, c.expect, await recall(c.q)));
  printCases(rows);

  const dist = await chatImportanceDistribution();
  console.log(`\nimportância — memórias de chat: total=${dist.total}`);
  for (const [k, v] of Object.entries(dist.buckets)) console.log(`  ${k}: ${v}`);

  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outDir = join(HERE, 'eval-results');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `${ts}.json`);
  await writeFile(outFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    base: BASE, project: PROJECT, limit: LIMIT,
    summary: { n: rows.length, hit1: rows.filter((r) => r.hit1).length, hit5: rows.filter((r) => r.hit5).length },
    cases: rows, distribution: dist,
  }, null, 2));
  console.log(`\nJSON: ${outFile}`);
  process.exit(0);
}

await main().catch((err) => {
  console.error('eval-recall falhou:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
