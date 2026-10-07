/**
 * Lain Workspace
 *
 * Manages the ~/lain-workspace/ directory structure.
 * All sessions, media, and memory live here (not inside the project repo).
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const INSTANCE_ID = process.env.LAIN_INSTANCE_ID ?? '';
const WORKSPACE_DIR_ENV = process.env.LAIN_WORKSPACE_DIR;
export const WORKSPACE_DIR = WORKSPACE_DIR_ENV ?? join(homedir(), 'lain-workspace');
console.log(`[workspace] WORKSPACE_DIR=${WORKSPACE_DIR} (source: ${WORKSPACE_DIR_ENV ? 'env' : 'default'})`);

// Module-load guard: if env explicitly set a path that does NOT exist, fail
// immediately. This catches stale env (e.g. dir renamed but MCP stdio process
// inherited old env from shell) before ANY mkdirSync(WORKSPACE_DIR, recursive)
// elsewhere in the codebase silently creates a phantom workspace.
// Module-level (not inside ensureWorkspace) so it covers every importer:
// notes.ts:174, task-manager.ts:56, session-store.ts:71, etc.
if (WORKSPACE_DIR_ENV && !existsSync(WORKSPACE_DIR_ENV)) {
  throw new Error(
    `[workspace] LAIN_WORKSPACE_DIR=${WORKSPACE_DIR_ENV} não existe.\n` +
    `Possíveis causas:\n` +
    `  - Diretório foi renomeado e este processo tem env stale do shell parent.\n` +
    `  - Path errado no .env do projeto.\n` +
    `Fix:\n` +
    `  - Para PM2: \`lain-restart\` (alias zsh) ou \`pm2 delete lain && pm2 start ecosystem.config.cjs --only lain\`\n` +
    `  - Para MCP stdio (Claude Code): fechar e reabrir o terminal, ou /mcp reload no Claude Code.\n`
  );
}
export const PROJECTS_BASE = process.env.LAIN_PROJECTS_BASE ?? join(homedir(), 'Documents', 'GitHub');
export const MEMORY_FILE = join(WORKSPACE_DIR, 'MEMORY.md');
export const MEMORY_DIR = join(WORKSPACE_DIR, 'memory');
export const SESSIONS_DIR = join(WORKSPACE_DIR, 'sessions');
export const MEDIA_DIR = join(WORKSPACE_DIR, '.media');
export const MEDIA_EXTRACTED_DIR = join(MEDIA_DIR, 'extracted');
export const MEDIA_MANIFEST_PATH = join(MEDIA_DIR, 'manifest.json');
export const TRANSCRIPTS_DIR = join(WORKSPACE_DIR, 'transcripts');
export const ARTIFACTS_DIR = join(WORKSPACE_DIR, '.artifacts');
export const SENTINEL_DIR = join(WORKSPACE_DIR, '.sentinel');
export const SENTINEL_PENDING_DIR = join(SENTINEL_DIR, 'pending');
export const SENTINEL_PROCESSED_DIR = join(SENTINEL_DIR, 'processed');
export const CHECKPOINTS_DIR = join(WORKSPACE_DIR, '.checkpoints');
export const KNOWLEDGE_DIR = join(WORKSPACE_DIR, '.knowledge');
export const SEEDS_DIR = join(KNOWLEDGE_DIR, 'seeds');
export const PGS_SESSIONS_DIR = join(KNOWLEDGE_DIR, 'pgs-sessions');
export const MCP_PROFILES_DIR = join(WORKSPACE_DIR, '.mcp-profiles');
export const NOTES_DIR = join(WORKSPACE_DIR, 'notes');
export const POOLS_STATE_PATH = join(WORKSPACE_DIR, 'agent-pools.json');
export const REMOTE_HOSTS_PATH = join(WORKSPACE_DIR, 'remote-hosts.json');
export const WORKSPACE_PREFS_PATH = join(WORKSPACE_DIR, '.workspace-prefs.json');
// NOTE (lain-memory port): dropped the legacy `getClaudeBin` re-export from
// cli-backend.ts (spawn machinery, stays in lain). It has zero consumers
// anywhere in the lain monorepo.

export function ensureWorkspace(): void {
  for (const dir of [
    WORKSPACE_DIR, MEMORY_DIR, SESSIONS_DIR, MEDIA_DIR, MEDIA_EXTRACTED_DIR, ARTIFACTS_DIR,
    SENTINEL_DIR, SENTINEL_PENDING_DIR, SENTINEL_PROCESSED_DIR,
    CHECKPOINTS_DIR, KNOWLEDGE_DIR, SEEDS_DIR, PGS_SESSIONS_DIR, MCP_PROFILES_DIR,
    TRANSCRIPTS_DIR, NOTES_DIR,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(MEMORY_FILE)) {
    writeFileSync(MEMORY_FILE, '# Lain Memory\n\nMemoria persistente da Lain.\n');
  }
}

export function readMemory(): string {
  try {
    return readFileSync(MEMORY_FILE, 'utf8');
  } catch {
    return '';
  }
}

export function listProjects(): Array<{ name: string; path: string }> {
  const base = process.env.LAIN_PROJECTS_BASE ?? join(homedir(), 'Documents', 'GitHub');
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter(e => {
        if (e.name.startsWith('.')) return false;
        if (e.isDirectory()) return true;
        if (e.isSymbolicLink()) {
          try { return statSync(join(base, e.name)).isDirectory(); }
          catch { return false; }
        }
        return false;
      })
      .map(e => ({ name: e.name, path: join(base, e.name) }));
  } catch {
    return [];
  }
}
