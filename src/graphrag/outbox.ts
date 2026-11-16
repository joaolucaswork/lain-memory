/**
 * Outbox for graphrag (graphrag split G8).
 *
 * Durable write path: queueGraphIngest appends an intent (fast local
 * append, no LLM wait) and triggers a background drain. Crash mid-drain
 * is recovered via claimed-file pickup on the next drain. reconcile.ts
 * reads the last sync error for status reporting.
 */

import path from 'path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { KNOWLEDGE_DIR } from '../workspace.js';
import { withDistributedLock } from '../distributed-lock.js';
import { incrementMetric } from '../mem-metrics.js';
import { ENABLED, getGraph } from './store.js';
import { ingest, ingestExtracted } from './ingest.js';
import type { GraphOutboxEntry } from './types.js';

// ─── Sync: outbox + reconciliation (Fase 3) ───
//
// Architectural decision: Mem0/Qdrant is the SOURCE OF TRUTH for content.
// The graph is a DERIVED projection (rich structural cache). Any divergence
// is recoverable by re-ingestion from Mem0; the graph never overrides vector
// content. Provenance (`sources`) links each node/edge to the Mem0 IDs that
// produced it; legacy entries (sources undefined) are never pruned.
//
// Write path: `queueGraphIngest()` appends a durable intent to the outbox
// (fast local append, no LLM wait) and triggers a background drain. A crash
// between Mem0 save and outbox append (~ms window) is the only uncovered
// case; crash mid-drain is recovered via `.processing` files on next drain.

const OUTBOX_MAX_ATTEMPTS = 5;

export function outboxDir(): string {
  return process.env.LAIN_GRAPH_OUTBOX_DIR ?? KNOWLEDGE_DIR;
}

export function outboxPath(): string {
  return path.join(outboxDir(), 'graph-outbox.jsonl');
}

function quarantinePath(): string {
  return path.join(outboxDir(), 'graph-outbox.quarantine.jsonl');
}

export function readOutboxFile(file: string): { entries: GraphOutboxEntry[]; corrupt: { lineNo: number; raw: string }[] } {
  try {
    const raw = readFileSync(file, 'utf8');
    const entries: GraphOutboxEntry[] = [];
    const corrupt: { lineNo: number; raw: string }[] = [];
    let lineNo = 0;
    for (const line of raw.split('\n')) {
      lineNo++;
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(JSON.parse(t) as GraphOutboxEntry);
      } catch {
        // Never silently drop: corrupt lines go to quarantine below.
        corrupt.push({ lineNo, raw: t.slice(0, 2000) });
      }
    }
    return { entries, corrupt };
  } catch {
    return { entries: [], corrupt: [] };
  }
}

/**
 * Preserve unparseable outbox lines for investigation before the claimed
 * file is removed. Best-effort: a quarantine failure is logged, never fatal.
 * Returns the number of lines quarantined.
 */
function quarantineOutboxLines(sourceFile: string, corrupt: { lineNo: number; raw: string }[]): number {
  if (corrupt.length === 0) return 0;
  let quarantined = 0;
  for (const c of corrupt) {
    try {
      if (!existsSync(outboxDir())) mkdirSync(outboxDir(), { recursive: true });
      appendFileSync(quarantinePath(), JSON.stringify({
        ts: Date.now(),
        reason: 'unparseable outbox line',
        file: path.basename(sourceFile),
        lineNo: c.lineNo,
        raw: c.raw,
      }) + '\n', 'utf8');
      quarantined++;
    } catch (err) {
      console.error('[graphrag] Failed to quarantine corrupt outbox line:', err instanceof Error ? err.message : err);
    }
  }
  if (quarantined > 0) {
    console.error(`[graphrag] Quarantined ${quarantined} corrupt outbox line(s) from ${path.basename(sourceFile)} — see ${path.basename(quarantinePath())}`);
  }
  return quarantined;
}

export function appendGraphOutbox(entry: Omit<GraphOutboxEntry, 'id' | 'ts' | 'attempts'> & { attempts?: number }): GraphOutboxEntry {
  if (!existsSync(outboxDir())) mkdirSync(outboxDir(), { recursive: true });
  const full: GraphOutboxEntry = {
    id: randomUUID(),
    ts: Date.now(),
    attempts: entry.attempts ?? 0,
    ...(entry.project ? { project: entry.project } : {}),
    ...(entry.sourceIds ? { sourceIds: entry.sourceIds } : {}),
    ...(entry.text ? { text: entry.text } : {}),
    ...(entry.entities ? { entities: entry.entities } : {}),
    ...(entry.relationships ? { relationships: entry.relationships } : {}),
  };
  appendFileSync(outboxPath(), JSON.stringify(full) + '\n', 'utf8');
  return full;
}

let drainInFlight: Promise<void> | null = null;
let lastSyncError: string | null = null;

/** Last outbox/drain error, for status reporting (owned here, read by reconcile). */
export function getLastSyncError(): string | null {
  return lastSyncError;
}

/** Set by reconcile paths that own their own catch (moves with them in G10). */
export function setLastSyncError(v: string | null): void {
  lastSyncError = v;
}

