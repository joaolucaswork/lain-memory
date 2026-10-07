/**
 * Redis connection manager for Lain.
 *
 * Provides a singleton Redis client with graceful fallback.
 * All consumers should check `isRedisAvailable()` before using Redis
 * and fall back to in-memory when Redis is unavailable.
 *
 * Config via env:
 *   LAIN_REDIS_HOST     (default: 127.0.0.1)
 *   LAIN_REDIS_PORT     (default: 6379)
 *   LAIN_REDIS_PASSWORD (default: none)
 *   LAIN_REDIS_ENABLED  (default: true — set to "false" to disable)
 */

import Redis from 'ioredis';
import { errMsg } from './lib/err.js';
import { INSTANCE_ID } from './workspace.js';

let _redis: Redis | null = null;

export function isRedisEnabled(): boolean {
  const val = process.env.LAIN_REDIS_ENABLED;
  return val !== 'false' && val !== '0';
}

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      host: process.env.LAIN_REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.LAIN_REDIS_PORT || '6379'),
      password: process.env.LAIN_REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      keyPrefix: INSTANCE_ID ? `lain:${INSTANCE_ID}:` : 'lain:',
      retryStrategy(times) {
        if (times > 5) return null; // stop retrying after 5 attempts
        return Math.min(times * 200, 2000);
      },
    });
    _redis.on('error', (err) => {
      console.error('[redis] connection error:', err.message);
    });
  }
  return _redis;
}

export function isRedisAvailable(): boolean {
  return _redis?.status === 'ready';
}

export async function connectRedis(): Promise<boolean> {
  if (!isRedisEnabled()) {
    console.log('[redis] disabled via LAIN_REDIS_ENABLED=false');
    return false;
  }
  try {
    const redis = getRedis();
    await redis.connect();
    console.log('[redis] connected');
    return true;
  } catch (err: unknown) {
    console.warn('[redis] not available, using fallback:', errMsg(err));
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
    console.log('[redis] disconnected');
  }
}
