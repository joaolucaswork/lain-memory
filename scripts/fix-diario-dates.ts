#!/usr/bin/env bun
/**
 * Fix diario copy dates: set Qdrant payload createdAt/updatedAt back to the
 * original global memory dates (from /tmp/mem-global.json pre-migration dump).
 * Idempotent — only touches lucas:diario points that carry original_id metadata.
 */
import { readFileSync } from 'fs';

const QDRANT = `http://${process.env.QDRANT_HOST || 'localhost'}:${process.env.QDRANT_PORT || '6333'}`;
const COLLECTION = 'mem0';

const dump = JSON.parse(readFileSync('/tmp/mem-global.json', 'utf8'));
const origById = new Map(dump.map((m: any) => [m.id, m]));

async function scrollDiario(): Promise<any[]> {
  const out: any[] = [];
  let offset: unknown = undefined;
  while (true) {
    const body: any = {
      filter: { must: [{ key: 'user_id', match: { value: 'lucas:diario' } }] },
      limit: 100,
      with_payload: true,
    };
    if (offset !== undefined) body.offset = offset;
    const res = await fetch(`${QDRANT}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`scroll → ${res.status}`);
    const j = await res.json();
    out.push(...(j.result.points ?? []));
    offset = j.result.next_page_offset;
    if (!offset) break;
  }
  return out;
}

const points = await scrollDiario();
console.log(`diario points: ${points.length}`);
let fixed = 0, missing = 0, failed = 0;
for (const pt of points) {
  const oid = pt.payload?.original_id;
  const orig = oid ? origById.get(oid) : undefined;
  if (!orig?.created_at) { missing++; continue; }
  const payload: Record<string, unknown> = {
    createdAt: orig.created_at,
    original_created_at: orig.created_at,
  };
  if (orig.updated_at) {
    payload.updatedAt = orig.updated_at;
    payload.original_updated_at = orig.updated_at;
  }
  try {
    const res = await fetch(`${QDRANT}/collections/${COLLECTION}/points/payload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, points: [pt.id], wait: true }),
    });
    if (!res.ok) throw new Error(`set_payload → ${res.status}`);
    fixed++;
  } catch (e) {
    console.error(`FAILED ${String(pt.id).slice(0, 8)}:`, e instanceof Error ? e.message : e);
    failed++;
  }
}
console.log(`DONE fixed=${fixed} missing_orig=${missing} failed=${failed}`);
