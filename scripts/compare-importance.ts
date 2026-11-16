#!/usr/bin/env bun
/**
 * Compara dois snapshots de scripts/snapshot-importance.ts (antes × depois).
 * SOMENTE LEITURA — nada é gravado no Qdrant ou no Redis.
 *
 *   bun run scripts/compare-importance.ts <antes.json> <depois.json>
 *
 * Imprime e grava em scripts/eval-results/compare-<timestamp>.txt:
 *   - distribuição de importância do chat antes/depois, lado a lado
 *   - 20 que mais subiram e 20 que mais desceram (delta sobre o valor
 *     efetivo no ranking: null conta como 0.5, o default do rankeador)
 *   - mudanças de kind (fact↔state)
 *   - sensitive: o snapshot da Tarefa A não registra sensitive, então só há
 *     o número atual (lido ao vivo via memory-state, sem escrever nada)
 *   - ids presentes num snapshot e ausentes no outro
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readQdrantState } from '../src/memory-state.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Entry {
  id: string; project: string | null; source: string; memory: string;
  importance: number | null; kind: string; confidence: number;
}

type Bucket = '0.1-0.2' | '0.3-0.4' | '0.5' | '0.6-0.7' | '0.8+' | 'sem nota';
const BUCKETS: Bucket[] = ['0.1-0.2', '0.3-0.4', '0.5', '0.6-0.7', '0.8+', 'sem nota'];

/** Valor que o ranking realmente usava: null (sem nota) = default 0.5. */
const eff = (v: number | null): number => v ?? 0.5;

function bucketOf(v: number | null): Bucket {
  if (v === null) return 'sem nota';
  if (v <= 0.2) return '0.1-0.2';
  if (v <= 0.4) return '0.3-0.4';
  if (v === 0.5) return '0.5';
  if (v <= 0.7) return '0.6-0.7';
  return '0.8+';
}

function dist(chat: Entry[]): Record<Bucket, number> {
  const d: Record<Bucket, number> = { '0.1-0.2': 0, '0.3-0.4': 0, '0.5': 0, '0.6-0.7': 0, '0.8+': 0, 'sem nota': 0 };
  for (const e of chat) d[bucketOf(e.importance)]++;
  return d;
}

async function main(): Promise<void> {
  const [beforeFile, afterFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!beforeFile || !afterFile) {
    console.error('uso: compare-importance.ts <antes.json> <depois.json>');
    process.exit(2);
  }
  const before = JSON.parse(await readFile(beforeFile, 'utf-8')) as { entries: Entry[] };
  const after = JSON.parse(await readFile(afterFile, 'utf-8')) as { entries: Entry[] };
  const bById = new Map(before.entries.map((e) => [e.id, e]));
  const aById = new Map(after.entries.map((e) => [e.id, e]));

  const lines: string[] = [];
  const log = (s = ''): void => { lines.push(s); console.log(s); };
  log(`compare-importance: antes=${beforeFile} (${before.entries.length}) depois=${afterFile} (${after.entries.length})`);

  // 1. Distribuição do chat, lado a lado.
  const bChat = before.entries.filter((e) => e.source === 'chat');
  const aChat = after.entries.filter((e) => e.source === 'chat');
  const db = dist(bChat);
  const da = dist(aChat);
  log('');
  log(`chat: antes n=${bChat.length} → depois n=${aChat.length}`);
  log('faixa     | antes | depois');
  for (const b of BUCKETS) log(`${b.padEnd(9)} | ${String(db[b]).padStart(5)} | ${String(da[b]).padStart(6)}`);

  // 2. Movers (só ids nos dois snapshots).
  const both = [...aById.keys()].filter((id) => bById.has(id));
  const movers = both
    .map((id) => ({ id, b: bById.get(id)!, a: aById.get(id)!, delta: eff(aById.get(id)!.importance) - eff(bById.get(id)!.importance) }))
    .sort((x, y) => y.delta - x.delta);
  const fmtImp = (v: number | null): string => (v === null ? 'sem nota' : v.toFixed(2));
  const fmtMover = (m: (typeof movers)[number]): string =>
    `${m.delta >= 0 ? '+' : ''}${m.delta.toFixed(2)}  imp ${fmtImp(m.b.importance)}→${fmtImp(m.a.importance)}` +
    `  kind ${m.b.kind}→${m.a.kind}  [${m.id.slice(0, 8)}] ${(m.a.memory || m.b.memory).slice(0, 120)}`;
  log('');
  log('== 20 que mais SUBIRAM (delta sobre valor efetivo; null = 0.5) ==');
  movers.slice(0, 20).forEach((m) => log(fmtMover(m)));
  log('');
  log('== 20 que mais DESCERAM ==');
  [...movers].reverse().slice(0, 20).forEach((m) => log(fmtMover(m)));

  // 3. Kind + sensitive.
  let factToState = 0, stateToFact = 0;
  for (const id of both) {
    const kb = bById.get(id)!.kind, ka = aById.get(id)!.kind;
    if (kb !== ka) {
      if (kb === 'fact' && ka === 'state') factToState++;
      else if (kb === 'state' && ka === 'fact') stateToFact++;
    }
  }
  const live = await readQdrantState(aChat.map((e) => e.id));
  let sensNow = 0;
  for (const e of aChat) if (live.get(e.id)?.feedback?.sensitive === true) sensNow++;
  log('');
  log(`kind: fact→state=${factToState}  state→fact=${stateToFact}`);
  log(`sensitive: agora=${sensNow}/${aChat.length} no chat (antes: sem dado — o snapshot da Tarefa A não registra sensitive)`);

  // 4. Ids só num dos lados.
  const onlyBefore = before.entries.filter((e) => !aById.has(e.id));
  const onlyAfter = after.entries.filter((e) => !bById.has(e.id));
  log('');
  log(`só no ANTES (${onlyBefore.length}):`);
  onlyBefore.slice(0, 20).forEach((e) => log(`  [${e.id.slice(0, 8)}] ${e.project ?? 'global'} | ${e.memory.slice(0, 100)}`));
  log(`só no DEPOIS (${onlyAfter.length}):`);
  onlyAfter.slice(0, 20).forEach((e) => log(`  [${e.id.slice(0, 8)}] ${e.project ?? 'global'} | ${e.memory.slice(0, 100)}`));

  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outDir = join(HERE, 'eval-results');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `compare-${ts}.txt`);
  await writeFile(outFile, lines.join('\n') + '\n');
  console.log(`\nSaída gravada em: ${outFile}`);
  process.exit(0);
}

await main().catch((err) => {
  console.error('compare falhou:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
