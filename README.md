# lain-memory

**The problem:** LLMs are stateless — every conversation starts from zero. A personal assistant that can't remember who you are, what you decided, or what changed since last time isn't an assistant, it's a stranger you have to re-brief daily.

**The naive fix fails:** storing everything produces noise, duplicates, contradictions ("prefers Bun" vs "prefers npm"), and stale facts that silently poison future answers.

**This service** is Lain's long-term memory: it remembers what's worth keeping, resolves conflicts on write, ranks by relevance + freshness on read, and forgets what's stale. Vector memory (Mem0/Qdrant) for semantic recall, a knowledge graph (GraphRAG) for entity relationships, and background maintenance that keeps the whole thing trustworthy.

Standalone HTTP service (`:3341`) — the assistant talks to it over HTTP for everything memory-related.

## How it answers that

- **Quality gate on write** — credential / boilerplate / noise walls reject junk before it's stored.
- **Conflict check on write** — LLM classifier verdicts `ADD / UPDATE / NOOP`, so new facts merge with old ones instead of piling up contradictions. Modes: `atomic` (default) / `bundle` / `index` / `raw`.
- **Ranked recall** — `(0.5×cosine + 0.3×ageDecay + 0.2×importance) × (0.5 + 0.5×confidence) + termBoost` (capped at 1.0), half-life 90d fact / 7d state / 180d importance≥0.8, hot/warm/cold tiers, `LAIN_MIN_RECALL_SCORE` threshold (default `0.356`). Details in [How recall ranks](#how-recall-ranks).
- **Forgetting on purpose** — dedup sweep + memory reaper expire stale memories (with audit log), GraphRAG autoclean prunes the graph.
- **Graph context** — entity/relationship extraction plus partition-based search (PGS) and seed ingestion from text/PDFs.

### How chat-web uses this (plain English)

Think of it in two parts.

**1. Mem0 is the main memory.**

It is like sticky notes. Each `remember` saves one sentence: "Lucas prefers Bun".
When chat-web asks, it calls `recall` — semantic search in Qdrant for similar notes.

The automatic endpoint only does this:
`POST /api/memory/context` -> `getContextForSpawn()` in `src/mem0.ts:1559`.
It fetches global + project memories and builds text. It does not touch the graph.

**2. The graph is a map of connections.**

It does not store sentences. It stores nodes and edges:
`lucas -USES-> bun`.

Code in `src/graphrag.ts:343` (`ingest`) and `src/graphrag.ts:411` (`query`).

It is good for questions that `recall` answers badly: "what depends on what?", "who works on what?", "what did we decide about X?".

**3. On save, both are fed together.**

When you save something, `addMemory()` in `src/mem0.ts:759` saves to mem0 and triggers `graphrag.ingest()` in the background.

So even if chat-web only reads mem0, the graph was already fed.

**4. On read, they are separate paths.**

Chat-web has 3 options:

* fast/automatic: `/api/memory/recall` or `/api/memory/context` in `src/server.ts:86,110` — mem0 only.
* relations: `/api/graph/query` in `src/server.ts:172` — must be called on purpose. Example BFF pattern in `lain-chat-web/server/server.ts:236` (`queryGraph`) + `245` (`buildMemoryBlock` puts `[MEMORIAS RELEVANTES]` + `[GRAFO]` together).
* deep analysis: `/api/pgs/execute` in `src/server.ts:238` — sweeps the whole graph in parts and synthesizes.

If chat-web only calls `context`/`recall`, it gets nothing from the graph.

**5. It is off by default.**

The graph ships disabled: `LAIN_GRAPHRAG_ENABLED=false` in `src/config.ts:79`.
Turn it on with `LAIN_GRAPHRAG_ENABLED=true`. When off, `query()` returns empty and `ingest()` does nothing.

Short version: mem0 = what was said, every day. Graph = bonus for connections and decisions, but chat-web has to ask for it explicitly.

## Quickstart

Requirements: [Bun](https://bun.sh) ≥ 1.x, Docker Compose (Qdrant + Redis), an OpenAI-compatible LLM endpoint.

```bash
./setup.sh [--install-missing]   # macOS/Linux
```

- Without flags it **checks** prerequisites (Bun, Docker + Compose) and fails with instructions when missing.
- With `--install-missing` it **installs** them: Bun via the official script; Docker Desktop via Homebrew (macOS) or `get.docker.com` on apt-based Linux. Other platforms print manual steps.
- Then: starts Qdrant+Redis, creates `.env` (never overwrites) + workspace dir, `bun install`, MCP smoke test (`--live` write-path proof when an LLM key exists), and prints harness configs.

Windows (PowerShell nativo):

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 [-InstallMissing]
```

`-InstallMissing` installs Bun + Docker Desktop via winget (admin needed for Docker; first launch initializes WSL2 and can take minutes). Without it, missing prerequisites fail with manual steps — same contract as the `.sh`.

Then edit `.env` (workspace dir + LLM keys) and re-run the setup script. Without keys, only `tools/list` is verified — run `bun run smoke:live` afterwards to prove the write path (remember→recall→forget, zero residue) against real Qdrant+LLM. Manual equivalent:

```bash
docker compose up -d          # Qdrant :6333 + Redis :6379
cp .env.example .env          # set LAIN_WORKSPACE_DIR + LLM keys
bun install && bun run dev    # :3341
curl localhost:3341/health
bun run smoke                 # stdio MCP self-check (12 tools)
```

Supervised: `bun run start` (ou via seu process manager a partir de `ecosystem.config.cjs`).

> `LAIN_INSTANCE_ID` suffixes the Qdrant collection, graph file and Redis prefix — instances sharing a workspace must use the same one.

## MCP (stdio) — any harness

Native MCP server with only the memory surface (12 tools: `remember`, `recall`, `forget`, `update_memory`, `list_memories`, `scan_memories`, `graph_query`, `graph_stats`, `pgs_query`, `pgs_stats`, `seed_extract`, `list_seeds`). In-process backends — no `:3341` hop, no session hooks (active-project / `[FLUSH:id]` were dropped; they belong to Lain's channel layer).

Transport is plain stdio (`bun run mcp`), so any MCP-compatible harness works. `./setup.sh` prints the exact snippets with your paths filled in; generically:

- **OpenCode** (`~/.config/opencode/opencode.jsonc`):

```jsonc
"mcp": {
  "lain_memory": {
    "type": "local",
    "command": ["<bun>", "run", "--cwd", "<path>/lain-memory", "mcp"],
    "enabled": true,
    "environment": { "LAIN_WORKSPACE_DIR": "<same as .env>" },
    "timeout": 120000
  }
}
```

- **Claude Code**:

```bash
claude mcp add lain-memory --env LAIN_WORKSPACE_DIR=<same-as-.env> -- <bun> run --cwd <path>/lain-memory mcp
```

- **Any MCP client (generic stdio JSON)**:

```json
{ "command": "<bun>",
  "args": ["run", "--cwd", "<path>/lain-memory", "mcp"],
  "env": { "LAIN_WORKSPACE_DIR": "<same-as-.env>" } }
```

Notes: `LAIN_WORKSPACE_DIR` must match this repo's `.env` (same graph/Qdrant collection as `:3341`) and the directory must exist (`./setup.sh` creates it; otherwise the server refuses to boot). `timeout` 120s is recommended — `remember`/`pgs_query` chain several LLM calls. Verify with `bun run smoke` (tool list) or `bun run smoke:live` (full write path, needs Qdrant + LLM key).

Windows notes: use `setup.ps1` (paths with `~\` work; `~` in `.env` expands to `%USERPROFILE%`). Needs Bun for Windows, Docker Desktop (Compose v2) and PowerShell 5.1+. The MCP itself is pure TS with no native deps, so `bun run mcp` behaves the same. Not yet run end-to-end on a real Windows box — the `.ps1` mirrors the tested `.sh` step by step, but treat the first Windows run as beta and report back.

## Workspace

All file state lives under `LAIN_WORKSPACE_DIR` (default `~/lain-memory-workspace`), owned entirely by this server:

```
<workspace>/
└── .knowledge/
    ├── graph.json            # knowledge graph (GraphRAG)
    ├── graph-blocklist.json  # autoclean reject list
    ├── forget-blocklist.json # hashes of user-forgotten texts (fail-closed: unreadable = blocked)
    ├── seeds/                # extracted seed files
    └── pgs-sessions/         # resumable PGS sessions
```

The dir must exist before boot (the server refuses to start otherwise — `./setup.sh` creates it). Vector memories live separately in Qdrant (`./data/qdrant`); Redis holds cache only. To start fresh, point `LAIN_WORKSPACE_DIR` at an empty dir and restart — Qdrant data is unaffected.

### Where user state lives (post-#8–#11)

| What | Where | Notes |
|------|-------|-------|
| Memory text + `lain_feedback` / `lain_importance` / `lain_relevance` payload | Qdrant (`mem0` or `mem0-${LAIN_INSTANCE_ID}`) | Authority for votes, titles, importance, extractor ratings. No TTL. Survives Redis loss. |
| Forget blocklist | `$WORKSPACE/.knowledge/forget-blocklist.json` | Authority. Atomic writes. Fail-closed on read error. |
| Graph + seeds + PGS sessions | `$WORKSPACE/.knowledge/` | As above. |
| Recall cache, touch timestamps, state L2 | Redis | Pure cache — safe to drop at any time. Rebuilds on its own. |

`/api/memory/feedback` is fail-hard: if the vote cannot be persisted (Qdrant down, unknown id) it answers 500 instead of a silent success.

Migrating a pre-#11 Redis (one-shot, idempotent, deletes nothing):

```bash
bun run migrate:state -- --dry-run   # report only: counts + ids with no Qdrant point
bun run migrate:state                # copy feedback/importance/blocklist (Qdrant wins ties)
docker volume rm lain-memory-redis   # optional afterwards: Redis rebuilds as pure cache
```

### How recall ranks

`rankRecallResults` (`src/mem0.ts`) scores every hit as:

`score = (0.5·cosine + 0.3·ageDecay + 0.2·importance) · (0.5 + 0.5·confidence) + termBoost` (capped at 1.0)

- `ageDecay = 2^(-daysOld / halfLife)`: half-life **90d** for `fact`, **7d** for `state`, **180d** when `importance >= 0.8` (confirmed-important is protected from decay). Missing/future dates decay as 1.0.
- `importance`: chat memories use the extractor (`relevance` 1–5 → 0.2 / 0.35 / 0.5 / 0.7 / 0.85); everything else uses the `scoreImportance` regex — dates, money, decision language (`decidiu`, `vai usar`), errors. No project, vendor, health, or personal bonuses; those are the extractor's job. Stored in memory-state (Qdrant `lain_importance`).
- `confidence`: 0.5 default; ✓ confirm sets 1.0 (and floors importance at 0.85). Archived memories are excluded before ranking.
- `termBoost`: up to +0.1 for exact query-term matches (terms ≥ 3 chars).
- Recalled memories get a touch timestamp (30d TTL): the next recall uses it as virtual `updated_at` (use refreshes recency) and bumps importance +0.05. `cached` recalls serve from Redis (5min TTL); votes invalidate the cache.
- `LAIN_MIN_RECALL_SCORE` (default `0.356`) drops low-score hits after ranking.

`kind` (`fact` = stable, `state` = transient) comes from the extractor on chat saves and from a regex on other paths; it drives the decay half-life above. `sensitive` (mental health, crisis, grief, substance use) comes from the extractor; it travels in the payload and has no automated consumer yet.

Auditing importance (read-only, unless `--restore`):

```bash
bun run scripts/snapshot-importance.ts                          # snapshot all points → scripts/eval-results/importance-<ts>.json + chat distribution
bun run scripts/snapshot-importance.ts --restore <file> [--dry-run]  # rewrite importance+kind from a snapshot (skips ids that no longer exist)
bun run scripts/compare-importance.ts <antes.json> <depois.json>     # side-by-side distribution + top movers → scripts/eval-results/compare-<ts>.txt
```

## Configuration

All via env (see [.env.example](./.env.example)):

| Var | Default | Description |
|-----|---------|-------------|
| `LAIN_MEMORY_PORT` | `3341` | HTTP port |
| `LAIN_API_KEY` | empty (open localhost) | Bearer auth |
| `LAIN_WORKSPACE_DIR` | `~/lain-memory-workspace` | Own workspace (graph, seeds, PGS sessions; `~` expanded, dir must exist) |
| `QDRANT_HOST` / `QDRANT_PORT` | `localhost` / `6333` | Vector backend |
| `LAIN_LLM_BASE_URL` / `LAIN_LLM_API_KEY` / `LAIN_LLM_MODEL` / `LAIN_EMBED_MODEL` | gateway defaults | Unified LLM contract (`LAIN_LLM_*` → `AI_GATEWAY_*` → OpenAI) |
| `LAIN_REDIS_ENABLED` / `LAIN_REDIS_HOST` / `LAIN_REDIS_PORT` | `true` / `127.0.0.1` / `6379` | Cache (all paths degrade without it) |
| `LAIN_GRAPHRAG_ENABLED` / `_MAX_CONTEXT_NODES` / `_MAX_DEPTH` | `false` / `10` / `3` | GraphRAG tuning |
| `LAIN_INSTANCE_ID` | empty | Suffixes collection, graph file, Redis prefix |
| `LAIN_MIN_RECALL_SCORE` | `0.356` | Recall keep threshold |
| `LAIN_MEMORY_REAPER_ENABLED` / `_DRY_RUN` | — / `false` | Stale-memory expiry |
| `LAIN_PENDING_MERGE_ENABLED` | `false` | Auto-merge pending-review UPDATE queue in consolidate (item 2) |
| `LAIN_SEED_ENABLED` / `LAIN_SEED_MAX_CHUNKS` | enabled / `10` | Seed extraction |
| `LAIN_ENABLE_PGS` | `on` | Partitioned graph search |

## API

Base `http://localhost:3341`, `Authorization: Bearer $LAIN_API_KEY` (skipped when key empty). `GET` for health/stats/nodes/metrics, `POST` otherwise. Errors: `{ error: string }`.

### Memory

| Path | Body | Description |
|------|------|-------------|
| `/api/memory/remember` | `{ text, project?, mode?, assistant?, date?, skipQualityCheck? }` | Save with conflict check (`atomic`/`bundle`/`index`/`raw`). `chat` extracts durable user facts from a turn (`text` = user, `assistant` = model reply, not stored) and saves each verbatim, with a short display `title` (ideal 3, max 6 words) plus extractor-rated `relevance`/`kind`/`sensitive` (→ importance in memory-state), all in the same extractor call |
| `/api/memory/recall` | `{ query, project?, limit?, cached?, debug? }` | Ranked search (`cached` = Redis-backed, `debug: true` pins `adjustedScore` + `importance` on every hit). Each hit carries `adjustedScore`, `importance`, `confidence`, `last_confirmed_at`, `status`, `kind`, `title` |
| `/api/memory/list` | `{ project?, limit? }` | List memories (each item carries `confidence`, `last_confirmed_at`, `status`, `kind`, `title`) |
| `/api/memory/forget` | `{ memory_id, project? }` | Trash copy (7d undo) → hard delete → forget-blocklist |
| `/api/memory/restore` | `{ memory_id }` (trash copy id) | Undo a forget within 7d; lifts the blocklist entry |
| `/api/memory/feedback` | `{ id, action: confirm\|archive\|unarchive, kind? }` | User vote: ✓ confirm (confidence 1.0 + importance floor), 🕐 archive (hidden from recall), ↩ unarchive |
| `/api/memory/add` | `{ text, project?, opts? }` | Direct add, no conflict check |
| `/api/memory/context` | `{ message, project?, charBudget?, limits? }` | Spawn-context composition |
| `/api/memory/update` | `{ id, memory, project? }` | Update preserving native ID |
| `/api/memory/consolidate` | `{ project? }` | Dedup/merge pass |
| `/api/memory/scan` | `{ project }` | Clean stale memories |
| `/api/memory/resolve-entities` | `{ threshold? }` (default `0.75`) | Entity resolution |
| `/api/memory/contradiction-scan` | `{ project?, limit? (default 20, max 100), offset? }` | Classify similar pairs, auto-delete dupes |
| `GET /api/memory/contradictions` | `?kind=merge|contradiction&limit=` | Pending review queue (sweep UPDATE/DELETE verdicts) |
| `/api/memory/contradictions/dismiss` | `{ id }` | Dismiss a pending review entry |
| `GET /api/memory/metrics` | — | In-memory counters |

```bash
curl -s localhost:3341/api/memory/remember -X POST -H 'Content-Type: application/json' \
  -d '{"text":"Lucas prefers Bun over npm for TS tooling","project":"lain"}'

curl -s localhost:3341/api/memory/recall -X POST -H 'Content-Type: application/json' \
  -d '{"query":"package manager preference","project":"lain","limit":5}'
```

Entity scheme: `lucas` → global facts, `lucas:<project>` → project-scoped.

### Delete audit trail (trash + log)

Every automated delete (conflict-check supersede, consolidation, contradiction-scan)
copies the full memory to the `trash` scope first (no quality/conflict checks, no
graph ingestion) with provenance metadata, then hard-deletes the original. The
`maintenance.jsonl` log (`$WORKSPACE/.maintenance-logs/`) records the full texts,
reason, and replacement id (`memory_supersede`, `memory_consolidation`,
`memory_duplicate_purge` actions). Sweeps (reaper/dedup/consolidation) never touch
`trash`, so restores are always possible:

```bash
KEY="Authorization: Bearer $LAIN_API_KEY"
# 1. Find what was deleted (full text + reason in the log)
grep -a memory_supersede "$WORKSPACE/.maintenance-logs/maintenance.jsonl" | tail -2
# 2. List trash copies (metadata.original_id / reason / replaced_by)
curl -s localhost:3341/api/memory/list -X POST -H 'Content-Type: application/json' -H "$KEY" \
  -d '{"project":"trash","limit":50}'
# 3. Restore: re-add the text to its scope, then forget the trash copy
curl -s localhost:3341/api/memory/add -X POST -H 'Content-Type: application/json' -H "$KEY" \
  -d '{"text":"<texto restaurado>","opts":{"skipQualityCheck":true}}'
curl -s localhost:3341/api/memory/forget -X POST -H 'Content-Type: application/json' -H "$KEY" \
  -d '{"memory_id":"<trash_id>"}'
```

### Graph / Seeds / PGS

| Path | Body | Description |
|------|------|-------------|
| `/api/graph/query` | `{ query, depth?, maxNodes? }` | BFS context around matched entities |
| `GET /api/graph/stats`, `GET /api/graph/nodes` | — | Stats / node list |
| `/api/graph/remove-nodes` | `{ ids[] }` | Remove nodes |
| `/api/graph/remove-relationships` | `{ source, predicates?, targets? }` | Remove edges |
| `/api/graph/autoclean`, `/api/graph/dump`, `/api/graph/ingest` | — / — / `{ entities[], relationships[] }` | Reject-list sweep / full export / ingest |
| `/api/seed/extract` | `{ type, source, rawText?, project?, phone? }` | Fact/entity extraction → `{ id, title, summary, facts_count, entities_count }` |
| `/api/seed/list` | `{ project? }` | List seeds |
| `/api/pgs/execute` | `{ query, mode?, sessionId? }` | Partition → route → sweep → synthesize |
| `/api/pgs/stats` | — | Partitions overview |

## Development

```bash
bun run typecheck   # tsc --noEmit
bun test src/
```

Notes: `@qdrant/js-client-rest` pinned to `1.18.0` (`1.19` breaks `client.search`). Back up Qdrant via the **snapshot API**, not by copying `./data/qdrant` live. Redis is cache-only — safe to drop.

Non-goals: channels, agent lifecycle, session side-effects, MCP proxying — this server owns persistence and retrieval only.
