/**
 * Write path (mem0 split M6).
 *
 * addMemory (quality-gated save + graph outbox + heuristic state) and
 * addMemoryWithConflictCheck (search → classify → snapshot → save →
 * supersede). Depends on config, scoring, state, and read; the two
 * lifecycle helpers (snapshot/trash, M7) are a lazy import so the
 * dependency stays one-directional (lifecycle → write).
 */

import * as graphrag from '../graphrag.js';
import { incrementMetric } from '../mem-metrics.js';
import { classifyMemoryAction } from '../contradiction-detector.js';
import { isBlocklisted } from '../forget-blocklist.js';
import { MASTER_TENANT } from '../tenants.js';
import { getClient, userId, withRetry } from './config.js';
import {
  acceptEnrichedMemory,
  disqualifyMemory,
  MIN_MEMORY_QUALITY,
  scoreActionability,
  scoreMemoryQuality,
  shouldEnrichTechnicalMemory,
} from './scoring.js';
import {
  persistHeuristicState,
  shouldApplyHeuristicState,
} from './state.js';
import { invalidateMem0Cache, searchMemory } from './read.js';
import type {
  AddMemoryOpts,
  MemorySnapshot,
  TrashProvenance,
} from './types.js';

/** Lifecycle helpers (M7). Lazy so write.ts never statically imports back. */
async function lifecycleHelpers(): Promise<{
  snapshotMemories: (ids: string[], project?: string, limit?: number, tenant?: string) => Promise<MemorySnapshot[]>;
  trashAndDelete: (
    snapshot: MemorySnapshot,
    fromProject: string | undefined,
    provenance: TrashProvenance,
    tenant?: string,
  ) => Promise<{ trashId: string | null; deleted: boolean }>;
}> {
  return (await import('./lifecycle.js' as string)) as unknown as {
    snapshotMemories: (ids: string[], project?: string, limit?: number, tenant?: string) => Promise<MemorySnapshot[]>;
    trashAndDelete: (
      snapshot: MemorySnapshot,
      fromProject: string | undefined,
      provenance: TrashProvenance,
      tenant?: string,
    ) => Promise<{ trashId: string | null; deleted: boolean }>;
  };
}

