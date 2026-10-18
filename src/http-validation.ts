/**
 * HTTP contract validation — Fase 5.
 *
 * Per-route Zod schemas (allowlist, not blocklist): unknown keys are
 * stripped, wrong types / missing required fields / out-of-range values
 * are rejected with 400 BEFORE any mutation. Error issues are sanitized
 * to {path, message} — never echo received values (bodies may contain
 * secrets the caller sent).
 */

import { z } from 'zod';

/** Max request body: 1 MiB. Larger → 413 without parsing. */
export const MAX_BODY_BYTES = 1_000_000;

const project = z.string().trim().min(1).max(100).optional();
const limit = (max: number, def?: number) => {
  const s = z.coerce.number().int().min(1).max(max);
  return def !== undefined ? s.default(def).optional() : s.optional();
};
const text = (max: number) => z.string().min(1).max(max);
const textOpt = (max: number) => z.string().min(1).max(max).optional();

const entitySchema = z.object({
  name: z.string().min(1).max(500),
  type: z.string().min(1).max(50),
  description: z.string().max(10000).optional().default(''),
});
const relationshipSchema = z.object({
  subject: z.string().min(1).max(500),
  predicate: z.string().min(1).max(100),
  object: z.string().min(1).max(500),
});

export const routeSchemas: Record<string, z.ZodType> = {
  '/health': z.object({}).catchall(z.unknown()),
  '/api/health': z.object({}).catchall(z.unknown()),
  '/api/memory/remember': z.object({
    text: text(50000),
    project,
    mode: z.enum(['atomic', 'bundle', 'index', 'raw']).optional(),
    skipQualityCheck: z.boolean().optional(),
  }),
  '/api/memory/recall': z.object({
    query: text(5000),
    project,
    limit: limit(200),
    cached: z.boolean().optional(),
  }),
  '/api/memory/list': z.object({ project, limit: limit(500) }),
  '/api/memory/forget': z.object({ memory_id: z.string().min(1).max(200) }),
  '/api/memory/add': z.object({
    text: text(50000),
    project,
    opts: z.object({
      skipQualityCheck: z.boolean().optional(),
      skipConflictCheck: z.boolean().optional(),
      bundleMode: z.boolean().optional(),
      inferFalse: z.boolean().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }).optional(),
  }),
  '/api/memory/context': z.object({
    message: text(20000),
    project,
    charBudget: z.coerce.number().int().min(100).max(200000).optional(),
    limits: z.object({
      globalLimit: z.coerce.number().int().min(0).max(500).optional(),
      projectLimit: z.coerce.number().int().min(0).max(500).optional(),
      graphEnabled: z.boolean().optional(),
    }).optional(),
  }),
  '/api/memory/update': z.object({
    id: z.string().min(1).max(200),
    memory: text(50000),
    project,
  }),
  '/api/memory/consolidate': z.object({ project }),
  '/api/memory/scan': z.object({ project: z.string().trim().min(1).max(100) }),
  '/api/memory/resolve-entities': z.object({
    threshold: z.coerce.number().min(0).max(1).optional(),
    project,
  }),
  '/api/memory/contradiction-scan': z.object({ project }),
  '/api/memory/metrics': z.object({}).catchall(z.unknown()),
  '/api/graph/query': z.object({
    query: z.string().max(5000).optional().default(''),
    depth: z.coerce.number().int().min(1).max(10).optional(),
    maxNodes: z.coerce.number().int().min(1).max(200).optional(),
    project,
  }),
  '/api/graph/stats': z.object({ project }),
  '/api/graph/nodes': z.object({ project }),
  '/api/graph/remove-nodes': z.object({
    ids: z.array(z.string().min(1).max(500)).min(1).max(500),
    project,
  }),
  '/api/graph/remove-relationships': z.object({
    source: z.string().min(1).max(500),
    predicates: z.array(z.string().min(1).max(100)).max(50).optional(),
    targets: z.array(z.string().min(1).max(500)).max(500).optional(),
    project,
  }),
  '/api/graph/autoclean': z.object({}).catchall(z.unknown()),
  '/api/graph/dump': z.object({ project }),
  '/api/graph/ingest': z.object({
    entities: z.array(entitySchema).max(500).optional().default([]),
    relationships: z.array(relationshipSchema).max(1000).optional().default([]),
    project,
    sourceIds: z.array(z.string().min(1).max(200)).max(500).optional(),
  }),
  '/api/graph/sync': z.object({}).catchall(z.unknown()),
  '/api/seed/extract': z.object({
    source: z.string().min(1).max(2000),
    type: z.enum(['url', 'pdf', 'docx', 'txt', 'text']).optional(),
    rawText: z.string().max(500000).optional(),
    project,
    phone: z.string().max(50).optional(),
  }),
  '/api/seed/list': z.object({ project }),
  '/api/pgs/execute': z.object({
    query: text(5000),
    mode: z.string().max(50).optional(),
    sessionId: z.string().max(200).optional(),
    project,
  }),
  '/api/pgs/stats': z.object({ project }),
};

export interface ValidationIssue {
  path: string;
  message: string;
}

export function sanitizeIssues(zodError: z.ZodError): ValidationIssue[] {
  return zodError.issues.map(issue => ({
    path: Array.isArray(issue.path) ? issue.path.map(String).join('.') : '',
    message: issue.message,
  }));
}

export function validateRoute(
  path: string,
  data: unknown
): { ok: true; data: Record<string, any> } | { ok: false; issues: ValidationIssue[] } {
  const schema = routeSchemas[path];
  if (!schema) return { ok: true, data: (data ?? {}) as Record<string, any> };
  const parsed = schema.safeParse(data ?? {});
  if (parsed.success) return { ok: true, data: parsed.data as Record<string, any> };
  return { ok: false, issues: sanitizeIssues(parsed.error) };
}

export async function parseBody(
  req: Request
): Promise<{ ok: true; data: unknown } | { ok: false; status: 400 | 413; error: string }> {
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return { ok: false, status: 413, error: `body too large (limit ${MAX_BODY_BYTES} bytes)` };
    }
  }
  // Stream the body with byte counting: abort WITHOUT buffering when the
  // limit is exceeded, even if Content-Length is absent or lies.
  // (Byte count, not UTF-16 units — 1 MiB means 1 MiB on the wire.)
  const body = req.body;
  if (!body) {
    return { ok: false, status: 400, error: 'empty body' };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let read: Awaited<ReturnType<typeof reader.read>> | null = null;
    try {
      read = await reader.read();
    } catch {
      read = null;
    }
    if (!read) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return { ok: false, status: 400, error: 'invalid JSON body' };
    }
    if (read.done) break;
    total += read.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return { ok: false, status: 413, error: `body too large (limit ${MAX_BODY_BYTES} bytes)` };
    }
    chunks.push(read.value);
  }
  let text: string;
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON body' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON body' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }
  return { ok: true, data: raw };
}
