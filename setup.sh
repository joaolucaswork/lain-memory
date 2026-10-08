#!/usr/bin/env bash
#
# lain-memory setup — fresh-machine installer.
#
#   ./setup.sh
#
# What it does:
#   1. checks prerequisites (bun, docker + compose)
#   2. starts Qdrant + Redis (docker compose up -d) and waits for Qdrant
#   3. creates .env from .env.example (never overwrites yours)
#   4. creates the workspace dir (LAIN_WORKSPACE_DIR, `~` expanded)
#   5. bun install
#   6. smoke-tests the MCP server over stdio (expects the 12 memory tools)
#   7. prints ready-to-paste configs for OpenCode / Claude Code / any MCP client
#
# What it does NOT do: set your LLM keys (edit .env afterwards), touch git,
# start pm2 services, or migrate data (see README for Qdrant snapshots).
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO"

fail() { echo "setup: ERROR: $1" >&2; exit 1; }
info() { echo "setup: $1"; }
warn() { echo "setup: WARNING: $1" >&2; }

# ── 1. prerequisites ─────────────────────────────────────────────────────────
command -v bun >/dev/null 2>&1 || fail "bun not found — install from https://bun.sh"
docker info >/dev/null 2>&1 || fail "docker is not running — start Docker Desktop (or dockerd)"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin not found"

# ── 2. data stack ────────────────────────────────────────────────────────────
info "starting Qdrant + Redis..."
docker compose up -d >/dev/null || fail "docker compose up failed"
info "waiting for Qdrant :6333..."
for _ in $(seq 1 30); do
  if curl -sf -m 2 localhost:6333/collections >/dev/null 2>&1; then
    info "Qdrant is up"
    break
  fi
  sleep 2
  if [ "$_" = 30 ]; then fail "Qdrant did not become healthy in 60s"; fi
done

# ── 3. .env ──────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  info "created .env from .env.example — EDIT IT (workspace + LLM keys)"
else
  info ".env exists — leaving untouched"
fi

# ── 4. workspace dir ─────────────────────────────────────────────────────────
WS_RAW="$(grep -E '^LAIN_WORKSPACE_DIR=' .env | tail -1 | cut -d= -f2- | xargs)"
WS_RAW="${WS_RAW%\"}"; WS_RAW="${WS_RAW#\"}"
WS="${WS_RAW/#\~/$HOME}"
[ -n "$WS" ] || fail "LAIN_WORKSPACE_DIR is empty in .env"
if [ ! -d "$WS" ]; then
  mkdir -p "$WS" || fail "cannot create workspace dir $WS"
  info "created workspace dir $WS"
else
  info "workspace dir exists: $WS"
fi

# ── 5. deps ──────────────────────────────────────────────────────────────────
info "installing dependencies..."
bun install --silent || fail "bun install failed"

# ── 6. usable LLM key? (warn only; gates the live write-path test) ───────────
KEY_OK=0
for v in LAIN_LLM_API_KEY AI_GATEWAY_API_KEY LAIN_OPENAI_API_KEY OPENAI_API_KEY; do
  val="$(grep -E "^${v}=" .env 2>/dev/null | tail -1 | cut -d= -f2- | xargs)"
  val="${val%\"}"; val="${val#\"}"
  case "$val" in ""|*placeholder*) ;; *) KEY_OK=1 ;; esac
done

# ── 7. smoke test ────────────────────────────────────────────────────────────
# --live proves the write path end to end (remember→recall→forget against
# real Qdrant+LLM, zero residue). Only possible with a usable LLM key.
if [ "$KEY_OK" = 1 ]; then
  info "smoke-testing the MCP server (live write path)..."
  bun run smoke:live || fail "MCP live smoke test failed"
else
  info "smoke-testing the MCP server (tool list only)..."
  bun run smoke || fail "MCP smoke test failed"
  warn "no usable LLM key in .env — write-path tools (remember/recall/seed/pgs) are unverified. Set one of LAIN_LLM_API_KEY, AI_GATEWAY_API_KEY (+ base URL), LAIN_OPENAI_API_KEY, OPENAI_API_KEY, then run: bun run smoke:live"
fi

# ── 8. harness configs ───────────────────────────────────────────────────────
BUN_BIN="$(command -v bun)"
cat <<EOF

setup: OK — paste one of these into your harness, then restart it.

── OpenCode (~/.config/opencode/opencode.jsonc) ──
    "lain_memory": {
      "type": "local",
      "command": ["$BUN_BIN", "run", "--cwd", "$REPO", "mcp"],
      "enabled": true,
      "environment": { "LAIN_WORKSPACE_DIR": "$WS" },
      "timeout": 120000
    }

── Claude Code ──
    claude mcp add lain-memory --env LAIN_WORKSPACE_DIR=$WS -- $BUN_BIN run --cwd $REPO mcp

── Any MCP client (stdio, generic JSON) ──
    { "command": "$BUN_BIN",
      "args": ["run", "--cwd", "$REPO", "mcp"],
      "env": { "LAIN_WORKSPACE_DIR": "$WS" } }

Tools exposed (12): remember, recall, forget, update_memory, list_memories,
scan_memories, graph_query, graph_stats, pgs_query, pgs_stats, seed_extract,
list_seeds.
HTTP API still available via: bun run dev  (health: curl localhost:3341/health)
EOF