export async function addMemory(text: string, project?: string, opts?: AddMemoryOpts, tenant: string = MASTER_TENANT): Promise<{ id: string; event_id?: string; memory: string; action?: string; superseded?: string[]; reason?: string; score?: number }[]> {
  // Forget-blocklist: a forgotten memory must not be re-extracted through
  // any save path (chat, index, bundle). First check — before Mem0 is touched.
  if (!opts?.skipBlocklistCheck && await isBlocklisted(text, tenant)) {
    console.log(`[mem0] Blocked re-save of forgotten memory: ${text.slice(0, 80)}...`);
    incrementMetric('memoriesBlocked');
    return [{ id: 'blocked', memory: text, action: 'NOOP', superseded: [], reason: 'forgotten memory (blocklist)', score: 0 }];
  }
  // Pre-save enrichment BEFORE quality gate, for API memories missing detail.
  // Gated by shouldEnrichTechnicalMemory: never for verbatim (inferFalse) or
  // non-API notes. Acceptance is value-based (acceptEnrichedMemory), NOT
  // length-based — see those helpers for the rationale.
  let enrichedText = text;
  if (shouldEnrichTechnicalMemory(text, opts)) {
    try {
      const { runFastLlm } = await import('../llm-client.js');
      const enriched = await withRetry(() => runFastLlm(
        `This technical memory describes an HTTP API but is missing actionable detail.
Fill in ONLY details that are unambiguously implied by the original.

HARD CONSTRAINTS:
- Do NOT invent URLs, headers, hosts, tokens, or curl commands.
- If the input is a simple technical note rather than an API spec, return it UNCHANGED with no additions.
- If a detail is not present or unambiguously implied by the original, omit it — never fabricate API structures.
- Preserve all original information verbatim.
Return ONLY the resulting text, no explanation.

Original: ${text}`
      ));
      if (acceptEnrichedMemory(text, enriched)) {
        enrichedText = enriched;
        console.log(`[mem0] Enriched API memory (actionability: ${scoreActionability(text)} → ${scoreActionability(enriched)})`);
      } else if (enriched) {
        // Visible so a future enrichment regression is not silent.
        console.log(`[mem0] Rejected enrichment (no actionable gain or introduced a fabricated URL); keeping original verbatim`);
      }
    } catch (err) {
      // Fire-and-forget: if enrichment fails, continue with original
      console.log(`[mem0] Enrichment failed, using original:`, err instanceof Error ? err.message : err);
    }
  }

  // Quality gate: reject low-quality saves before hitting Mem0 API (scored on enriched text).
  // Chat atoms already passed extraction; only credentials/boilerplate still block them.
  if (!opts?.skipQualityCheck) {
    const hard = disqualifyMemory(enrichedText);
    if (hard) {
      console.log(`[mem0] Rejected disqualified memory: ${enrichedText.slice(0, 80)}...`);
      incrementMetric('memoriesRejected');
      return [{ id: 'rejected', memory: text, action: 'NOOP', superseded: [], reason: hard, score: 0 }];
    }
    if (!opts?.chatAtom) {
      const quality = scoreMemoryQuality(enrichedText);
      if (quality < MIN_MEMORY_QUALITY) {
        console.log(`[mem0] Rejected low-quality memory (score=${quality}): ${enrichedText.slice(0, 80)}...`);
        incrementMetric('memoriesRejected');
        return [{ id: 'rejected', memory: text, action: 'NOOP', superseded: [], reason: 'actionability score below threshold', score: quality }];
      }
    }
  }

  const m = getClient();
  const result = await m.add(
    [{ role: 'user', content: enrichedText }],
    { userId: userId(project, tenant), ...(opts?.inferFalse ? { infer: false } : {}), ...(opts?.metadata ? { metadata: opts.metadata } : {}) }
  );

  incrementMetric('memoriesAdded');
  const items = result.results ?? [];
  const mapped = items.map((item: any) => ({
    id: item.id ?? 'unknown',
    memory: item.memory ?? text,
  }));

  // Derived projection (Fase 3): Mem0 is source of truth; the graph ingest
  // is queued durably (outbox + background drain). Never fails the save.
  // Skipped for trash copies (maintenance must not pollute the graph).
  if (!opts?.skipGraphIngest) {
    graphrag.queueGraphIngest(
      enrichedText,
      project,
      mapped.map(m => m.id).filter(id => id && id !== 'unknown'),
      tenant
    );
  }
  invalidateMem0Cache(project).catch(() => {});

  // Fire-and-forget: score and store importance for each saved memory.
  // Chat atoms skip this entirely (shouldApplyHeuristicState): the extractor
  // owns their importance/kind — the regex heuristics must not overwrite them.
  for (const item of mapped) {
    if (item.id && item.id !== 'unknown' && shouldApplyHeuristicState(opts)) {
      persistHeuristicState(enrichedText, item.id).catch((err) => console.error(`[mem0] post-save state write failed for ${item.id}:`, err instanceof Error ? err.message : String(err)));
    }
  }

  return mapped;
}

// Common PT-BR function words and accented characters used to detect Portuguese text.
const PT_BR_MARKERS = /\b(?:não|uma|para|com|que|por|isso|está|foi|são|tem|seu|sua|dos|das|pelo|pela|quando|onde|também|então|porque|você|gente)\b/i;

/**
 * Heuristic: detect if text is likely Portuguese (pt-BR).
 * Returns 'pt-BR' if confident, undefined if ambiguous.
 * No external dependency — pure regex on common PT-BR function words.
 */
function detectLanguageHint(text: string): string | undefined {
  if (!text) return undefined;
  const matches = (text.match(PT_BR_MARKERS) || []).length;
  // Require at least 2 hits to avoid false positives on short/technical texts
  return matches >= 2 ? 'pt-BR' : undefined;
}

/**
 * Add memory with conflict detection.
 * Searches for similar existing memories, classifies the relationship, and handles:
 * - ADD: save normally
 * - UPDATE/DELETE: supersede old memories, then save
 * - NOOP: skip (duplicate)
 */
