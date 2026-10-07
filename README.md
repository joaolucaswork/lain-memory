# lain-memory

**The problem:** LLMs are stateless — every conversation starts from zero. A personal assistant that can't remember who you are, what you decided, or what changed since last time isn't an assistant, it's a stranger you have to re-brief daily.

**The naive fix fails:** storing everything produces noise, duplicates, contradictions ("prefers Bun" vs "prefers npm"), and stale facts that silently poison future answers.

**This service** is Lain's long-term memory: it remembers what's worth keeping, resolves conflicts on write, ranks by relevance + freshness on read, and forgets what's stale. Vector memory (Mem0/Qdrant) for semantic recall, a knowledge graph (GraphRAG) for entity relationships, and background maintenance that keeps the whole thing trustworthy.

Standalone HTTP service (`:3341`) — the assistant talks to it over HTTP for everything memory-related.

## How it answers that

- **Quality gate on write** — credential / boilerplate / noise walls reject junk before it's stored.
- **Conflict check on write** — LLM classifier verdicts `ADD / UPDATE / NOOP`, so new facts merge with old ones instead of piling up contradictions. Modes: `atomic` (default) / `bundle` / `index` / `raw`.
- **Ranked recall** — `0.5×cosine + 0.3×ageDecay + 0.2×importance + termBoost`, 30d half-life (180d for high-importance), hot/warm/cold tiers, `LAIN_MIN_RECALL_SCORE` threshold (default `0.356`).
- **Forgetting on purpose** — dedup sweep + memory reaper expire stale memories (with audit log), GraphRAG autoclean prunes the graph.
- **Graph context** — entity/relationship extraction plus partition-based search (PGS) and seed ingestion from text/PDFs.

## Quickstart

Requirements: [Bun](https://bun.sh) ≥ 1.x, Docker Compose (Qdrant + Redis), an OpenAI-compatible LLM endpoint.

```bash
docker compose up -d          # Qdrant :6333 + Redis :6379

cp .env.example .env          # set LAIN_WORKSPACE_DIR + LLM keys

bun install && bun run dev    # :3341
curl localhost:3341/health
```

Supervised: `pm2 start ecosystem.config.cjs --only lain-memory`.

> `LAIN_INSTANCE_ID` suffixes the Qdrant collection, graph file and Redis prefix — instances sharing a workspace must use the same one.

## Configuration

All via env (see [.env.example](./.env.example)):

| Var | Default | Description |
|-----|---------|-------------|
| `LAIN_MEMORY_PORT` | `3341` | HTTP port |
| `LAIN_API_KEY` | empty (open localhost) | Bearer auth |
| `LAIN_WORKSPACE_DIR` | `~/lain-workspace` | Shared workspace (graph, seeds, MEMORY.md) |
| `QDRANT_HOST` / `QDRANT_PORT` | `localhost` / `6333` | Vector backend |
| `LAIN_LLM_BASE_URL` / `LAIN_LLM_API_KEY` / `LAIN_LLM_MODEL` / `LAIN_EMBED_MODEL` | gateway defaults | Unified LLM contract (`LAIN_LLM_*` → `AI_GATEWAY_*` → OpenAI) |
| `LAIN_REDIS_ENABLED` / `LAIN_REDIS_HOST` / `LAIN_REDIS_PORT` | `true` / `127.0.0.1` / `6379` | Cache (all paths degrade without it) |
| `LAIN_GRAPHRAG_ENABLED` / `_MAX_CONTEXT_NODES` / `_MAX_DEPTH` | `false` / `10` / `3` | GraphRAG tuning |
| `LAIN_INSTANCE_ID` | empty | Suffixes collection, graph file, Redis prefix |
| `LAIN_MIN_RECALL_SCORE` | `0.356` | Recall keep threshold |
| `LAIN_MEMORY_REAPER_ENABLED` / `_DRY_RUN` | — / `false` | Stale-memory expiry |
| `LAIN_SEED_ENABLED` / `LAIN_SEED_MAX_CHUNKS` | enabled / `10` | Seed extraction |
| `LAIN_ENABLE_PGS` | `on` | Partitioned graph search |

## API

Base `http://localhost:3341`, `Authorization: Bearer $LAIN_API_KEY` (skipped when key empty). `GET` for health/stats/nodes/metrics, `POST` otherwise. Errors: `{ error: string }`.

### Memory

| Path | Body | Description |
|------|------|-------------|
| `/api/memory/remember` | `{ text, project?, mode?, skipQualityCheck? }` | Save with conflict check (`atomic`/`bundle`/`index`/`raw`) |
| `/api/memory/recall` | `{ query, project?, limit?, cached? }` | Ranked search (`cached` = Redis-backed) |
| `/api/memory/list` | `{ project?, limit? }` | List memories |
| `/api/memory/forget` | `{ memory_id }` | Delete by ID |
| `/api/memory/add` | `{ text, project?, opts? }` | Direct add, no conflict check |
| `/api/memory/context` | `{ message, project?, charBudget?, limits? }` | Spawn-context composition |
| `/api/memory/update` | `{ id, memory, project? }` | Update preserving native ID |
| `/api/memory/consolidate` | `{ project? }` | Dedup/merge pass |
| `/api/memory/scan` | `{ project }` | Clean stale memories |
| `/api/memory/resolve-entities` | `{ threshold? }` (default `0.75`) | Entity resolution |
| `/api/memory/contradiction-scan` | `{ project? }` | Classify similar pairs, auto-delete dupes |
| `GET /api/memory/metrics` | — | In-memory counters |

```bash
curl -s localhost:3341/api/memory/remember -X POST -H 'Content-Type: application/json' \
  -d '{"text":"Lucas prefers Bun over npm for TS tooling","project":"lain"}'

curl -s localhost:3341/api/memory/recall -X POST -H 'Content-Type: application/json' \
  -d '{"query":"package manager preference","project":"lain","limit":5}'
```

Entity scheme: `lucas` → global facts, `lucas:<project>` → project-scoped.

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
