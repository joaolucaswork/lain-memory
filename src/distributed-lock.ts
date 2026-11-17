/**
 * Single-instance lock (no-op wrapper).
 * WHY: after Redis removal there is no cross-process mutex. The maintenance,
 * graph and outbox sweeps already run in-process; keep the call sites unchanged
 * so a future Upstash/distributed lock can be swapped back locally.
 */
import { INSTANCE_ID } from './workspace.js';

const lockOwner = INSTANCE_ID || 'default';
void lockOwner;

export async function withDistributedLock(
  key: string,
  ttlMs: number,
  fn: () => Promise<void>
): Promise<void> {
  void key;
  void ttlMs;
  await fn();
}
