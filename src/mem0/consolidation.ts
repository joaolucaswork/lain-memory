/**
 * Consolidation (mem0 split M8).
 *
 * Group related fragments, LLM-merge, verbatim re-save, trash the
 * fragments (fail-closed). Pending-review queue pairs first (gated),
 * lexical grouping second.
 */

import { withRetry } from './config.js';
import { MIN_MEMORY_QUALITY, scoreMemoryQuality } from './scoring.js';
import { getMemories } from './read.js';
import { addMemory } from './write.js';
import { snapshotMemories, trashAndDelete } from './lifecycle.js';
import type { ConsolidationDetail } from './types.js';

// ─── Memory Consolidation (Patch 2) ───

/**
 * Group memories by topic prefix or semantic similarity.
 * Returns groups of 2+ related memories that can be consolidated.
 */
function groupMemories(memories: { id: string; memory: string }[]): Map<string, { id: string; memory: string }[]> {
  const groups = new Map<string, { id: string; memory: string }[]>();

  // First pass: group by [Seed: <title>] prefix
  const ungrouped: { id: string; memory: string }[] = [];
  for (const mem of memories) {
    const seedMatch = mem.memory.match(/^\[Seed:\s*(.+?)\]/);
    if (seedMatch) {
      const key = `seed:${seedMatch[1].toLowerCase().trim()}`;
      const group = groups.get(key) || [];
      group.push(mem);
      groups.set(key, group);
    } else {
      ungrouped.push(mem);
    }
  }

  // Second pass: group ungrouped by keyword overlap
  const used = new Set<string>();
  for (let i = 0; i < ungrouped.length; i++) {
    if (used.has(ungrouped[i].id)) continue;
    const wordsA = new Set(ungrouped[i].memory.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    const similar: { id: string; memory: string }[] = [ungrouped[i]];

    for (let j = i + 1; j < ungrouped.length; j++) {
      if (used.has(ungrouped[j].id)) continue;
      const wordsB = new Set(ungrouped[j].memory.toLowerCase().split(/\s+/).filter(w => w.length > 4));
      let overlap = 0;
      for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
      const similarity = (2 * overlap) / (wordsA.size + wordsB.size);
      if (similarity >= 0.3) {
        similar.push(ungrouped[j]);
        used.add(ungrouped[j].id);
      }
    }

    if (similar.length >= 2) {
      used.add(ungrouped[i].id);
      groups.set(`topic:${i}`, similar);
    }
  }

  // Only return groups with 2+ memories
  for (const [key, group] of groups) {
    if (group.length < 2) groups.delete(key);
  }

  return groups;
}

/**
 * LLM-merge a set of fragment texts into one memory.
 * Same prompt + retry as the group path in consolidateMemories.
 * Returns null when the LLM returns nothing usable.
 */
async function llmMergeMemoryTexts(texts: string[]): Promise<string | null> {
  const { runFastLlmJson } = await import('../llm-client.js');
  const fragments = texts.join('\n- ');
  const result = await withRetry(() => runFastLlmJson<{ consolidated: string }>(
    `Consolide essas memórias fragmentadas em UMA ÚNICA memória completa e rica.
Mantenha TODOS os fatos importantes, nomes, valores, datas e decisões.
Retorne APENAS JSON: {"consolidated": "texto consolidado aqui"}

Memórias:
- ${fragments}`
  ));
  if (result?.consolidated && result.consolidated.length > 20) return result.consolidated;
  return null;
}

/**
 * Item 2 gate: pending-queue merges only run when explicitly enabled.
 * Sweep queues (item 1) and contradiction visibility (item 3) work regardless —
 * this way the queue can be observed before auto-merge is switched on.
 */
export function isPendingMergeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.LAIN_PENDING_MERGE_ENABLED ?? '').toLowerCase();
  return v === 'true' || v === '1';
}

/**
 * Consume the pending-review merge queue (UPDATE verdicts from the
 * contradiction sweep) before lexical grouping. Exact LLM-detected pairs —
 * no keyword guessing. Same trash + audit safety as the group path.
 */
