#!/usr/bin/env bun
/**
 * Snapshot da importância das memórias — ponto de volta antes do backfill.
 *
 * Sem flags: lista TODOS os pontos do Qdrant (todos os projects, incluindo
 * trash), lê o estado em lote via memory-state (autoridade Qdrant, sem L2)
 * e grava scripts/eval-results/importance-<timestamp>.json com
 * { id, project, source, memory (120 chars), importance, kind, confidence }.
 * Imprime a distribuição das memórias de chat (metadata.source === 'chat').
 *
 *   bun run scripts/snapshot-importance.ts
 *   bun run scripts/snapshot-importance.ts --restore <arquivo> [--dry-run]
 *
 * --restore regrava importance + kind de cada id a partir do snapshot, via
 * memory-state. Pula ids que não existem mais (contados, não falham).
 * --dry-run só conta o que mudaria (0 sobre snapshot recém-gerado).
 * Exit 1 apenas em erro real de escrita/leitura.
 */
import { QdrantClient } from '@qdrant/js-client-rest';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectionName,
  readQdrantState,
  setImportance,
  setFeedback,
  clearImportance,
} from '../src/memory-state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCROLL_BATCH = 500;
const STATE_BATCH = 100;

interface Entry {
  id: string;
  project: string | null;
  source: string;
  memory: string;
  importance: number | null;
  kind: string;
  confidence: number;
}

function qdrant(): QdrantClient {
  return new QdrantClient({
    host: process.env.QDRANT_HOST || 'localhost',
    port: parseInt(process.env.QDRANT_PORT || '6333', 10),
    ...(process.env.LAIN_QDRANT_API_KEY ? { apiKey: process.env.LAIN_QDRANT_API_KEY } : {}),
    checkCompatibility: false,
  });
}

/** Todos os pontos da coleção (id, project, source, texto) via scroll. */
async function scrollAll(): Promise<Array<{ id: string; project: string | null; source: string; text: string }>> {
  const q = qdrant();
  const out: Array<{ id: string; project: string | null; source: string; text: string }> = [];
  let offset: unknown = undefined;
  for (;;) {
    const page = await q.scroll(collectionName(), {
      limit: SCROLL_BATCH, with_payload: true, with_vector: false, offset,
    });
    for (const p of page.points) {
      const payload = (p.payload ?? {}) as Record<string, unknown>;
      // Payload cru do Qdrant é FLAT (source/user_id/data no topo); a API
      // mem0 aninha sob `metadata` nas respostas — aceita os dois.
      const meta = (payload['metadata'] ?? {}) as Record<string, unknown>;
      const pick = (k: string): unknown =>
        payload[k] !== undefined ? payload[k] : meta[k];
      const userId = typeof pick('user_id') === 'string' ? pick('user_id') as string : '';
      const text = ['data', 'text', 'memory', 'document']
        .map((k) => pick(k))
        .find((v): v is string => typeof v === 'string' && v.length > 0) ?? '';
      out.push({
        id: String(p.id),
        project: userId === 'lucas' ? null : userId.replace(/^lucas:/, '') || null,
        source: typeof pick('source') === 'string' ? pick('source') as string : '(sem metadata)',
        text,
      });
    }
    offset = page.next_page_offset;
    if (offset === undefined || offset === null) break;
  }
  return out;
}

async function buildEntries(): Promise<{ entries: Entry[]; unanswered: number }> {
  const points = await scrollAll();
  const entries: Entry[] = [];
  let unanswered = 0;
  for (let i = 0; i < points.length; i += STATE_BATCH) {
    const batch = points.slice(i, i + STATE_BATCH);
    const states = await readQdrantState(batch.map((p) => p.id));
    for (const p of batch) {
      const st = states.get(p.id);
      if (!st || !st.answered) { unanswered++; continue; }
      entries.push({
        id: p.id,
        project: p.project,
        source: p.source,
        memory: p.text.slice(0, 120),
        importance: st.importance,
        kind: st.feedback?.kind ?? 'fact',
        confidence: st.feedback?.confidence ?? 0.5,
      });
    }
  }
  return { entries, unanswered };
}

