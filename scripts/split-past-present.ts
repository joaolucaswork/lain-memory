#!/usr/bin/env bun
/**
 * Split de memórias passado+presente num fato só (mecânica nova: um fato por
 * tempo verbal). Escopo fixo: 2 ids auditados no backfill de 2026-11-16.
 *
 * Para cada id antigo: salva os 2 splits via addMemoryWithConflictCheck
 * (chatAtom, metadata source=chat + chat_date original), rateia cada split
 * com rateChatFact, grava título+estado — e SÓ então move o original para o
 * trash via trashAndDelete (fail-closed: sem cópia no trash, sem delete).
 * Re-execução segura: id antigo ausente = já feito, pula.
 *
 *   bun run scripts/split-past-present.ts [--dry-run]
 */
import {
  addMemoryWithConflictCheck,
  getMemories,
  setMemoryFeedback,
  snapshotMemories,
  trashAndDelete,
} from '../src/mem0.js';
import {
  setFeedback,
  setImportance,
  setRelevance,
} from '../src/memory-state.js';
import {
  normalizeChatTitle,
  rateChatFact,
  relevanceToImportance,
} from '../src/chat-extract.js';

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECT = 'diario';

interface Split {
  oldId: string;
  parts: Array<{ text: string; title: string }>;
}

const SPLITS: Split[] = [
  {
    oldId: '4b39d6bc-225f-491c-945a-bf77217962c6',
    parts: [
      { text: 'Antes, o usuário usava a memória somente via MCP, com o agente principal.', title: 'Usava memória via MCP' },
      { text: 'O usuário agora vê a memória funcionando no webchat.', title: 'Memória no webchat' },
    ],
  },
  {
    oldId: '63bf2cba-a42d-4f80-ab42-7f9cabbed573',
    parts: [
      { text: 'O usuário teve um surto antes de uma cirurgia.', title: 'Surto antes de cirurgia' },
      { text: 'O usuário hoje entende as ideias que teve antes da cirurgia como sintomas do surto.', title: 'Ideias como sintomas do surto' },
    ],
  },
];

const NON_STORED = new Set(['noop', 'duplicate', 'blocked', 'rejected', 'unknown']);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const all = await getMemories(PROJECT, 5000) as Array<{ id: string; memory: string; metadata?: Record<string, unknown> }>;
  const byId = new Map(all.map((m) => [m.id, m]));
  let errors = 0;

  for (const split of SPLITS) {
    const old = byId.get(split.oldId);
    if (!old) { console.log(`[split] SKIP ${split.oldId.slice(0, 8)} — original ausente (já feito?)`); continue; }
    const chatDate = (old.metadata as any)?.['chat_date'] as string | undefined;
    console.log(`[split] ${split.oldId.slice(0, 8)} :: ${old.memory.slice(0, 90)}${DRY_RUN ? ' (dry)' : ''}`);

    const savedIds: string[] = [];
    for (const part of split.parts) {
      try {
        const rating = await rateChatFact(part.text);
        const title = normalizeChatTitle(part.title, part.text);
        if (DRY_RUN) {
          console.log(`  [dry] "${part.text.slice(0, 60)}" → kind=${rating.kind} rel=${rating.relevance} imp=${relevanceToImportance(rating.relevance)} sens=${rating.sensitive} title="${title}"`);
          continue;
        }
        // Cirurgia no original: os splits são substrings conhecidas do fato
        // antigo (o classificador os marcaria NOOP). Sem bypass, o split é
        // impossível com o original ainda presente.
        const rows = await addMemoryWithConflictCheck(part.text, PROJECT, {
          inferFalse: true,
          chatAtom: true,
          skipConflictCheck: true,
          metadata: {
            source: 'chat',
            ...(chatDate ? { chat_date: chatDate } : {}),
            chat_relevance: rating.relevance,
            chat_kind: rating.kind,
            chat_sensitive: rating.sensitive,
          },
        });
        const row = rows[0];
        if (!row || !row.id || NON_STORED.has(row.id)) {
          console.error(`  FAIL split não armazenado (action=${row?.action ?? '?'}): ${part.text.slice(0, 60)}`);
          errors++;
          continue;
        }
        await setMemoryFeedback(row.id, { title });
        await setImportance(row.id, relevanceToImportance(rating.relevance));
        await setFeedback(row.id, { kind: rating.kind, sensitive: rating.sensitive });
        await setRelevance(row.id, rating.relevance);
        savedIds.push(row.id);
        console.log(`  SAVED ${row.id.slice(0, 8)} kind=${rating.kind} rel=${rating.relevance} "${title}"`);
      } catch (err) {
        console.error(`  FAIL part:`, err instanceof Error ? err.message : String(err));
        errors++;
      }
      await sleep(1000);
    }

    if (DRY_RUN) continue;
    if (savedIds.length !== split.parts.length) {
      console.error(`[split] ABORT trash de ${split.oldId.slice(0, 8)}: ${savedIds.length}/${split.parts.length} splits salvos — original preservado`);
      errors++;
      continue;
    }
    const [snap] = await snapshotMemories([split.oldId], PROJECT);
    if (!snap || snap.missing || !snap.memory) {
      console.error(`[split] ABORT trash de ${split.oldId.slice(0, 8)}: snapshot vazio — original preservado`);
      errors++;
      continue;
    }
    const { trashId, deleted } = await trashAndDelete(snap, PROJECT, {
      reason: 'split passado/presente em dois fatos (mecânica nova)',
      trigger: 'split-past-present',
    });
    console.log(deleted
      ? `[split] TRASH ${split.oldId.slice(0, 8)} → ${trashId} (splits: ${savedIds.map((s) => s.slice(0, 8)).join(', ')})`
      : `[split] FAIL trash de ${split.oldId.slice(0, 8)} — original preservado`);
    if (!deleted) errors++;
  }

  console.log(`[split] DONE erros=${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

await main().catch((err) => {
  console.error('[split] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
