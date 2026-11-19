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

Pick a path. **Remote** (2 commands, no Docker/LLM key — memory lives on your
account): fastest way to a working agent.

```bash
git clone https://github.com/joaolucaswork/lain-memory && cd lain-memory
./setup.sh --remote --yes   # creates account, mints token, wires OpenCode/Claude
```

`--remote` prompts for a display name (or `--name Ana` / `--key lm_...` for an
existing account), stores the account key in `~/.config/lain/token` (`0600`),
and writes the `lain-remote` MCP entry into every detected agent
(`--agent opencode|claude` to limit, `--plan` to preview, `--server <url>` to
point elsewhere). Verify anytime: `./setup.sh --doctor --remote`.

**Local** (self-host: Docker + LLM key, data stays on your machine):

```bash
./setup.sh --wire --yes [--install-missing]   # macOS/Linux
```

- Without flags it **checks** prerequisites (Bun, Docker + Compose) and fails with instructions when missing.
- With `--install-missing` it **installs** them: Bun via the official script; Docker Desktop via Homebrew (macOS) or `get.docker.com` on apt-based Linux. Other platforms print manual steps.
- Then: starts Qdrant, creates `.env` (never overwrites) + workspace dir, `bun install`, MCP smoke test (`--live` write-path proof when an LLM key exists), and `--wire` writes the `lain-memory` MCP entry into detected agents (backup timestamped, idempotent; `--plan` previews).
- `./setup.sh --doctor` re-checks everything later with actionable errors.