type Bucket = '0.1-0.2' | '0.3-0.4' | '0.5' | '0.6-0.7' | '0.8+' | 'sem nota';

function printChatDistribution(entries: Entry[]): void {
  const chat = entries.filter((e) => e.source === 'chat');
  const buckets: Record<Bucket, number> = {
    '0.1-0.2': 0, '0.3-0.4': 0, '0.5': 0, '0.6-0.7': 0, '0.8+': 0, 'sem nota': 0,
  };
  for (const e of chat) {
    const v = e.importance;
    if (v === null) buckets['sem nota']++;
    else if (v <= 0.2) buckets['0.1-0.2']++;
    else if (v <= 0.4) buckets['0.3-0.4']++;
    else if (v === 0.5) buckets['0.5']++;
    else if (v <= 0.7) buckets['0.6-0.7']++;
    else buckets['0.8+']++;
  }
  console.log(`importância — memórias de chat: total=${chat.length}`);
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: ${v}`);
}

async function runSnapshot(): Promise<void> {
  const { entries, unanswered } = await buildEntries();
  printChatDistribution(entries);
  if (unanswered > 0) console.log(`sem resposta do Qdrant (fora do snapshot): ${unanswered}`);
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outDir = join(HERE, 'eval-results');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `importance-${ts}.json`);
  await writeFile(outFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    collection: collectionName(),
    total: entries.length,
    entries,
  }, null, 2));
  console.log(`\nSnapshot: ${entries.length} memórias → ${outFile}`);
  process.exit(0);
}

interface RestoreCounts { unchanged: number; changed: number; missing: number; unanswered: number; errors: number }

async function runRestore(file: string, dryRun: boolean): Promise<void> {
  const snap = JSON.parse(await readFile(file, 'utf-8')) as { entries: Entry[] };
  if (!Array.isArray(snap.entries)) throw new Error(`snapshot inválido: ${file}`);
  const counts: RestoreCounts = { unchanged: 0, changed: 0, missing: 0, unanswered: 0, errors: 0 };
  const ids = snap.entries.map((e) => e.id);
  for (let i = 0; i < snap.entries.length; i += STATE_BATCH) {
    const batch = snap.entries.slice(i, i + STATE_BATCH);
    const states = await readQdrantState(batch.map((e) => e.id));
    for (const e of batch) {
      const cur = states.get(e.id);
      if (!cur || !cur.answered) { counts.unanswered++; continue; }
      if (!cur.exists) { counts.missing++; continue; } // id não existe mais — pula
      const impSame = cur.importance === e.importance;
      const kindSame = (cur.feedback?.kind ?? 'fact') === e.kind;
      if (impSame && kindSame) { counts.unchanged++; continue; }
      counts.changed++;
      if (dryRun) continue;
      try {
        if (!impSame) {
          if (e.importance === null) await clearImportance(e.id);
          else await setImportance(e.id, e.importance);
        }
        if (!kindSame) await setFeedback(e.id, { kind: e.kind as 'fact' | 'state' });
      } catch (err) {
        counts.errors++;
        console.log(`  erro em ${e.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const tag = dryRun ? '[dry-run] ' : '';
  console.log(`${tag}restore: inalterados=${counts.unchanged} ${dryRun ? 'mudariam' : 'restaurados'}=${counts.changed} ` +
    `ausentes=${counts.missing} sem-resposta=${counts.unanswered} erros=${counts.errors}`);
  process.exit(counts.errors > 0 ? 1 : 0);
}

const restoreIdx = process.argv.indexOf('--restore');
if (restoreIdx !== -1) {
  const file = process.argv[restoreIdx + 1];
  if (!file || file.startsWith('--')) {
    console.error('uso: snapshot-importance.ts --restore <arquivo> [--dry-run]');
    process.exit(2);
  }
  await runRestore(file, process.argv.includes('--dry-run')).catch((err) => {
    console.error('restore falhou:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  await runSnapshot().catch((err) => {
    console.error('snapshot falhou:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
