# lain-memory ↔ lain contract (v1)

Frozen behavioral contract. Either side may refactor internals freely;
changes to anything below require a coordinated cutover.

## Ranking (recall)

- `score = min(1.0, 0.5×cosine + 0.3×ageDecay + 0.2×importance + termBoost)`,
  `termBoost ≤ 0.1`.
- Half-life: 30d, or 180d when `importance ≥ 0.8`.
- Tiers: hot < 7d / warm / cold (`global` project never cold).
- Keep threshold: `score ≥ LAIN_MIN_RECALL_SCORE` (default `0.356`).
- Quality gate on write: `MIN_MEMORY_QUALITY = 2` + credential /
  boilerplate / noise regex walls (`mem0.ts`, `memory-patterns.ts`).

## Remember modes (`POST /memory/remember { text, project?, mode? }`)

| mode | behavior |
|------|----------|
| (unset) `atomic` | full conflict check → ADD / UPDATE / NOOP |
| `bundle` | prefers UPDATE over NOOP (summaries over existing atoms) |
| `index` | skips conflict check entirely (pre-deduplicated bulk) |
| `raw` | stores verbatim (`infer: false`); still subject to quality gate |

`update_memory` preserves the native ID (`Memory.update(id, string)`).

## Identity agreement (must match lain's env during strangler phase)

- `LAIN_INSTANCE_ID`: suffixes the Qdrant collection (`mem0[-ID]`),
  the graph filename (`graph[-ID].json`) and the Redis prefix (`lain:[ID]:`).
- `LAIN_WORKSPACE_DIR`: same dir on both sides (shared `graph.json`, seeds).
- `QDRANT_HOST/PORT`, `LAIN_REDIS_*`: same backends.

## HTTP shapes

Identical to lain `api-routes.ts` memory/graph endpoints (served with the
full `/api/...` paths): `remember recall list forget update consolidate scan
resolve-entities contradiction-scan metrics`, `graph/{query,stats,nodes,
remove-nodes,remove-relationships,autoclean}`, `health`. Auth: Bearer
`LAIN_API_KEY`; empty key = open localhost (same as lain `validateApiKey`).

## Deliberate divergences from lain

1. No session side-effects in `remember` (active-project hook, `[FLUSH:id]`
   hook stay in lain).
2. No Telegram/Obsidian bridge (`getBridge()` unset → all hooks no-op).
3. No file-store bridge boot ingest (stays in lain until cutover).
4. `progressive-context.ts` is a stub exporting only `MemoryLimits`
   (interface copied verbatim; spawn machinery stays in lain).
5. `workspace.ts` drops the dead `getClaudeBin` re-export (zero consumers).
6. No PGS, seeds, agent-stopped, claude-hooks, SSE, MCP proxy (phase 4 / never).