Windows (PowerShell nativo):

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 [-InstallMissing]
```

`-InstallMissing` installs Bun + Docker Desktop via winget (admin needed for Docker; first launch initializes WSL2 and can take minutes). Without it, missing prerequisites fail with manual steps — same contract as the `.sh`.

Then edit `.env` (workspace dir + LLM keys) and re-run the setup script. Without keys, only `tools/list` is verified — run `bun run smoke:live` afterwards to prove the write path (remember→recall→forget, zero residue) against real Qdrant+LLM. Manual equivalent:

```bash
docker compose up -d          # Qdrant :6333
cp .env.example .env          # set LAIN_WORKSPACE_DIR + LLM keys
bun install && bun run dev    # :3341
KEY=$(grep '^LAIN_API_KEY=' .env | cut -d= -f2-)
curl -H "Authorization: Bearer $KEY" localhost:3341/api/health
bun run smoke                 # stdio MCP self-check (13 tools)
```

Supervised: `bun run start` (ou via seu process manager a partir de `ecosystem.config.cjs`).

> `LAIN_INSTANCE_ID` suffixes the Qdrant collection and graph file — instances sharing a workspace must use the same one.

## VPS deploy (Hetzner CX23 or any Ubuntu VPS)

Validated on a CX23 (2 vCPU, 4GB RAM, 40GB — €5.99/mo): Qdrant idles at ~750MiB RAM with ~380M on disk, Bun at ~150MB. No Redis — single `docker compose` service (Qdrant) + Bun on the host.

1. **SSH key first.** Create the server with your public key checked, or add it under Security → SSH keys and **Rebuild** with the key selected (unchecked = key not injected, back to password). Test: `ssh root@<ip>` with no password prompt. If the host was rebuilt, clear the stale key locally: `ssh-keygen -R <ip>`.
2. **Base.**
```bash
apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg python3 make g++ unzip
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
```
(`python3/make/g++` build a transitive native dep; `unzip` is required by the Bun installer. Ghostty users: `export TERM=xterm-256color` before using `nano`.)
3. **Code + env.**
```bash
git clone https://github.com/joaolucaswork/lain-memory.git /opt/lain-memory
cd /opt/lain-memory
cp .env.example .env   # LAIN_API_KEY=$(openssl rand -hex 32), LAIN_WORKSPACE_DIR, LLM keys
mkdir -p /root/lain-memory-workspace
```
LLM resolution: `LAIN_LLM_*` wins, `AI_GATEWAY_*` fallback, then `LAIN_OPENAI_API_KEY`. Copy the same block you use locally.
4. **Up + verify.**
```bash
docker compose up -d          # Qdrant :6333 (bound to 127.0.0.1)
bun install && bun run typecheck
bun run smoke                 # tool list; smoke:live proves remember→recall→forget
curl -s -H "Authorization: Bearer $LAIN_API_KEY" localhost:3341/health
```
5. **Service** — blue-green, sem downtime (dois slots, flip no Caddy):
```ini
# /etc/systemd/system/lain-memory.service (blue :3341) +
# /etc/systemd/system/lain-memory-green.service (green :3342, mesmo conteúdo,
# WorkingDirectory=/opt/lain-memory-green, Environment=LAIN_MEMORY_PORT=3342)
[Unit]
Description=lain-memory
After=docker.service network-online.target
Requires=docker.service
[Service]
WorkingDirectory=/opt/lain-memory
Environment=PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/root/.bun/bin/bun run src/server.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
```
Deploy (`/opt/deploy/lain-memory.sh`, via runner): atualiza o slot idle →
health-check direto na porta → flip do alias `:3340` no Caddy (`reload` gracioso)
→ drain 60s → para o antigo. O BFF e `api.<domain>` usam o alias
(`http://127.0.0.1:3340`), nunca a porta direta. Rollback:
`/opt/deploy/rollback-lain-memory.sh`. `lain-chat-web` segue o mesmo padrão
(`:3336/:3337`, `lain-chat-demo{,-green}`, drain 90s p/ SSE). `lain-slots.service`
sobe os slots live após boot (lê o Caddyfile).
6. **Firewall (Hetzner Cloud → Firewalls).** Inbound: 22 (ideally your IP only), 80, 443. Never expose 3341/6333 — both bind `127.0.0.1` already.
7. **TLS.** Point your domain's A record at the server IP and reverse-proxy `127.0.0.1:3341` with Caddy (auto-HTTPS, e.g. `api.<domain>`):
```bash
# https://caddyserver.com/docs/install#debian-ubuntu-raspbian
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
printf 'api.<domain> {\n\treverse_proxy 127.0.0.1:3341\n}\n' > /etc/caddy/Caddyfile
systemctl reload caddy
curl -s -H "Authorization: Bearer $LAIN_API_KEY" https://api.<domain>/health
```
Without a domain, keep the ports firewalled and use the bearer token over SSH tunnel.
8. **Backup.** Enable server Backups (~€1.1/mo) or snapshot before changes; Qdrant separately via the snapshot API (`POST /collections/<name>/snapshots`).

## MCP (stdio) — any harness

