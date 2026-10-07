import { getRedis, isRedisAvailable } from './redis.js';
import { INSTANCE_ID } from './workspace.js';

const lockOwner = INSTANCE_ID || 'default';

export async function withDistributedLock(
  key: string,
  ttlMs: number,
  fn: () => Promise<void>
): Promise<void> {
  if (!isRedisAvailable()) { await fn(); return; }
  const redis = getRedis();
  const lockKey = `lock:${key}`;
  const acquired = await redis.set(lockKey, lockOwner, 'PX', ttlMs, 'NX');
  if (!acquired) return;
  try {
    await fn();
  } finally {
    const current = await redis.get(lockKey);
    if (current === lockOwner) await redis.del(lockKey);
  }
}
