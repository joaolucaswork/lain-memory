/**
 * Memory reaper — weekly cold-purge job for Lain memory system.
 *
 * Deletes stale project-scoped memories that meet ALL criteria:
 *   - updated_at older than 90 days
 *   - importance score < 0.3 (if scored)
 *   - userId is 'lucas:PROJECT' (never purges global 'lucas' memories)
 *
 * Env vars (read at call time — changes take effect on the next run):
 *   LAIN_MEMORY_REAPER_ENABLED  'false'|'0'|'no' disables entirely (default: enabled)
 *   LAIN_MEMORY_REAPER_DRY_RUN  'true'|'1' logs without deleting (default: false)
 */

import { randomUUID } from 'crypto';
import { getMemories, deleteMemory, getMemoryImportance } from './mem0.js';
import { incrementMetric } from './mem-metrics.js';
import { listProjects } from './workspace.js';
import { emitReaperEvent } from './memory-reaper-audit.js';

const REAPER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COLD_THRESHOLD_DAYS = 90;
const IMPORTANCE_THRESHOLD = 0.3;
const DISABLED_VALUES = new Set(['false', '0', 'no']);

const FETCH_LIMIT_DEFAULT = 200;
export function getReaperFetchLimit(): number {
  const raw = process.env.LAIN_MEMORY_REAPER_FETCH_LIMIT;
  if (!raw) return FETCH_LIMIT_DEFAULT;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return FETCH_LIMIT_DEFAULT;
  return n;
}

let reaperTimer: ReturnType<typeof setInterval> | undefined;
let reaperInitTimer: ReturnType<typeof setTimeout> | undefined;

export function isReaperEnabled(): boolean {
  return !DISABLED_VALUES.has(process.env.LAIN_MEMORY_REAPER_ENABLED ?? '');
}

export function isReaperDryRun(): boolean {
  const v = process.env.LAIN_MEMORY_REAPER_DRY_RUN;
  return v === 'true' || v === '1';
}