export async function addMemoryWithConflictCheck(
  text: string,
  project?: string,
  opts?: AddMemoryOpts,
  tenant: string = MASTER_TENANT
): Promise<{ id: string; event_id?: string; memory: string; action?: string; superseded?: string[]; conflictsWith?: { id: string; snippet: string; score: number }[]; reason?: string; score?: number }[]> {
  if (opts?.skipConflictCheck) {
    return addMemory(text, project, opts, tenant);
  }

  // Search for similar existing memories
  let similarMemories: { id: string; memory: string; score: number }[] = [];
  try {
    const results = await searchMemory(text, project, 5, tenant);
    similarMemories = results
      .filter(r => (r.score ?? 0) > 0.5)
      .map(r => ({ id: r.id, memory: r.memory, score: r.score ?? 0 }));
  } catch (err) {
    console.log('[mem0] Conflict check search failed, proceeding with ADD:', err);
  }

  // Classify the action — pass language hint to improve bilingual conflict detection
  const langHint = detectLanguageHint(
    text + (similarMemories[0]?.memory ?? '')
  );
  const classification = await classifyMemoryAction(text, similarMemories, langHint, opts?.bundleMode);
  console.log(`[mem0] Conflict check: ${classification.action} — ${classification.reason}`);

  // Log to maintenance
  try {
    const { logMaintenance } = await import('../maintenance-log.js');
    logMaintenance('conflict_check', {
      action: classification.action,
      reason: classification.reason,
      supersedes: classification.supersedes,
      newMemory: text.slice(0, 100),
      project,
    });
  } catch { /* non-critical */ }

  if (classification.action === 'NOOP') {
    if (process.env.LAIN_BENCH === '1') {
      console.log(JSON.stringify({
        tag: '[bench]', ts: Date.now(), file: 'mem0',
        func: 'addMemoryWithConflictCheck', dedup_decision: classification.action,
      }));
    }
    console.log(`[mem0] Skipping duplicate memory: ${text.slice(0, 80)}...`);
    return [{
      id: 'duplicate',
      memory: text,
      action: 'NOOP',
      superseded: [],
      conflictsWith: similarMemories.map(m => ({
        id: m.id,
        snippet: (m.memory || '').slice(0, 120),
        score: m.score,
      })),
    }];
  }

  if (process.env.LAIN_BENCH === '1') {
    console.log(JSON.stringify({
      tag: '[bench]', ts: Date.now(), file: 'mem0',
      func: 'addMemoryWithConflictCheck', dedup_decision: classification.action,
    }));
  }
  // Snapshot doomed memories BEFORE saving — audit trail needs full texts.
  const { snapshotMemories, trashAndDelete } = await lifecycleHelpers();
  const doomed = classification.supersedes.length > 0
    ? await snapshotMemories(classification.supersedes, project, 100, tenant)
    : [];

  // Save the new memory first — only supersede old ones if save succeeded
  const result = await addMemory(text, project, opts, tenant);

  if (doomed.length > 0 && result[0] && result[0].id !== 'rejected') {
    const newId = result[0].id;
    const trashIds: Record<string, string | null> = {};
    for (const snap of doomed) {
      try {
        const { trashId, deleted } = await trashAndDelete(snap, project, {
          reason: classification.reason,
          trigger: `conflict_check:${classification.action}`,
          replacedById: newId,
        }, tenant);
        trashIds[snap.id] = trashId;
        if (deleted) {
          console.log(`[mem0] Superseded memory ${snap.id} (trash: ${trashId})`);
        } else {
          // Fail-closed: trash copy unconfirmed → original preserved, retry later.
          console.error(`[mem0] Supersede deferred for ${snap.id}: trash copy unconfirmed, original preserved`);
        }
      } catch (err) {
        console.error(`[mem0] Failed to supersede ${snap.id}:`, err);
      }
    }
    try {
      const { logMaintenance } = await import('../maintenance-log.js');
      logMaintenance('memory_supersede', {
        project: project ?? 'global',
        classification: classification.action,
        reason: classification.reason,
        deleted: doomed.map(s => ({ id: s.id, memory: s.memory, created_at: s.created_at ?? null, missing: s.missing ?? false, trash_id: trashIds[s.id] ?? null })),
        replaced_by: { id: newId, memory: result[0].memory },
      });
    } catch { /* non-critical */ }
  }

  return result.map(r => ({
    ...r,
    action: classification.action,
    superseded: classification.supersedes,
  }));
}
