#!/usr/bin/env bun
/**
 * Migrate diary-like memories from global (lucas) to lucas:diario.
 *
 *   bun run scripts/migrate-diario.ts          # dry-run (no writes)
 *   bun run scripts/migrate-diario.ts --live   # copy + archive originals
 *
 * Copy is verbatim (infer:false, no quality/conflict checks, no graph ingest)
 * so diary text lands byte-identical. Originals are archived via
 * deleteMemoriesWithPolicy (trash + audit, fail-closed) — never hard-deleted.
 * Idempotent: skips globals whose text already exists in diario.
 */

import { getMemories, addMemory, deleteMemoriesWithPolicy } from '../src/mem0.js';
import { logMaintenance } from '../src/maintenance-log.js';

// Same split the user approved: TECH stays global, everything else -> diario.
const TECH_RE = /OTP|Resend|onboarding|modal|cadastro|dashboard|API|curl|endpoint|supabase|stripe|vercel|typescript|docker|kubectl|ENEM|percurso-admin|percurso|lain-chat|lain-memory|redis|qdrant|prisma|graphql|webhook|pm2|ecosystem|DID|SIP|reino.?capital|portf[oó]lio|backoffice/i;

const isDiary = (text: string) => !TECH_RE.test(text);
const live = process.argv.includes('--live');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const QDRANT = `http://${process.env.QDRANT_HOST || 'localhost'}:${process.env.QDRANT_PORT || '6333'}`;
const COLLECTION = 'mem0';

/** Restore the original dates on a fresh diario copy (Mem0 stamps inserts with now()). */
async function patchCopyDates(copyId: string, orig: { created_at?: string; updated_at?: string }): Promise<void> {
  const payload: Record<string, unknown> = {
    createdAt: orig.created_at,
    original_created_at: orig.created_at,
  };
  if (orig.updated_at) {
    payload.updatedAt = orig.updated_at;
    payload.original_updated_at = orig.updated_at;
  }
  const res = await fetch(`${QDRANT}/collections/${COLLECTION}/points/payload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, points: [copyId], wait: true }),
  });
  if (!res.ok) throw new Error(`payload patch → ${res.status}`);
}

const globals = await getMemories(undefined, 200);
const diarios = await getMemories('diario', 200);
const diarioTexts = new Set(diarios.map(m => m.memory));

const diaryCands = globals.filter(m => isDiary(m.memory));
const techKeep = globals.filter(m => !isDiary(m.memory));
const alreadyThere = diaryCands.filter(m => diarioTexts.has(m.memory));
const toMove = diaryCands.filter(m => !diarioTexts.has(m.memory));

console.log(`global=${globals.length} diario=${diarios.length}`);
console.log(`diary candidates=${diaryCands.length} (already in diario=${alreadyThere.length}, to move=${toMove.length}) tech keep=${techKeep.length}`);
if (!live) {
  console.log('DRY-RUN — no writes. First 10 to move:');
  for (const m of toMove.slice(0, 10)) console.log(` - ${m.id.slice(0, 8)} | ${m.memory.slice(0, 110).replace(/\n/g, ' ')}`);
  console.log('Re-run with --live to copy + archive.');
  process.exit(0);
}

let copied = 0, archived = 0, copyFailed = 0, archiveFailed = 0;
const t0 = Date.now();
for (let i = 0; i < toMove.length; i++) {
  const m = toMove[i];
  console.log(`[${i + 1}/${toMove.length}] ${m.id.slice(0, 8)} ${(m.memory || '').slice(0, 80).replace(/\n/g, ' ')}`);
  let newId: string | null = null;
  try {
    const res = await addMemory(m.memory, 'diario', {
      inferFalse: true,
      skipQualityCheck: true,
      skipConflictCheck: true,
      skipGraphIngest: true,
      metadata: { migrated_from: 'global', original_id: m.id, migrated_at: new Date().toISOString() },
    });
    newId = res[0]?.id ?? null;
    if (!newId || newId === 'unknown' || newId === 'rejected' || newId === 'duplicate') {
      console.error(`  copy FAILED: ${newId}`);
      copyFailed++;
      continue;
    }
    await patchCopyDates(newId, m); // keep original created_at (Mem0 stamps now())
    copied++;
  } catch (e) {
    console.error(`  copy ERROR:`, e instanceof Error ? e.message : e);
    copyFailed++;
    continue;
  }
  try {
    const report = await deleteMemoriesWithPolicy({
      ids: [m.id],
      project: undefined,
      reason: 'migrated global -> diario (diary isolation, verbatim copy)',
      trigger: 'migration:global-to-diario',
      replacedById: newId!,
    });
    if (report.archived.includes(m.id)) {
      archived++;
    } else {
      console.error(`  archive FAILED (original preserved, copy exists at ${newId}):`, report.failed[0]?.error);
      archiveFailed++;
    }
  } catch (e) {
    console.error(`  archive ERROR (original preserved):`, e instanceof Error ? e.message : e);
    archiveFailed++;
  }
  await sleep(300); // avoid Mem0 429
}

// Phase 2: archive originals whose copy already exists in diario
// (covers copies made before the date fix + earlier trash-unconfirmed retries).
const diarioByText = new Map(diarios.map(d => [d.memory, d.id]));
console.log(`phase 2: archiving ${alreadyThere.length} originals with existing diario copies...`);
for (const m of alreadyThere) {
  const copyId = diarioByText.get(m.memory);
  if (!copyId) continue;
  try {
    const report = await deleteMemoriesWithPolicy({
      ids: [m.id],
      project: undefined,
      reason: 'migrated global -> diario (diary isolation, verbatim copy)',
      trigger: 'migration:global-to-diario',
      replacedById: copyId,
    });
    if (report.archived.includes(m.id)) archived++;
    else { console.error(`  archive FAILED for ${m.id.slice(0, 8)}:`, report.failed[0]?.error); archiveFailed++; }
  } catch (e) {
    console.error(`  archive ERROR for ${m.id.slice(0, 8)}:`, e instanceof Error ? e.message : e);
    archiveFailed++;
  }
  await sleep(300);
}

const duration = Date.now() - t0;
logMaintenance('diario_migration', { copied, archived, copyFailed, archiveFailed, keptTech: techKeep.length }, duration);
console.log(`DONE copied=${copied} archived=${archived} copyFailed=${copyFailed} archiveFailed=${archiveFailed} (${duration}ms)`);