Native MCP server with only the memory surface (13 tools: `remember`, `recall`, `forget`, `update_memory`, `list_memories`, `scan_memories`, `bundle_diario`, `graph_query`, `graph_stats`, `pgs_query`, `pgs_stats`, `seed_extract`, `list_seeds`). In-process backends — no `:3341` hop, no session hooks (active-project / `[FLUSH:id]` were dropped; they belong to Lain's channel layer).

Transport is plain stdio (`bun run mcp`), so any MCP-compatible harness works. Wire it with `./setup.sh --wire --yes` (OpenCode via `opencode mcp add`, Claude Code via `claude mcp add`, user scope); generically:

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

The dir must exist before boot (the server refuses to start otherwise — `./setup.sh` creates it). Vector memories live separately in Qdrant (`./data/qdrant`). Caches are in-memory TTL. To start fresh, point `LAIN_WORKSPACE_DIR` at an empty dir and restart — Qdrant data is unaffected.

### Where user state lives (post-#8–#11)

| What | Where | Notes |
|------|-------|-------|
| Memory text + `lain_feedback` / `lain_importance` / `lain_relevance` payload | Qdrant (`mem0` or `mem0-${LAIN_INSTANCE_ID}`) | Authority for votes, titles, importance, extractor ratings. No TTL. |
| Forget blocklist | `$WORKSPACE/.knowledge/forget-blocklist.json` | Authority. Atomic writes. Fail-closed on read error. |
| Graph + seeds + PGS sessions | `$WORKSPACE/.knowledge/` | As above. |
| Recall cache, touch timestamps | in-memory TTL | Lost on restart, rebuilds on its own. |

`/api/memory/feedback` is fail-hard: if the vote cannot be persisted (Qdrant down, unknown id) it answers 500 instead of a silent success.

### How recall ranks

`rankRecallResults` (`src/mem0.ts`) scores every hit as:

`score = (0.5·cosine + 0.3·ageDecay + 0.2·importance) · (0.5 + 0.5·confidence) + termBoost` (capped at 1.0)

- `ageDecay = 2^(-daysOld / halfLife)`: half-life **90d** for `fact`, **7d** for `state`, **180d** when `importance >= 0.8` (confirmed-important is protected from decay). Missing/future dates decay as 1.0.
- `importance`: chat memories use the extractor (`relevance` 1–5 → 0.2 / 0.35 / 0.5 / 0.7 / 0.85); everything else uses the `scoreImportance` regex — dates, money, decision language (`decidiu`, `vai usar`), errors. No project, vendor, health, or personal bonuses; those are the extractor's job. Stored in memory-state (Qdrant `lain_importance`).
- `confidence`: 0.5 default; ✓ confirm sets 1.0 (and floors importance at 0.85). Archived memories are excluded before ranking.
- `termBoost`: up to +0.1 for exact query-term matches (terms ≥ 3 chars).
- Recalled memories get a touch timestamp (30d TTL): the next recall uses it as virtual `updated_at` (use refreshes recency) and bumps importance +0.05. `cached` recalls serve from in-memory TTL (5min); votes invalidate the cache.
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
| `LAIN_LLM_BASE_URL` / `LAIN_LLM_API_KEY` / `LAIN_LLM_MODEL` / `LAIN_EMBED_MODEL` | gateway defaults | Unified LLM contract (`LAIN_LLM_*` → `AI_GATEWAY_*` → OpenAI). `LAIN_LLM_MODEL` drives chat and Mem0 extraction (Mem0 uses the `openai_structured` provider so non-OpenAI models honor the extraction format) |

| `LAIN_GRAPHRAG_ENABLED` / `_MAX_CONTEXT_NODES` / `_MAX_DEPTH` | `false` / `10` / `3` | GraphRAG tuning |
| `LAIN_INSTANCE_ID` | empty | Suffixes collection and graph file |
| `LAIN_MIN_RECALL_SCORE` | `0.356` | Recall keep threshold |
| `LAIN_MEMORY_REAPER_ENABLED` / `_DRY_RUN` | — / `false` | Stale-memory expiry |
| `LAIN_PENDING_MERGE_ENABLED` | `false` | Auto-merge pending-review UPDATE queue in consolidate (item 2) |
| `LAIN_SEED_ENABLED` / `LAIN_SEED_MAX_CHUNKS` | enabled / `10` | Seed extraction |
| `LAIN_ENABLE_PGS` | `on` | Partitioned graph search |

## API

Base `http://localhost:3341`, `Authorization: Bearer $LAIN_API_KEY` (required). `GET` for health/stats/nodes/metrics, `POST` otherwise. Errors: `{ error: string }`.

### Memory

| Path | Body | Description |
|------|------|-------------|
| `/api/memory/remember` | `{ text, project?, mode?, assistant?, date?, skipQualityCheck? }` | Save with conflict check (`atomic`/`bundle`/`index`/`raw`). `chat` extracts durable user facts from a turn (`text` = user, `assistant` = model reply, not stored) and saves each verbatim, with a short display `title` (ideal 3, max 6 words) plus extractor-rated `relevance`/`kind`/`sensitive` (→ importance in memory-state), all in the same extractor call |
| `/api/memory/recall` | `{ query, project?, limit?, cached?, debug? }` | Ranked search (`cached` = in-memory, `debug: true` pins `adjustedScore` + `importance` on every hit). Each hit carries `adjustedScore`, `importance`, `confidence`, `last_confirmed_at`, `status`, `kind`, `title` |
| `/api/memory/list` | `{ project?, limit? }` | List memories (each item carries `confidence`, `last_confirmed_at`, `status`, `kind`, `title`) |
| `/api/memory/forget` | `{ memory_id, project }` (`global` for global scope) | Trash copy (7d undo) → hard delete → forget-blocklist |
| `/api/memory/restore` | `{ memory_id, project }` (trash copy id) | Undo a forget within 7d, only in the original scope; lifts the blocklist entry |
| `/api/memory/feedback` | `{ id, project, action: confirm\|archive\|unarchive, kind? }` | User vote, only in the requested scope: ✓ confirm (confidence 1.0 + importance floor), 🕐 archive (hidden from recall), ↩ unarchive |
| `/api/memory/add` | `{ text, project?, opts? }` | Direct add, no conflict check |
| `/api/memory/context` | `{ message, project?, charBudget?, limits? }` | Spawn-context composition |
| `/api/memory/update` | `{ id, memory, project }` | Update preserving native ID, only in the requested scope |
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

### Multitenant (MVP demo)

Tenant = namespace, not a new collection. The bearer key resolves the tenant:
master `LAIN_API_KEY` → `lucas` (legacy data byte-identical), per-tenant keys
(`lm_…`, stored hashed in `$WORKSPACE/tenants.json`, mode `0600`) →
`<tenant>` / `<tenant>:<project>`.

| Path | Auth | Body | Description |
|------|------|------|-------------|
| `POST /api/tenant/signup` | none (10/hour per IP) | `{ name }` (1–40 chars) | Creates `{ tenant, apiKey }`. Names slugify (`João` → `joao`); `lucas`/`admin`/`trash`/`global` reserved; duplicates → `409` |
| `POST /api/tenant/mcp-token` | tenant key | — | Mints a dedicated MCP token (`{ ok, tenant, apiKey }`, returned once). Current key stays valid (5-key ring); master → `400` (uses `LAIN_API_KEY` directly) |
| `POST/GET/DELETE /mcp` | tenant/MCP key | JSON-RPC | Remote MCP (Streamable HTTP, stateless, same 13-tool surface as stdio) |
| `POST` or `DELETE /api/tenant/data` | tenant key | — | LGPD wipe: every memory scope + trash, tenant graph nodes, queued graph outbox entries, tenant blocklist, project registry. Master → `403` (use forget/scan for lucas data) |

Budgets per tenant: **60 req/min** (`429` past it), **500 memories per scope**
(global or project) on the write path (`429` past it, wipe to start over).
Caches (recall, graph stats/query/PGS), the graph node scheme
(`tn-<slug>` / `tn-<slug>--<project>::name`), the forget-blocklist (one file
per tenant) and seeds are all tenant-scoped. Master unscoped reads keep the
legacy admin behavior (everything, including tenant nodes).

Not tenant-scoped (documented MVP limits): the pending-review queue and
`consolidate` (master only — `403` for tenants), background sweeps
(reaper/dedup/bundle timer run on the master scope), metrics counters,
`graph/autoclean` pattern hygiene (content-based, drops only).

```bash
# demo flow
S=$(curl -s api.lainmemo.dev/api/tenant/signup -X POST -H 'Content-Type: application/json' -d '{"name":"Ana"}')
KEY=$(echo "$S" | python3 -c 'import json,sys; print(json.load(sys.stdin)["apiKey"])')
curl -s api.lainmemo.dev/api/memory/remember -X POST -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"text":"Ana prefere café forte","mode":"raw"}'
curl -s api.lainmemo.dev/api/tenant/data -X DELETE -H "Authorization: Bearer $KEY"
```

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
  -d '{"memory_id":"<trash_id>","project":"trash"}'
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

Notes: `@qdrant/js-client-rest` pinned to `1.18.0` (`1.19` breaks `client.search`). Back up Qdrant via the **snapshot API**, not by copying `./data/qdrant` live.

Non-goals: channels, agent lifecycle, session side-effects, MCP proxying — this server owns persistence and retrieval only.
