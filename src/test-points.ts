/**
 * Qdrant test-point helper (issue #8).
 *
 * Provisions REAL points in the mem0 collection via direct upsert (dummy
 * vector, no LLM/embedder needed) so memory-state has something to attach
 * feedback/importance to. Points use `user_id: 'test-probe'` so they never
 * leak into real `getMemories`/`searchMemory` results (those filter
 * `user_id = lucas`); they are only ever read by id.
 */
import { randomUUID } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { INSTANCE_ID } from './workspace.js';

export const TEST_COLLECTION = INSTANCE_ID ? `mem0-${INSTANCE_ID}` : 'mem0';

let _client: QdrantClient | null = null;
let _dim = 0;

export function testQdrant(): QdrantClient {
  if (!_client) {
    _client = new QdrantClient({
      host: process.env.QDRANT_HOST || 'localhost',
      port: parseInt(process.env.QDRANT_PORT || '6333', 10),
      checkCompatibility: false,
    });
  }
  return _client;
}

async function testVectorSize(): Promise<number> {
  if (_dim > 0) return _dim;
  try {
    const coll = (await testQdrant().getCollection(TEST_COLLECTION)) as unknown as {
      config?: { params?: { vectors?: { size?: number } | Record<string, { size?: number }> } };
    };
    const v = coll?.config?.params?.vectors;
    _dim = typeof (v as { size?: number })?.size === 'number'
      ? (v as { size: number }).size
      : (Object.values((v ?? {}) as Record<string, { size?: number }>)[0]?.size ?? 1536) as number;
  } catch {
    _dim = 1536;
  }
  return _dim;
}

/** Insert a real point and return its id (tracked by the caller for cleanup). */
export async function newTestPoint(prefix = 'test'): Promise<string> {
  const id = randomUUID();
  const size = await testVectorSize();
  await testQdrant().upsert(TEST_COLLECTION, {
    points: [{
      id,
      vector: new Array(size).fill(0.05),
      payload: { data: `${prefix} ${id}`, user_id: 'test-probe' },
    }],
  });
  return id;
}

/** Best-effort cleanup of provisioned points. Never throws. */
export async function deleteTestPoints(ids: string[]): Promise<void> {
  const valid = ids.filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (valid.length === 0) return;
  try {
    await testQdrant().delete(TEST_COLLECTION, { points: valid });
  } catch { /* best-effort */ }
}
