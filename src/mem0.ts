/**
 * Mem0 Memory Backend — barrel (mem0 split M1–M9, epic #13).
 *
 * All logic lives in ./mem0/: types, config, scoring, state, read, write,
 * lifecycle, consolidation, spawn-context, maintenance. This module only
 * re-exports the public surface so existing `from './mem0.js'` import sites
 * keep working unchanged.
 */

export type {
  AddMemoryOpts,
  ConsolidationDetail,
  ContradictionSweepReport,
  FeedbackAction,
  FeedbackKind,
  FeedbackStatus,
  MemoryFeedback,
  MemoryLimits,
  MemorySnapshot,
  MemoryTier,
  RankedMemory,
  RestoreResult,
  TrashProvenance,
} from './mem0/types.js';
export { buildMem0Config, isMem0Configured, withRetry } from './mem0/config.js';
export {
  acceptEnrichedMemory,
  ageDecayScore,
  applyAgeDecayToResults,
  classifyMemoryTier,
  disqualifyMemory,
  isTechnicalMemory,
  MIN_MEMORY_QUALITY,
  scoreActionability,
  scoreImportance,
  scoreMemoryQuality,
  shouldEnrichTechnicalMemory,
} from './mem0/scoring.js';
export {
  applyMemoryFeedback,
  attachFeedback,
  deleteState,
  FEEDBACK_DEFAULTS,
  FEEDBACK_TITLE_MAX_CHARS,
  getManyMemoryFeedback,
  getMemoryFeedback,
  getMemoryImportance,
  getMemoryTouchTimestamp,
  heuristicKind,
  IMPORTANCE_DEFAULT,
  persistHeuristicState,
  reinforceMemoryImportance,
  setMemoryFeedback,
  setMemoryImportance,
  shouldApplyHeuristicState,
  touchMemoryTimestamp,
} from './mem0/state.js';
export {
  applyMinScoreFilter,
  cachedSearchMemory,
  DEFAULT_MIN_RECALL_SCORE,
  getMemories,
  invalidateMem0Cache,
  rankRecallResults,
  resolveMinRecallScore,
  searchMemory,
} from './mem0/read.js';
export {
  addMemory,
  addMemoryWithConflictCheck,
} from './mem0/write.js';
export {
  deleteMemoriesWithPolicy,
  deleteMemory,
  restoreFromTrash,
  RESTORE_WINDOW_MS,
  scanAndCleanProjectMemories,
  snapshotMemories,
  trashAndDelete,
  TRASH_PROJECT,
  updateMemory,
} from './mem0/lifecycle.js';
export {
  consolidateMemories,
  isPendingMergeEnabled,
} from './mem0/consolidation.js';
export { getContextForSpawn } from './mem0/spawn-context.js';
export {
  backfillImportanceScores,
  getContradictionCursor,
  getContradictionFetchLimit,
  getContradictionMaxLlm,
  getContradictionSliceSize,
  nextSliceIndices,
  runContradictionSweepForScope,
  runRotatingContradictionSweep,
  setContradictionCursor,
  startMemoryMaintenance,
  stopMemoryMaintenance,
} from './mem0/maintenance.js';

// ─── Forget Blocklist (✕ must not resurrect) ───
// Fase 0 of per-memory quick actions. `forget` hard-deletes AND records a
// hash of the text here; every save path checks it first (see addMemory).
// Without this, the next chat turn re-extracts the same fact.
// Authority: src/forget-blocklist.ts (workspace JSON file, Redis-free).
// Re-exported here so existing import sites keep working.
import {
  normalizeForBlocklist,
  blocklistHash,
  isBlocklisted,
  addToBlocklist,
  removeFromBlocklist,
  getBlocklistPath,
  __setBlocklistPathForTests,
} from './forget-blocklist.js';
export { normalizeForBlocklist, blocklistHash, isBlocklisted, addToBlocklist, removeFromBlocklist, getBlocklistPath, __setBlocklistPathForTests };
