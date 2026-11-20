/**
 * PGS Session Management — Coverage tracking with JSON file persistence.
 * Tracks which partitions have been searched per session,
 * enabling continue/targeted modes for incremental coverage.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { PGS_SESSIONS_DIR } from '../workspace.js';

export interface PGSSession {
  query: string;
  mode: string;
  searchedPartitionIds: number[];
  totalPartitions: number;
  timestamp: string;
}

export class PGSSessionManager {
  private dir: string;

  constructor(sessionsDir: string) {
    this.dir = sessionsDir;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private filePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  async load(sessionId: string): Promise<PGSSession | null> {
    const path = this.filePath(sessionId);
    try {
      if (!existsSync(path)) return null;
      return await Bun.file(path).json() as PGSSession;
    } catch { return null; }
  }

  async save(sessionId: string, data: PGSSession): Promise<void> {
    await Bun.write(this.filePath(sessionId), JSON.stringify(data, null, 2));
  }
}

/**
 * LGPD wipe helper: remove every PGS session file owned by `tenant`.
 * Session files are namespaced `${tenant}` / `${tenant}_*` / `${tenant}:*`
 * (sanitized to `${tenant}_*` on disk). Returns the deletion count.
 * Never touches other tenants' files.
 */
export function deleteTenantPgsSessions(tenant: string, sessionsDir: string = PGS_SESSIONS_DIR): number {
  const t = (tenant ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!t || t === 'lucas') return 0;
  const dir = sessionsDir;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return 0;
  }
  // Manager sanitizes `:` → `_`, so `${t}:session` lives as `${t}_session.json`.
  const prefixes = [`${t}.json`, `${t}_`, `${t}-`];
  let deleted = 0;
  for (const file of files) {
    if (!prefixes.some(p => file === p || file.startsWith(p))) continue;
    try {
      unlinkSync(join(dir, file));
      deleted++;
    } catch { /* best-effort per file */ }
  }
  return deleted;
}
