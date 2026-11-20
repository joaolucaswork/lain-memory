/**
 * File I/O Lock — Per-file async mutex to prevent race conditions.
 *
 * Provides:
 * - withFileLock: serialize async operations per file path
 * - safeWriteFileSync: atomic write via temp file + rename
 * - safeReadFileSync: graceful error handling on read
 */

import { writeFileSync, readFileSync, renameSync, unlinkSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

// ─── Per-file async mutex ───

/** Map from filePath → chain of pending promises (the lock queue) */
const lockMap = new Map<string, Promise<void>>();

/**
 * Acquire an exclusive async lock for filePath, run fn(), then release.
 * Concurrent callers queue up and execute one at a time, in order.
 */
export function withFileLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  // Chain onto any existing lock for this path. `cur` resolves only after
  // THIS holder's fn() settles, so queued callers truly serialize async work.
  const prev = lockMap.get(filePath) ?? Promise.resolve();

  let releaseLock!: () => void;
  const cur = new Promise<void>(resolve => { releaseLock = resolve; });
  lockMap.set(filePath, prev.then(() => cur));

  const result = (async () => {
    await prev;
    try {
      return await fn();
    } finally {
      releaseLock();
      // Clean up map if nothing queued behind us.
      if (lockMap.get(filePath)) {
        // Peek: if the stored tail already resolved, no one is waiting.
        // We cannot synchronously know — chain a cleanup that only deletes
        // when the tail is still ours.
        const tail = lockMap.get(filePath)!;
        void tail.then(() => {
          // If no newer tail replaced us, drop the entry.
          if (lockMap.get(filePath) === tail) lockMap.delete(filePath);
        });
      }
    }
  })();

  return result;
}

// ─── Atomic write via temp file + rename ───

/**
 * Write data to filePath atomically: write to a temp file in the same directory,
 * then rename() to the target. This prevents partial writes or torn reads.
 */
export function safeWriteFileSync(filePath: string, data: string, mode?: number): void {
  const dir = dirname(filePath);
  const tmpSuffix = randomBytes(6).toString('hex');
  const tmpPath = join(dir, `.tmp-${tmpSuffix}`);
  try {
    writeFileSync(tmpPath, data, { encoding: 'utf8', mode: mode ?? 0o644 });
    renameSync(tmpPath, filePath);
    if (mode) chmodSync(filePath, mode);
  } catch (err) {
    // Clean up temp file if rename failed
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

// ─── Graceful read ───

/**
 * Read filePath as UTF-8 string. Returns null on any error (missing file, permission, etc.)
 * instead of throwing.
 */
export function safeReadFileSync(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
