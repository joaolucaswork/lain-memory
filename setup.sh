#!/usr/bin/env bash
#
# lain-memory setup — fresh-machine installer.
#
#   ./setup.sh [--install-missing] [--wire [--agent <name>]... [--plan] [--yes]]
#
# What it does:
#   1. checks prerequisites (bun, docker + compose) — or installs them
#      with --install-missing (macOS: brew/curl; Debian/Ubuntu: apt/official
#      scripts; otherwise prints instructions)
#   2. starts Qdrant (docker compose up -d) and waits for Qdrant
#   3. creates .env from .env.example (never overwrites yours)
#   4. creates the workspace dir (LAIN_WORKSPACE_DIR, `~` expanded)
#   5. bun install
#   6. smoke-tests the MCP server over stdio (expects the 13 memory tools;
#      live write-path test when an LLM key is configured)
#   7. prints ready-to-paste configs for OpenCode / Claude Code / any MCP client
#   8. with --wire: writes the MCP entry into the detected agents automatically
#      (backup timestamped, idempotent, --plan previews, --yes skips prompt)
#
# What it does NOT do: set your LLM keys (edit .env afterwards), touch git,
# start process-manager services, or migrate data (see README for Qdrant snapshots).
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO"

INSTALL_MISSING=0
WIRE=0; PLAN=0; YES=0; AGENTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install-missing) INSTALL_MISSING=1 ;;
    --wire) WIRE=1 ;;
    --plan) PLAN=1 ;;
    --yes) YES=1 ;;
    --agent)
      shift; [ $# -gt 0 ] || fail "--agent needs a value (opencode|claude)"
      AGENTS="$AGENTS $1" ;;
    --agent=*) AGENTS="$AGENTS ${1#--agent=}" ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) fail "setup: unknown flag $1 (try --help)" ;;
  esac
  shift
done
if [ "$PLAN" = 1 ] && [ "$WIRE" = 0 ]; then
  fail "setup: --plan needs --wire (nothing else to preview)"
fi
for a in $AGENTS; do
  case "$a" in opencode|claude) ;; *) fail "setup: unknown --agent '$a' (use opencode|claude)" ;; esac
done

fail() { echo "setup: ERROR: $1" >&2; exit 1; }
info() { echo "setup: $1"; }
warn() { echo "setup: WARNING: $1" >&2; }
os() { uname -s; }

need_install_flag() {
  [ "$INSTALL_MISSING" = 1 ] || fail "$1 — re-run with --install-missing to install it automatically"
}

# ── 1. prerequisites ─────────────────────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
  need_install_flag "bun not found"
  info "installing bun..."
  curl -fsSL https://bun.sh/install | bash || fail "bun install failed"
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || fail "bun installed but not on PATH — restart your shell and re-run"
fi

if ! command -v docker >/dev/null 2>&1; then
  need_install_flag "docker not found"
  case "$(os)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || fail "Homebrew required for auto-install — see https://brew.sh"
      info "installing Docker Desktop (cask, may take a while)..."
      brew install --cask docker || fail "brew install --cask docker failed"
      open -a Docker || warn "installed, but could not launch Docker Desktop — start it manually"
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        info "installing Docker via get.docker.com (needs sudo)..."
        curl -fsSL https://get.docker.com | sh || fail "docker install script failed"
      else
        fail "auto-install supports apt-based distros only — install Docker from https://docs.docker.com/engine/install"
      fi
      ;;
    *) fail "auto-install supports macOS and Debian/Ubuntu only — install Docker from https://docs.docker.com/get-docker" ;;
  esac
fi
info "waiting for the docker daemon (start Docker Desktop if needed)..."
for _ in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 2
  if [ "$_" = 30 ]; then fail "docker daemon did not start in 60s"; fi
done
docker compose version >/dev/null 2>&1 || fail "docker compose plugin not found — update Docker Desktop / docker-compose-plugin"

# ── 2. data stack ────────────────────────────────────────────────────────────
info "starting Qdrant..."
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
  info "created .env from .env.example — EDIT IT (LAIN_API_KEY + workspace + LLM keys)"
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
# WHY: mesma ordem de precedência de src/llm-client.ts (LAIN_LLM_API_KEY vence;
# OPENROUTER_API_KEY/AI_GATEWAY_API_KEY/LAIN_OPENAI_API_KEY/OPENAI_API_KEY caem
# como fallback). Se adicionar uma chave nova lá, adicione aqui também.
KEY_OK=0
for v in LAIN_LLM_API_KEY OPENROUTER_API_KEY AI_GATEWAY_API_KEY LAIN_OPENAI_API_KEY OPENAI_API_KEY; do
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
  warn "no usable LLM key in .env — write-path tools (remember/recall/seed/pgs) are unverified. Set one of LAIN_LLM_API_KEY, OPENROUTER_API_KEY, AI_GATEWAY_API_KEY (+ base URL), LAIN_OPENAI_API_KEY, OPENAI_API_KEY, then run: bun run smoke:live"
fi

# ── 8. harness configs ───────────────────────────────────────────────────────
BUN_BIN="$(command -v bun)"
if [ "$WIRE" = 0 ]; then
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

