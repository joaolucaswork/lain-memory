/**
 * progressive-context stub (lain-memory port).
 *
 * In the lain monorepo, `MemoryLimits` lives in lain-core's
 * progressive-context.ts alongside spawn-context machinery (session-context,
 * user-preferences, memory-pressure-monitor) that does NOT belong to the
 * memory server. Only the interface is needed here (mem0.ts imports it as
 * `import type`, erased at runtime). Interface copied verbatim from
 * lain/server/packages/lain-core/src/progressive-context.ts.
 */

export interface MemoryLimits {
  globalLimit: number;
  projectLimit: number;
  graphEnabled: boolean;
}