async function consolidatePendingMerges(project?: string): Promise<{
  consolidated: number;
  deleted: number;
  details: ConsolidationDetail[];
}> {
  const { claimPendingMerges, updateEntry, maxAttemptsReached } = await import('../pending-review.js');
  const { logMaintenance } = await import('../maintenance-log.js');
  const claimed = await claimPendingMerges(project, 5);
  let consolidated = 0;
  let deleted = 0;
  const details: ConsolidationDetail[] = [];

  for (const entry of claimed) {
    try {
      const texts = [entry.memory, ...entry.related.map(r => r.memory)].filter(t => t && t.trim());
      if (texts.length < 2) {
        await updateEntry(entry.id, { status: 'failed', result: { error: 'fragments gone' } });
        continue;
      }
      const merged = await llmMergeMemoryTexts(texts);
      if (!merged || scoreMemoryQuality(merged) < MIN_MEMORY_QUALITY) {
        const terminal = maxAttemptsReached(entry);
        await updateEntry(entry.id, {
          status: terminal ? 'failed' : 'pending',
          result: { error: 'merge rejected by quality gate or empty' },
        });
        console.log(`[mem0] Pending merge ${entry.id.slice(0, 8)} rejected by quality gate${terminal ? ' (terminal)' : ', will retry'}`);
        continue;
      }
      const ids = [entry.memoryId, ...entry.related.map(r => r.id)].filter(id => id && id !== 'pending');
      const doomed = await snapshotMemories(ids, project);
      const existing = doomed.filter(s => !s.missing && s.memory);
      if (existing.length < 2) {
        await updateEntry(entry.id, { status: 'failed', result: { error: 'fragments gone' } });
        continue;
      }
      // Verbatim save (inferFalse): the merged text is already final. With
      // inference on, Mem0 can decompose it into an UPDATE against the still-
      // present fragments and return no id ("unknown") — then the fragments
      // below would be deleted with nothing saved (net loss). Same rationale
      // as the trash path (byte-identical archive).
      const saved = await addMemory(merged, project, { skipQualityCheck: true, skipConflictCheck: true, inferFalse: true });
      const newId = saved[0]?.id;
      if (!newId || newId === 'unknown' || newId === 'rejected') {
        console.error(`[mem0] Pending merge ${entry.id.slice(0, 8)} save unconfirmed — fragments preserved`);
        await updateEntry(entry.id, {
          status: maxAttemptsReached(entry) ? 'failed' : 'pending',
          result: { error: 'consolidated save unconfirmed, fragments preserved' },
        });
        continue;
      }
      consolidated++;

      const trashIds: Record<string, string | null> = {};
      for (const snap of doomed) {
        try {
          const { trashId, deleted: fragDeleted } = await trashAndDelete(snap, project, {
            reason: 'merged from pending review queue',
            trigger: 'consolidation:pending_queue',
            replacedById: newId,
          });
          trashIds[snap.id] = trashId;
          if (fragDeleted) {
            deleted++;
          } else {
            console.error(`[mem0] Pending merge deferred fragment ${snap.id}: trash copy unconfirmed, original preserved`);
          }
        } catch {}
      }

      await updateEntry(entry.id, { status: 'done', result: { mergedId: newId } });
      logMaintenance('pending_merge_done', {
        entry_id: entry.id,
        scope: project ?? 'global',
        new_id: newId,
        fragments: existing.length,
      });
      details.push({
        fragments: texts.map(f => f.slice(0, 120)),
        result: merged.slice(0, 200),
        fragmentsFull: doomed.map(s => ({ id: s.id, memory: s.memory, created_at: s.created_at ?? null, missing: s.missing ?? false, trash_id: trashIds[s.id] ?? null })),
        resultFull: merged,
        newId,
      });
    } catch (err) {
      try {
        await updateEntry(entry.id, {
          status: maxAttemptsReached(entry) ? 'failed' : 'pending',
          result: { error: err instanceof Error ? err.message : String(err) },
        });
      } catch {}
      console.error(`[mem0] Pending merge ${entry.id.slice(0, 8)} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return { consolidated, deleted, details };
}

/**
 * Consolidate fragmented memories for a project scope.
 * Groups related memories, merges them via the fast LLM, replaces fragments.
 * Returns { consolidated, deleted, groups }.
 */
export async function consolidateMemories(project?: string): Promise<{
  consolidated: number;
  deleted: number;
  groups: number;
  details: ConsolidationDetail[];
}> {
  let consolidated = 0;
  let deleted = 0;
  const details: ConsolidationDetail[] = [];

  // Item 1: exact LLM-detected UPDATE pairs first — no lexical guessing.
  // Gated by LAIN_PENDING_MERGE_ENABLED (item 2): when off, the queue only
  // accumulates for observation via /api/memory/contradictions.
  if (isPendingMergeEnabled()) {
    try {
      const queued = await consolidatePendingMerges(project);
      consolidated += queued.consolidated;
      deleted += queued.deleted;
      details.push(...queued.details);
    } catch (err) {
      console.error('[mem0] Pending-queue consolidation failed:', err instanceof Error ? err.message : err);
    }
  }

  const allMems = await getMemories(project, 100);
  if (allMems.length < 4) return { consolidated, deleted, groups: 0, details };

  const groups = groupMemories(allMems);
  if (groups.size === 0) return { consolidated, deleted, groups: 0, details };

  for (const [_key, group] of groups) {
    const fragmentTexts = group.map(m => m.memory);
    const fragments = fragmentTexts.join('\n- ');

    try {
      const { runFastLlmJson } = await import('../llm-client.js');
      const result = await withRetry(() => runFastLlmJson<{ consolidated: string }>(
        `Consolide essas memórias fragmentadas em UMA ÚNICA memória completa e rica.
Mantenha TODOS os fatos importantes, nomes, valores, datas e decisões.
Retorne APENAS JSON: {"consolidated": "texto consolidado aqui"}

Memórias:
- ${fragments}`
      ));

      if (result.consolidated && result.consolidated.length > 20) {
        // Quality gate: skip low-quality consolidation results (item #6)
        if (scoreMemoryQuality(result.consolidated) < MIN_MEMORY_QUALITY) {
          console.log(`[mem0] Consolidation rejected low-quality result: ${result.consolidated.slice(0, 60)}...`);
          continue;
        }
        // Snapshot fragments BEFORE replacing — full texts for the audit trail.
        const doomed = await snapshotMemories(group.map(m => m.id).filter(id => id && id !== 'pending'), project);
        // Verbatim save (inferFalse): the consolidated text is already final.
        // With inference on, Mem0 can decompose it into an UPDATE against the
        // still-present fragments and return no id ("unknown") — then the
        // fragments below would be deleted with nothing saved (net loss).
        const saved = await addMemory(result.consolidated, project, { skipQualityCheck: true, skipConflictCheck: true, inferFalse: true });
        const newId = saved[0]?.id;
        if (!newId || newId === 'unknown' || newId === 'rejected') {
          console.error(`[mem0] Consolidation save unconfirmed — fragments preserved`);
          continue;
        }
        consolidated++;

        const trashIds: Record<string, string | null> = {};
        // Delete fragments (via trash — fail-closed: unconfirmed copies are preserved, not counted)
        for (const snap of doomed) {
          try {
            const { trashId, deleted: fragDeleted } = await trashAndDelete(snap, project, {
              reason: 'merged into consolidated memory',
              trigger: 'consolidation',
              replacedById: newId,
            });
            trashIds[snap.id] = trashId;
            if (fragDeleted) {
              deleted++;
            } else {
              console.error(`[mem0] Consolidation deferred fragment ${snap.id}: trash copy unconfirmed, original preserved`);
            }
          } catch {}
        }

        details.push({
          fragments: fragmentTexts.map(f => f.slice(0, 120)),
          result: result.consolidated.slice(0, 200),
          fragmentsFull: doomed.map(s => ({ id: s.id, memory: s.memory, created_at: s.created_at ?? null, missing: s.missing ?? false, trash_id: trashIds[s.id] ?? null })),
          resultFull: result.consolidated,
          newId,
        });
      }
    } catch (err) {
      console.error(`[mem0] Consolidation failed for group:`, err);
    }
  }

  console.log(`[mem0] Consolidation: ${consolidated} groups merged, ${deleted} fragments deleted`);
  return { consolidated, deleted, groups: groups.size, details };
}
