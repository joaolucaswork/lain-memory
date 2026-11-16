/**
 * Shared memory-domain types (mem0 split M1).
 *
 * Pure type declarations only — no runtime code, no I/O. Every module under
 * src/mem0/ imports from here so the dependency graph stays leaf-first.
 * mem0.ts re-exports everything; external importers keep `from './mem0.js'`.
 */

import type {
  FeedbackKind as StateFeedbackKind,
  FeedbackStatus as StateFeedbackStatus,
  MemoryFeedback as StateMemoryFeedback,
} from '../memory-state.js';

export type FeedbackStatus = StateFeedbackStatus;
export type FeedbackKind = StateFeedbackKind;
export type MemoryFeedback = StateMemoryFeedback;

export type FeedbackAction = 'confirm' | 'archive' | 'unarchive';

/** Budget limits for spawn-context composition (see getContextForSpawn). */
export interface MemoryLimits {
  globalLimit: number;
  projectLimit: number;
  graphEnabled: boolean;
}

export type MemoryTier = 'hot' | 'warm' | 'cold';

export interface AddMemoryOpts {
  /** Skip quality scoring (for callers that already filter, like seed-extraction). */
  skipQualityCheck?: boolean;
  /** Skip contradiction detection (for consolidation, seed-extraction, etc.) */
  skipConflictCheck?: boolean;
  /** Treat input as a bundle/summary — informs LLM to prefer UPDATE over NOOP for overlapping atoms. */
  bundleMode?: boolean;
  /** Metadata stored on the Mem0 item (provenance, trash records, etc.). */
  metadata?: Record<string, unknown>;
  /** Skip graph ingestion (trash copies must not pollute the knowledge graph). */
  skipGraphIngest?: boolean;
  /**
   * Skip the forget-blocklist check. Trash copies carry forgotten text by
   * design — blocking them would turn every forget into silent data loss.
   * Everything else (including index-mode re-ingests) stays checked so a
   * forgotten memory cannot be resurrected through another path.
   */
  skipBlocklistCheck?: boolean;
  /**
   * Verbatim mode (mode:raw). Passes infer:false to the Mem0 SDK (no
   * gpt-4o-mini decomposition) AND bypasses pre-save LLM enrichment
   * entirely (see shouldEnrichTechnicalMemory). The stored text is exactly
   * the input — 0 bytes changed. Previously enrichment still ran here and
   * could rewrite/fabricate before Mem0 ever saw the text.
   */
  inferFalse?: boolean;
  /**
   * Fact already extracted from a chat turn. Still hard-rejects credentials
   * and boilerplate, but skips the technical quality score — a diary sentence
   * ("o usuário tem Seinfeld como série conforto") would lose that rubric.
   */
  chatAtom?: boolean;
}

export interface RankedMemory {
  id: string;
  memory: string;
  score?: number;
  created_at?: string;
  updated_at?: string;
  adjustedScore: number;
  importance?: number | null;
  /** Fase 0 feedback contract: confidence, last_confirmed_at, status, kind. */
  confidence?: number;
  last_confirmed_at?: string | null;
  status?: FeedbackStatus;
  kind?: FeedbackKind;
  /** Fase 1 display title: short label, null until generated. */
  title?: string | null;
}

export interface MemorySnapshot {
  id: string;
  memory: string;
  created_at?: string;
  /** True when the id was not found (already gone) — nothing to snapshot. */
  missing?: boolean;
}

export interface TrashProvenance {
  reason: string;
  trigger: string;
  replacedById?: string;
}

export interface RestoreResult {
  id: string | null;
  restored: boolean;
  reason?: string;
}

export interface ConsolidationDetail {
  fragments: string[];
  result: string;
  /** Full-fidelity audit (untruncated). Present on entries written by the audit-trail path. */
  fragmentsFull?: { id: string; memory: string; created_at: string | null; missing: boolean; trash_id: string | null }[];
  resultFull?: string;
  newId?: string;
}

export interface ContradictionSweepReport {
  scope: string | undefined;
  total: number;
  checked: number;
  removed: number;
  llmCalls: number;
  nextCursor: number;
  queuedMerges: number;
  queuedContradictions: number;
}
