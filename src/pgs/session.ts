/**
 * PGS Session Management — Coverage tracking with JSON file persistence.
 * Tracks which partitions have been searched per session,
 * enabling continue/targeted modes for incremental coverage.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

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
