#Requires -Version 5.1
<#
.SYNOPSIS
  lain-memory setup — fresh-machine installer for Windows.

  Right-click > "Run with PowerShell" or:  powershell -ExecutionPolicy Bypass -File .\setup.ps1

.DESCRIPTION
  1. checks prerequisites (bun, docker + compose)
  2. starts Qdrant + Redis (docker compose up -d) and waits for Qdrant
  3. creates .env from .env.example (never overwrites yours)
  4. creates the workspace dir (LAIN_WORKSPACE_DIR, ~ expanded)
  5. bun install
  6. smoke-tests the MCP server over stdio (expects the 12 memory tools;
     --live end-to-end write test only when an LLM key is configured)
  7. prints ready-to-paste configs for OpenCode / Claude Code / any MCP client

  Does NOT set your LLM keys (edit .env afterwards), touch git, or migrate data.
#>
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Repo

function Fail($msg) { Write-Host "setup: ERROR: $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host "setup: $msg" }

# ── 1. prerequisites ─────────────────────────────────────────────────────────
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Fail "bun not found — install from https://bun.sh (Windows: powershell -c `"irm bun.sh/install.ps1|iex`")"
}
try { docker info 2>&1 | Out-Null } catch { Fail "docker is not running — start Docker Desktop" }
try { docker compose version 2>&1 | Out-Null } catch { Fail "docker compose plugin not found" }

# ── 2. data stack ────────────────────────────────────────────────────────────
Info "starting Qdrant + Redis..."
docker compose up -d
if ($LASTEXITCODE -ne 0) { Fail "docker compose up failed" }
Info "waiting for Qdrant :6333..."
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    Invoke-RestMethod -Uri 'http://localhost:6333/collections' -TimeoutSec 2 | Out-Null
    $healthy = $true; break
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $healthy) { Fail "Qdrant did not become healthy in 60s" }
Info "Qdrant is up"

# ── 3. .env ──────────────────────────────────────────────────────────────────
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Info "created .env from .env.example — EDIT IT (workspace + LLM keys)"
} else {
  Info ".env exists — leaving untouched"
}

# ── 4. workspace dir ─────────────────────────────────────────────────────────
$wsRaw = (Select-String -Path .env -Pattern '^LAIN_WORKSPACE_DIR=' |
  Select-Object -Last 1) -replace '^LAIN_WORKSPACE_DIR=', ''
$wsRaw = $wsRaw.Trim().Trim('"').Trim("'")
if ($wsRaw.StartsWith('~/')) { $ws = Join-Path $HOME $wsRaw.Substring(2) }
elseif ($wsRaw -eq '~') { $ws = $HOME }
else { $ws = $wsRaw }
if ([string]::IsNullOrWhiteSpace($ws)) { Fail "LAIN_WORKSPACE_DIR is empty in .env" }
if (-not (Test-Path $ws)) {
  New-Item -ItemType Directory -Path $ws | Out-Null
  Info "created workspace dir $ws"
} else {
  Info "workspace dir exists: $ws"
}

# ── 5. deps ──────────────────────────────────────────────────────────────────
Info "installing dependencies..."
bun install --silent
if ($LASTEXITCODE -ne 0) { Fail "bun install failed" }

# ── 6. usable LLM key? (warn only; gates the live write-path test) ───────────
$keyOk = $false
foreach ($v in 'LAIN_LLM_API_KEY', 'AI_GATEWAY_API_KEY', 'LAIN_OPENAI_API_KEY', 'OPENAI_API_KEY') {
  $m = Select-String -Path .env -Pattern "^${v}=" | Select-Object -Last 1
  if ($m) {
    $val = ($m.Line -replace "^${v}=", '').Trim().Trim('"').Trim("'")
    if ($val -ne '' -and $val -notlike '*placeholder*') { $keyOk = $true }
  }
}

# ── 7. smoke test ────────────────────────────────────────────────────────────
Info "smoke-testing the MCP server..."
if ($keyOk) { bun run smoke:live } else { bun run smoke }
if ($LASTEXITCODE -ne 0) { Fail "MCP smoke test failed" }
if (-not $keyOk) {
  Write-Host ("setup: WARNING: no usable LLM key in .env — write-path tools " +
    "(remember/recall/seed/pgs) are unverified. Set one of LAIN_LLM_API_KEY, " +
    "AI_GATEWAY_API_KEY (+ base URL), LAIN_OPENAI_API_KEY, OPENAI_API_KEY, " +
    "then run: bun run smoke:live") -ForegroundColor Yellow
}

# ── 8. harness configs ───────────────────────────────────────────────────────
$bunBin = (Get-Command bun).Source
Write-Host @"

setup: OK — paste one of these into your harness, then restart it.

── OpenCode (%USERPROFILE%\.config\opencode\opencode.jsonc) ──
    "lain_memory": {
      "type": "local",
      "command": ["$($bunBin -replace '\\','\\')", "run", "--cwd", "$($Repo -replace '\\','\\')", "mcp"],
      "enabled": true,
      "environment": { "LAIN_WORKSPACE_DIR": "$($ws -replace '\\','\\')" },
      "timeout": 120000
    }

── Claude Code ──
    claude mcp add lain-memory --env LAIN_WORKSPACE_DIR=$ws -- $bunBin run --cwd $Repo mcp

── Any MCP client (stdio, generic JSON) ──
    { "command": "$($bunBin -replace '\\','\\')",
      "args": ["run", "--cwd", "$($Repo -replace '\\','\\')", "mcp"],
      "env": { "LAIN_WORKSPACE_DIR": "$($ws -replace '\\','\\')" } }

Tools exposed (12): remember, recall, forget, update_memory, list_memories,
scan_memories, graph_query, graph_stats, pgs_query, pgs_stats, seed_extract,
list_seeds.
HTTP API still available via: bun run dev  (health: curl localhost:3341/health)
"@