export async function runMemoryReaper(): Promise<{ purged: number; dryPurged?: number }> {
  const dryRun = isReaperDryRun();
  const runId = randomUUID();
  const startTime = Date.now();
  console.log(`[reaper] Starting cold memory purge...${dryRun ? ' (DRY RUN)' : ''}`);

  let projectNames: string[];
  try {
    projectNames = listProjects().map(p => p.name);
  } catch {
    projectNames = [];
  }

  const cutoff = Date.now() - COLD_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  void emitReaperEvent({
    schema_version: 1,
    run_id: runId,
    ts: new Date().toISOString(),
    event_type: 'start',
    project_count: projectNames.length,
    cold_threshold_days: COLD_THRESHOLD_DAYS,
    importance_threshold: IMPORTANCE_THRESHOLD,
    dry_run: dryRun,
  });

  let purged = 0;
  let dryPurged = 0;

  const fetchLimit = getReaperFetchLimit();

  for (const project of projectNames) {
    let memories: Awaited<ReturnType<typeof getMemories>>;
    try {
      memories = await getMemories(project, fetchLimit);
    } catch (err) {
      console.error(`[reaper] Failed to fetch memories for project ${project}:`, err);
      void emitReaperEvent({
        schema_version: 1,
        run_id: runId,
        ts: new Date().toISOString(),
        event_type: 'error_fetch',
        project,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      continue;
    }

    if (memories.length === fetchLimit) {
      console.warn(`[reaper] WARN: project ${project} returned exactly ${fetchLimit} memories — fetch may be truncated`);
      void emitReaperEvent({
        schema_version: 1,
        run_id: runId,
        ts: new Date().toISOString(),
        event_type: 'fetch_truncated',
        project,
        fetch_limit: fetchLimit,
        returned_count: memories.length,
        hint: 'Reaper may be missing older memories beyond the fetch limit. Set LAIN_MEMORY_REAPER_FETCH_LIMIT=N (N > current limit) to widen.',
      });
    }

    for (const mem of memories) {
      const ageTs = mem.updated_at
        ? new Date(mem.updated_at).getTime()
        : mem.created_at
          ? new Date(mem.created_at).getTime()
          : null;

      if (ageTs === null || isNaN(ageTs) || ageTs > cutoff) {
        void emitReaperEvent({
          schema_version: 1,
          run_id: runId,
          ts: new Date().toISOString(),
          event_type: 'skip_age',
          memory_id: mem.id,
          project,
          age_days: ageTs === null ? -1 : Math.floor((Date.now() - ageTs) / 86400000),
        });
        continue;
      }

      // .catch(() => null) intentionally conflates "unscored" and "fetch threw" —
      // both cases result in skipping the memory. See spec for rationale.
      const importance = await getMemoryImportance(mem.id).then(v => v ?? null).catch(() => null);

      if (importance === null) {
        void emitReaperEvent({
          schema_version: 1,
          run_id: runId,
          ts: new Date().toISOString(),
          event_type: 'skip_no_importance',
          memory_id: mem.id,
          project,
          age_days: Math.floor((Date.now() - ageTs) / 86400000),
        });
        continue;
      }

      if (importance >= IMPORTANCE_THRESHOLD) {
        void emitReaperEvent({
          schema_version: 1,
          run_id: runId,
          ts: new Date().toISOString(),
          event_type: 'skip_importance',
          memory_id: mem.id,
          project,
          importance,
          age_days: Math.floor((Date.now() - ageTs) / 86400000),
        });
        continue;
      }

      if (dryRun) {
        dryPurged++;
        incrementMetric('coldDryPurged');
        console.log(
          `[reaper] [DRY] would purge cold memory ${mem.id.slice(0, 8)} ` +
          `(importance=${importance.toFixed(2)}, project=${project})`,
        );
        void emitReaperEvent({
          schema_version: 1,
          run_id: runId,
          ts: new Date().toISOString(),
          event_type: 'dry_purge',
          memory_id: mem.id,
          project,
          importance,
          age_days: Math.floor((Date.now() - ageTs) / 86400000),
        });
        continue;
      }

      // purge event = intent to delete; check error_delete for failure
      void emitReaperEvent({
        schema_version: 1,
        run_id: runId,
        ts: new Date().toISOString(),
        event_type: 'purge',
        memory_id: mem.id,
        project,
        importance,
        age_days: Math.floor((Date.now() - ageTs) / 86400000),
      });

      try {
        await deleteMemory(mem.id);
        purged++;
        incrementMetric('coldPurged');
        console.log(
          `[reaper] Purged cold memory ${mem.id.slice(0, 8)} ` +
          `(importance=${importance.toFixed(2)}, project=${project})`,
        );
      } catch (err) {
        console.error(`[reaper] Failed to delete ${mem.id}:`, err);
        void emitReaperEvent({
          schema_version: 1,
          run_id: runId,
          ts: new Date().toISOString(),
          event_type: 'error_delete',
          memory_id: mem.id,
          project,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }
  }

  const durationMs = Date.now() - startTime;

  void emitReaperEvent({
    schema_version: 1,
    run_id: runId,
    ts: new Date().toISOString(),
    event_type: 'complete',
    purged: dryRun ? 0 : purged,
    dry_purged: dryRun ? dryPurged : 0,
    dry_run: dryRun,
    duration_ms: durationMs,
  });

  console.log(
    `[reaper] Purge complete: ${dryRun ? dryPurged : purged} memories ` +
    `${dryRun ? 'would be ' : ''}removed (${durationMs}ms)`,
  );
  return dryRun ? { purged: 0, dryPurged } : { purged };
}

export function startMemoryReaper(): void {
  if (!isReaperEnabled()) {
    console.log('[reaper] disabled (LAIN_MEMORY_REAPER_ENABLED) — no intervals registered');
    return;
  }
  if (isReaperDryRun()) {
    console.log('[reaper] dry-run mode active — deletions will be simulated, not executed');
  }
  // First pass after 10 minutes, then weekly
  reaperInitTimer = setTimeout(() => runMemoryReaper().catch(err => console.error('[reaper] error:', err)), 10 * 60 * 1000);
  reaperTimer = setInterval(
    () => runMemoryReaper().catch(err => console.error('[reaper] error:', err)),
    REAPER_INTERVAL_MS,
  );
}

export function stopMemoryReaper(): void {
  if (reaperInitTimer) {
    clearTimeout(reaperInitTimer);
    reaperInitTimer = undefined;
  }
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = undefined;
  }
}
