# lain-memory

Standalone memory server for Lain — Mem0/Qdrant vector memory + GraphRAG + contradiction detection.

Extracted from the Lain monorepo as a supervised, independently deployable HTTP service. Route shapes are identical to Lain's `api-routes.ts` memory/graph endpoints (served with the full `/api/...` paths), so the Lain MCP proxy can cut over by changing only its base URL (`LAIN_MEMORY_BASE_URL`).

- Port: `:3341` (Lain API uses `:3334` — no clash)
- Runtime: [Bun](https://bun.sh) + TypeScript
- Vector store: Qdrant (`mem0[-INSTANCE_ID]` collection)
- Cache / locks: Redis (optional — all paths degrade gracefully)
- Graph: Graphology in-memory directed graph with JSON persistence (`graph[-ID].json`)

See [CONTRACT.md](./CONTRACT.md) for the frozen behavioral contract with Lain.

## Features

- **Vector memory (Mem0):** `remember / recall / list / forget / update / consolidate / scan` with quality gate, dedup, and contradiction handling.
- **Ranked recall:** `score = min(1.0, 0.5×cosine + 0.3×ageDecay + 0.2×importance + termBoost)`, half-life 30d (180d when `importance ≥ 0.8`), hot/warm/cold tiers, `LAIN_MIN_RECALL_SCORE` keep threshold (default `0.356`).
- **Remember modes:** `atomic` (default, full conflict check), `bundle` (prefers UPDATE, for summaries), `index` (skips conflict check, bulk ingest), `raw` (verbatim, `infer: false`).
- **GraphRAG:** entity/relationship extraction (fast LLM, fire-and-forget), BFS query, stats, autoclean, Redis-cached.
- **Contradiction detection:** LLM classifier (`ADD / UPDATE / NOOP`) over similar memories + scan endpoint.
- **Seeds (Fase 4):** `seed/extract` + `seed/list` — chunked fact/entity extraction from raw text or PDFs into `<workspace>/.knowledge/seeds`.
- **PGS (Fase 4):** partition-based graph search engine (`pgs/execute`, `pgs/stats`) with Louvain partitioning, Haiku providers, resumable sessions in `.knowledge/pgs-sessions`.
- **Thin-client endpoints:** `memory/add` (direct add), `memory/context` (spawn composition), `graph/ingest`, `graph/dump`, cached recall (`cached: true`).
- **Background maintenance:** dedup sweep, memory reaper (with audit log + doctor), GraphRAG autoclean — all start at boot.
- **Metrics:** in-memory counters via `GET /api/memory/metrics`.

Deliberately **not** in this service (stays in Lain): session side-effects, Telegram/Obsidian bridge, file-store boot ingest, agent-spawn machinery, MCP proxy, vault store. See CONTRACT.md § "Deliberate divergences".

## Architecture

```
lain (MCP proxy / agents)
   │  POST /api/memory/*  /api/graph/*  /api/seed/*  /api/pgs/*
   ▼
lain-memory :3341 (Bun.serve, src/server.ts)
   ├── mem0.ts ──► Mem0 SDK ──► Qdrant :6333 (mem0[-ID])
   │      ├── contradiction-detector.ts (LLM classify ADD/UPDATE/NOOP)
   │      ├── memory-patterns.ts (quality / boilerplate / credential walls)
   │      ├── mem-metrics.ts, maintenance-log.ts
   │      └── dedup-sweep.ts / memory-reaper.ts (background)
   ├── graphrag.ts ──► graphology ──► <workspace>/.knowledge/graph[-ID].json
   │      └── graph-autoclean.ts (background + endpoint)
   ├── seed-extraction.ts ──► <workspace>/.knowledge/seeds/*.json
   │      └── pdf-reader/ (seed PDF ingest only)
   ├── pgs/ ──► PGSEngine (partitioner → router → sweeper → synthesizer)
   └── redis.ts ──► Redis :6379 (cache: lai​n:[ID]:*, graphrag cache, locks)
```

## Requirements

- Bun ≥ 1.x (`curl -fsSL https://bun.sh/install | bash`)
- Docker + Docker Compose (for Qdrant + Redis), **or** existing `QDRANT_HOST/PORT` + Redis
- An OpenAI-compatible LLM endpoint (Mem0 internal LLM/embeddings + enrichment + contradiction classifier route through it — see `src/llm-client.ts`)

## Quickstart

```bash
# 1. Data stack (Qdrant :6333 + Redis :6379)
docker compose up -d

# 2. Env
cp .env.example .env
# edit at minimum: LAIN_WORKSPACE_DIR (must match Lain's during strangler phase),
# LAIN_LLM_BASE_URL / LAIN_LLM_API_KEY (or AI_GATEWAY_* / OpenAI fallback)

# 3. Install + run
bun install
bun run dev          # or: bun run start  (src/server.ts, :3341)

# 4. Health check
curl localhost:3341/health
# {"ok":true,"service":"lain-memory"}
```

### PM2 (supervised)

`ecosystem.config.cjs` inherits env from Lain's `server/.env`, pinning only `LAIN_MEMORY_PORT=3341` and `LAIN_WORKSPACE_DIR`:

```bash
pm2 start ecosystem.config.cjs --only lain-memory
pm2 logs lain-memory
```

###736066.1460612 (strangler phase)

Until cutover, `LAIN_INSTANCE_ID`, `LAIN_WORKSPACE_DIR`, `QDRANT_HOST/PORT` and `LAIN_REDIS_*` **must match Lain's env** — they suffix the Qdrant collection, graph filename and Redis prefix, and both servers share `graph.json` + seeds. See CONTRACT.md § "Identity agreement".

## Configuration

All via env (see [.env.example](./.env.example)). Key variables:

| Var | Default | Description |
|-----|---------|-------------|
| `LAIN_MEMORY_PORT` | `3341` | HTTP port |
| `LAIN_API_KEY` | empty (open localhost) | Bearer auth (`Authorization: Bearer …`) |
| `LAIN_WORKSPACE_DIR` | `~/lain-workspace` | Shared workspace (graph, seeds, MEMORY.md) — must match Lain |
| `LAIN_PROJECTS_BASE` | `~/Documents/GitHub` | Project base dir |
| `QDRANT_HOST` / `QDRANT_PORT` | `localhost` / `6333` | Vector backend |
| `LAIN_LLM_BASE_URL` / `LAIN_LLM_API_KEY` / `LAIN_LLM_MODEL` / `LAIN_EMBED_MODEL` | gateway defaults | Unified LLM contract (`LAIN_LLM_*` wins, `AI_GATEWAY_*` fallback, then OpenAI) |
| `LAIN_REDIS_ENABLED` / `LAIN_REDIS_HOST` / `LAIN_REDIS_PORT` | `true` / `127.0.0.1` / `6379` | Cache; everything degrades gracefully without it |
| `LAIN_GRAPHRAG_ENABLED` / `_MAX_CONTEXT_NODES` / `_MAX_DEPTH` / `_SAVE_DEBOUNCE_MS` | `false` / `10` / `3` / `1000` | GraphRAG tuning |
| `LAIN_INSTANCE_ID` | empty | Suffixes Qdrant collection, graph file, Redis prefix — must match Lain |
| `LAIN_MIN_RECALL_SCORE` | `0.356` | Recall keep threshold |
| `LAIN_MEMORY_REAPER_ENABLED` / `_DRY_RUN` / `_FETCH_LIMIT` | — / `false` / `200` | Reaper maintenance |
| `LAIN_SEED_ENABLED` / `LAIN_SEED_MAX_CHUNKS` / `LAIN_SEED_MAX_FACTS` | enabled / `10` / `10` | Seed extraction |
| `LAIN_ENABLE_PGS` | `on` | PGS engine |

## API

Base: `http://localhost:3341`. Auth: `Authorization: Bearer $LAIN_API_KEY` (skipped when key empty, localhost semantics). `GET` for health/stats/nodes/metrics; everything else `POST` with JSON body. Errors are `{ error: string }`.

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health`, `/api/health` | `{ ok: true, service: "lain-memory" }` |

### Memory (`/api/memory/*`)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/memory/remember` | `{ text, project?, mode?, skipQualityCheck? }` | Conflict-checked save. `mode`: `atomic` (default) / `bundle` / `index` / `raw` |
| POST | `/api/memory/recall` | `{ query, project?, limit?, cached? }` | Ranked search. `cached: true` uses Redis-backed path |
| POST | `/api/memory/list` | `{ project?, limit? }` | List memories |
| POST | `/api/memory/forget` | `{ memory_id }` | Delete by ID |
| POST | `/api/memory/add` | `{ text, project?, opts? }` | Direct `addMemory`, no conflict check (pre-filtered ingests) |
| POST | `/api/memory/context` | `{ message, project?, charBudget?, limits? }` | Spawn-context composition (query-building + budget server-side) |
| POST | `/api/memory/update` | `{ id, memory, project? }` | Update preserving native ID |
| POST | `/api/memory/consolidate` | `{ project? }` | Dedup/merge pass |
| POST | `/api/memory/scan` | `{ project }` | Clean stale project memories → `{ total, deleted, deletedItems }` |
| POST | `/api/memory/resolve-entities` | `{ threshold? }` (default `0.75`) | Entity resolution pass |
| POST | `/api/memory/contradiction-scan` | `{ project? }` | Classify top-similar pairs; auto-deletes `NOOP` dupes → `{ scanned, issues, results[] }` |
| GET | `/api/memory/metrics` | — | In-memory counters |

```bash
curl -s localhost:3341/api/memory/remember -X POST -H 'Content-Type: application/json' \
  -d '{"text":"Lucas prefers Bun over npm for TS tooling","project":"lain","mode":"atomic"}'

curl -s localhost:3341/api/memory/recall -X POST -H 'Content-Type: application/json' \
  -d '{"query":"package manager preference","project":"lain","limit":5}'
```

Entity scheme: `lucas` → global facts, `lucas:<project>` → project-scoped.

### Graph (`/api/graph/*`)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/graph/query` | `{ query, depth?, maxNodes? }` | BFS context around matched entities |
| GET | `/api/graph/stats` | — | Cached node/edge stats |
| GET | `/api/graph/nodes` | — | List all nodes |
| POST | `/api/graph/remove-nodes` | `{ ids[] }` | Remove nodes |
| POST | `/api/graph/remove-relationships` | `{ source, predicates?, targets? }` | Remove edges |
| POST | `/api/graph/autoclean` | — | Reject-list sweep |
| POST | `/api/graph/dump` | — | Full graph payload (for external PGS sweeps) |
| POST | `/api/graph/ingest` | `{ entities[], relationships[] }` | Seed entity ingestion |

### Seeds (`/api/seed/*`, Fase 4)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/seed/extract` | `{ type, source, rawText?, project?, phone? }` | Chunked extract → `{ id, title, summary, facts_count, entities_count }` |
| POST | `/api/seed/list` | `{ project? }` | List extracted seeds |

### PGS (`/api/pgs/*`, Fase 4)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/pgs/execute` | `{ query, mode?, sessionId? }` | Partition → route → sweep → synthesize over local GraphRAG |
| POST | `/api/pgs/stats` | — | `{ nodes, edges, partitions, partitionSummaries[] }` |

## Background jobs

Started automatically in `boot()` (`src/server.ts`):

- **Memory maintenance** (`mem0.ts` `startMemoryMaintenance`) — periodic consolidation.
- **Dedup sweep** (`dedup-sweep.ts` `startDedupSweep`) — duplicate merging.
- **Memory reaper** (`memory-reaper.ts` `startMemoryReaper`) — stale-memory expiry with JSONL audit (`LAIN_REAPER_AUDIT_PATH`) + `memory-reaper-doctor.ts` diagnostics.
- **GraphRAG persistence** — debounced JSON save (`LAIN_GRAPHRAG_SAVE_DEBOUNCE_MS`).

## Project structure

```
├── src/
│   ├── server.ts               # Bun.serve router (all /api/* routes) + boot
│   ├── mem0.ts                 # Mem0 SDK wrapper: CRUD, ranker, quality gate, maintenance
│   ├── memory-patterns.ts      # Credential / boilerplate / noise regex walls
│   ├── contradiction-detector.ts # LLM ADD/UPDATE/NOOP classifier
│   ├── graphrag.ts             # Graphology graph + extraction + BFS query + cache
│   ├── graph-autoclean.ts      # Reject-list sweep
│   ├── seed-extraction.ts      # Chunked seed ingest (text + PDF)
│   ├── pdf-reader/             # Seed PDF ingest only (pdf_read MCP stays in Lain)
│   ├── pgs/                    # Partitioned graph search: engine, partitioner/louvain,
│   │                           # router, sweeper, synthesizer, haiku-provider, session
│   ├── dedup-sweep.ts / memory-reaper*.ts  # Background maintenance
│   ├── llm-client.ts           # Unified OpenAI-compatible client (gateway routing)
│   ├── redis.ts / distributed-lock.ts / file-io-lock.ts
│   ├── workspace.ts            # Workspace paths + INSTANCE_ID (shared with Lain)
│   ├── config.ts               # Zod env schema
│   ├── mem-metrics.ts / maintenance-log.ts
│   ├── integration-bridge.ts   # No-op bridge (Telegram/Obsidian hooks stay in Lain)
│   └── progressive-context.ts  # Stub: exports MemoryLimits only
├── data/                       # Repo-local Qdrant bind mount (gitignored)
├── docker-compose.yml          # Qdrant + Redis data stack
├── ecosystem.config.cjs        # PM2 supervised process
├── CONTRACT.md                 # Frozen lain ↔ lain-memory behavioral contract
└── .env.example
```

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test src/       # bun test (unit: mem0 ranker/quality/retry, graph autoclean,
                    # llm-client, reaper, seeds, pgs/*, pdf-reader)
```

Qdrant note: `@qdrant/js-client-rest` is pinned to `1.18.0` — `1.19` breaks `client.search` (unlisted Mem0 peer). Don't bump without testing.

Backup note: back up Qdrant via the **snapshot API**, not by copying `./data/qdrant` live. Redis is cache-only (named volume `lain-memory-redis`) — safe to drop.

## Relation to Lain

This service is the strangler-fig extraction of Lain's memory core. The frozen contract lives in [CONTRACT.md](./CONTRACT.md): recall ranking, remember modes, identity agreement (`LAIN_INSTANCE_ID` / `LAIN_WORKSPACE_DIR` / backends), HTTP shapes, and deliberate divergences. Either side may refactor internals freely; changes to anything in the contract require a coordinated cutover.