async function applyOutboxEntry(
  entry: GraphOutboxEntry,
  exec?: (entry: GraphOutboxEntry) => Promise<void>
): Promise<void> {
  if (exec) {
    await exec(entry);
    return;
  }
  if (entry.text !== undefined) {
    await ingest(entry.text, entry.project, { sourceIds: entry.sourceIds });
    return;
  }
  await ingestExtracted(entry.entities ?? [], entry.relationships ?? [], entry.project, { sourceIds: entry.sourceIds });
}

/**
 * Drain the outbox: claim pending + orphaned processing files (atomic rename
 * = cross-process mutex), apply entries, re-queue failures with attempts+1,
 * dead-letter after OUTBOX_MAX_ATTEMPTS. Accepts an injected executor for
 * tests (defaults to the real ingest paths).
 */
export async function drainGraphOutbox(
  exec?: (entry: GraphOutboxEntry) => Promise<void>
): Promise<{ processed: number; failed: number; deadLettered: number; pending: number; quarantined: number }> {
  if (!getGraph() && !exec) return { processed: 0, failed: 0, deadLettered: 0, pending: 0, quarantined: 0 };
  const dir = outboxDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Claim: rename pending file + any orphaned processing files (crash recovery).
  const claimed: string[] = [];
  const claim = (file: string) => {
    const dest = path.join(dir, `.graph-outbox.claimed-${process.pid}-${Date.now()}-${claimed.length}`);
    try {
      renameSync(file, dest);
      claimed.push(dest);
    } catch { /* lost the race or already gone — fine */ }
  };
  claim(outboxPath());
  let processing: string[] = [];
  try {
    processing = readdirSync(dir).filter(f => f.startsWith('.graph-outbox.processing-') || f.startsWith('.graph-outbox.claimed-'));
  } catch { processing = []; }
  for (const f of processing) claim(path.join(dir, f));

  let entries: GraphOutboxEntry[] = [];
  let quarantined = 0;
  for (const f of claimed) {
    const read = readOutboxFile(f);
    entries.push(...read.entries);
    quarantined += quarantineOutboxLines(f, read.corrupt);
    try { unlinkSync(f); } catch { /* already gone */ }
  }
  if (entries.length === 0) return { processed: 0, failed: 0, deadLettered: 0, pending: 0, quarantined };

  let processed = 0;
  let failed = 0;
  let deadLettered = 0;
  const survivors: GraphOutboxEntry[] = [];
  for (const entry of entries) {
    try {
      await applyOutboxEntry(entry, exec);
      processed++;
      incrementMetric('graphOutboxProcessed');
    } catch (err) {
      failed++;
      const attempts = (entry.attempts ?? 0) + 1;
      lastSyncError = err instanceof Error ? err.message : String(err);
      console.error(`[graphrag] Outbox entry ${entry.id} failed (attempt ${attempts}):`, lastSyncError);
      if (attempts >= OUTBOX_MAX_ATTEMPTS) {
        deadLettered++;
        incrementMetric('graphIngestErrors');
        try {
          const { logMaintenance } = await import('../maintenance-log.js');
          logMaintenance('graph_outbox_dead_letter', { entryId: entry.id, attempts, project: entry.project ?? null, error: lastSyncError });
        } catch { /* non-critical */ }
      } else {
        survivors.push({ ...entry, attempts });
      }
    }
  }
  for (const entry of survivors) {
    try {
      appendFileSync(outboxPath(), JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      console.error('[graphrag] Failed to re-queue outbox entry:', err instanceof Error ? err.message : err);
    }
  }
  return { processed, failed, deadLettered, pending: survivors.length, quarantined };
}

function triggerOutboxDrain(): void {
  if (drainInFlight) return;
  drainInFlight = withDistributedLock('graphrag:outbox-drain', 120_000, async () => {
    await drainGraphOutbox();
  }).catch(err => {
    lastSyncError = err instanceof Error ? err.message : String(err);
    console.error('[graphrag] Outbox drain error:', lastSyncError);
  }).finally(() => {
    drainInFlight = null;
  });
}

/**
 * Durable graph ingestion for the Mem0 write path (Fase 3).
 * Appends intent to the outbox (fast, no LLM wait) and triggers a
 * background drain. Never throws — write-path latency is unchanged and a
 * graph failure never fails the memory save (Mem0 is source of truth).
 */
export function queueGraphIngest(text: string, project?: string, sourceIds?: string[]): void {
  if (!ENABLED || !getGraph()) return;
  try {
    appendGraphOutbox({ text, project, sourceIds });
  } catch (err) {
    lastSyncError = err instanceof Error ? err.message : String(err);
    incrementMetric('graphIngestErrors');
    console.error('[graphrag] Outbox append failed:', lastSyncError);
    return;
  }
  triggerOutboxDrain();
}

/** Durable variant for pre-extracted payloads (seeds, HTTP ingest). */
export function queueGraphIngestExtracted(
  entities: Array<{ name: string; type: string; description: string }>,
  relationships: Array<{ subject: string; predicate: string; object: string }>,
  project?: string,
  sourceIds?: string[]
): void {
  if (!ENABLED || !getGraph()) return;
  try {
    appendGraphOutbox({ entities, relationships, project, sourceIds });
  } catch (err) {
    lastSyncError = err instanceof Error ? err.message : String(err);
    incrementMetric('graphIngestErrors');
    console.error('[graphrag] Outbox append failed:', lastSyncError);
    return;
  }
  triggerOutboxDrain();
}
