#Requires -Version 5.1
<#
.SYNOPSIS
  lain-memory setup — fresh-machine installer for Windows.

  Right-click > "Run with PowerShell" or:  powershell -ExecutionPolicy Bypass -File .\setup.ps1 [-InstallMissing]

.DESCRIPTION
  1. checks prerequisites (bun, docker + compose) — or installs them via
     winget with -InstallMissing (needs admin for Docker Desktop)
  2. starts Qdrant + Redis (docker compose up -d) and waits for Qdrant
  3. creates .env from .env.example (never overwrites yours)
  4. creates the workspace dir (LAIN_WORKSPACE_DIR, ~ expanded)
  5. bun install
  6. smoke-tests the MCP server over stdio (expects the 12 memory tools;
     --live end-to-end write test only when an LLM key is configured)
  7. prints ready-to-paste configs for OpenCode / Claude Code / any MCP client

  Does NOT set your LLM keys (edit .env afterwards), touch git, or migrate data.
#>
param([switch]$InstallMissing)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Repo

function Fail($msg) { Write-Host "setup: ERROR: $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host "setup: $msg" }

function NeedInstallFlag($what, $manual) {
  if (-not $InstallMissing) { Fail "$what — re-run with -InstallMissing to install it automatically. Manual: $manual" }
}

function RefreshPath {
  $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

# ── 1. prerequisites ─────────────────────────────────────────────────────────
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  NeedInstallFlag "bun not found" "powershell -c `"irm bun.sh/install.ps1|iex`""
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Info "winget not found — installing bun via official script..."
    powershell -c "irm bun.sh/install.ps1|iex"
  } else {
    Info "installing bun via winget..."
    winget install -e --id Oven-sh.Bun --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Fail "winget install of bun failed" }
  }
  RefreshPath
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Fail "bun installed but not on PATH — close and reopen the terminal, then re-run"
  }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  NeedInstallFlag "docker not found" "https://docs.docker.com/desktop/setup/install/windows-install/"
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "winget not found — install Docker Desktop manually: https://docs.docker.com/desktop/setup/install/windows-install/"
  }
  Info "installing Docker Desktop via winget (needs admin, may take a while)..."
  winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { Fail "winget install of Docker Desktop failed" }
  RefreshPath
  Info "starting Docker Desktop (first launch initializes WSL2 — can take minutes)..."
  Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
}
Info "waiting for the docker daemon (start Docker Desktop if needed)..."
$daemon = $false
# NOTE: native-command failure is NOT a throwing error — must check $LASTEXITCODE.
for ($i = 0; $i -lt 60; $i++) {
  docker info 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $daemon = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $daemon) { Fail "docker daemon did not start in 5 minutes" }
docker compose version 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "docker compose plugin not found — update Docker Desktop" }

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
# NOTE: Select-String yields MatchInfo — use .Line, never the object itself.
$wsMatch = Select-String -Path .env -Pattern '^LAIN_WORKSPACE_DIR=' |
  Select-Object -Last 1
if (-not $wsMatch) { Fail "LAIN_WORKSPACE_DIR not found in .env" }
$wsRaw = ($wsMatch.Line -replace '^LAIN_WORKSPACE_DIR=', '').Trim().Trim('"').Trim("'")
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