Tools exposed (13): remember, recall, forget, update_memory, list_memories,
scan_memories, bundle_diario, graph_query, graph_stats, pgs_query, pgs_stats,
seed_extract, list_seeds.
HTTP API: bun run dev (health: curl -H "Authorization: Bearer \$LAIN_API_KEY" localhost:3341/api/health — /api/health exige bearer desde o multitenant)
Remoto por tenant: POST /mcp + Authorization: Bearer <chave-do-tenant> (stateless, mesma surface do stdio; minte via POST /api/tenant/mcp-token)
EOF
fi

# ── 9. wire agents (--wire) ─────────────────────────────────────────────────
# WHY: colar JSON manualmente é o estágio que o mercado abandonou — todo
# memory-MCP sério tem setup que escreve a entrada (Engram, ai-memory).
# Usa os CLIs oficiais (opencode mcp add / claude mcp add); o arquivo nunca
# é editado à mão aqui, então JSONC com comentários sobrevive intacto.
if [ "$WIRE" = 1 ]; then
WIRED_BACKUPS=""
wire_backup() { # $1 = file; copies to file.bak-TS once per run
  [ -f "$1" ] || return 0
  case " $WIRED_BACKUPS " in *" $1 "*) return 0;; esac
  cp "$1" "$1.bak-$(date +%F-%H%M%S)" || fail "cannot back up $1"
  WIRED_BACKUPS="$WIRED_BACKUPS $1"
  info "backed up $1"
}
opencode_wired() {
  opencode mcp list 2>/dev/null | grep -qE '(^|[[:space:]])(lain-memory|lain_memory)([[:space:]]|$)'
}
claude_wired() {
  # NOTE: `claude mcp get` prints "No MCP server named" on stderr and still
  # exits 0 — so merge streams before grepping, or every check reads "wired".
  ! claude mcp get lain-memory 2>&1 | grep -q "No MCP server named"
}
wire_opencode() {
  OPENCODE_JSON="$HOME/.config/opencode/opencode.jsonc"
  wire_backup "$OPENCODE_JSON"
  opencode mcp add --global lain-memory --env "LAIN_WORKSPACE_DIR=$WS" -- "$BUN_BIN" run --cwd "$REPO" mcp \
    || fail "opencode mcp add failed"
  opencode_wired || fail "opencode mcp add reported ok but lain-memory not in mcp list"
  info "opencode: lain-memory wired (global, stdio)"
}
wire_claude() {
  CLAUDE_JSON="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
  wire_backup "$CLAUDE_JSON"
  claude mcp add -s user lain-memory -e "LAIN_WORKSPACE_DIR=$WS" -- "$BUN_BIN" run --cwd "$REPO" mcp \
    || fail "claude mcp add failed"
  claude_wired || fail "claude mcp add reported ok but lain-memory not found"
  info "claude: lain-memory wired (user scope, stdio)"
}
# Plan: requested (--agent) or detected (CLI on PATH).
WIRE_PLAN=""
for a in opencode claude; do
  case " $AGENTS " in
    *" $a "*) WIRE_PLAN="$WIRE_PLAN $a:requested" ;;
    *)
      if [ -z "$AGENTS" ] && command -v "$a" >/dev/null 2>&1; then
        WIRE_PLAN="$WIRE_PLAN $a:detected"
      fi ;;
  esac
done
for a in $AGENTS; do
  command -v "$a" >/dev/null 2>&1 || fail "setup: --agent $a requested but '$a' not on PATH"
done
[ -n "$WIRE_PLAN" ] || fail "setup: --wire found no agents (need opencode and/or claude on PATH, or pass --agent)"
echo "setup: wire plan (stdio, WS=$WS):"
i=0
for entry in $WIRE_PLAN; do
  a="${entry%%:*}"; how="${entry##*:}"
  i=$((i + 1))
  if [ "$a" = opencode ] && opencode_wired; then st="already wired — skip"
  elif [ "$a" = claude ] && claude_wired; then st="already wired — skip"
  else st="will add lain-memory ($how)"
  fi
  echo "  $i. $a: $st"
done
if [ "$PLAN" = 1 ]; then echo "setup: --plan, changing nothing"; exit 0; fi
if [ "$YES" = 0 ] && [ -z "$AGENTS" ]; then
  if [ -t 0 ]; then
    printf 'setup: apply? [Y=all, numbers e.g. 1 2, n=skip]: '
    read -r ans
    case "$ans" in
      Y|y|"") ;;
      N|n) echo "setup: wiring skipped"; exit 0 ;;
      *) AGENTS="$(for n in $ans; do
            n2=0; for entry in $WIRE_PLAN; do
              n2=$((n2 + 1)); [ "$n2" = "$n" ] && echo "${entry%%:*}"
            done
          done)"
          [ -n "$AGENTS" ] || fail "setup: no valid numbers (nothing changed)" ;;
    esac
  else
    fail "setup: --wire needs --yes (or --agent) when stdin is not a terminal"
  fi
fi
for a in ${AGENTS:-opencode claude}; do
  case " $WIRE_PLAN " in *" $a:"*) ;; *) continue ;; esac
  if [ "$a" = opencode ] && opencode_wired; then info "opencode: already wired — skip"; continue; fi
  if [ "$a" = claude ] && claude_wired; then info "claude: already wired — skip"; continue; fi
  "wire_$a"
done
echo "setup: wire OK — restart the agent(s) and ask: what do you remember about this project?"
echo "NOTE: default MCP timeout applies; if remember/pgs time out, set mcp.servers.lain-memory.timeout to 120000 in opencode.jsonc"
fi
