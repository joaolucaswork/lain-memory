import { describe, test, expect } from 'bun:test';
import { validateRoute, parseBody, MAX_BODY_BYTES } from './http-validation.js';

// Fase 5 — contratos HTTP (puro, sem servidor/rede).

function post(body: unknown, headers: Record<string, string> = {}): Request {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('http://x/api/memory/remember', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: text,
  });
}

describe('validateRoute', () => {
  test('remember exige text; modo inválido rejeita', () => {
    expect(validateRoute('/api/memory/remember', { text: 'oi' }).ok).toBe(true);
    const missing = validateRoute('/api/memory/remember', { project: 'lain' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues[0].path).toBe('text');
    const badMode = validateRoute('/api/memory/remember', { text: 'oi', mode: 'yolo' });
    expect(badMode.ok).toBe(false);
  });

  test('limit fora do intervalo rejeita; coage string de query', () => {
    expect(validateRoute('/api/memory/recall', { query: 'x', limit: 99999 }).ok).toBe(false);
    const coerced = validateRoute('/api/memory/recall', { query: 'x', limit: '5' });
    expect(coerced.ok).toBe(true);
    if (coerced.ok) expect(coerced.data.limit).toBe(5);
  });

  test('forget exige memory_id; scan exige project', () => {
    expect(validateRoute('/api/memory/forget', {}).ok).toBe(false);
    expect(validateRoute('/api/memory/forget', { memory_id: 'abc' }).ok).toBe(true);
    expect(validateRoute('/api/memory/scan', {}).ok).toBe(false);
    expect(validateRoute('/api/memory/scan', { project: 'lain' }).ok).toBe(true);
  });

  test('remove-nodes exige ids não-vazio (máx 500)', () => {
    expect(validateRoute('/api/graph/remove-nodes', { ids: [] }).ok).toBe(false);
    expect(validateRoute('/api/graph/remove-nodes', { ids: 'x' }).ok).toBe(false);
    expect(validateRoute('/api/graph/remove-nodes', { ids: ['a'], project: 'p' }).ok).toBe(true);
  });

  test('chaves desconhecidas são removidas, rota passa', () => {
    const r = validateRoute('/api/memory/remember', { text: 'oi', hacker: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect('hacker' in r.data).toBe(false);
  });

  test('issues nunca ecoam valores recebidos (sem vazamento)', () => {
    const secret = 'sk-secreto-12345';
    const r = validateRoute('/api/memory/remember', { text: 12345, project: secret.repeat(20) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const blob = JSON.stringify(r.issues);
      expect(blob.includes(secret)).toBe(false);
      expect(blob.includes('12345')).toBe(false);
      expect(r.issues[0]).toEqual({ path: expect.any(String), message: expect.any(String) });
      expect(Object.keys(r.issues[0]).sort()).toEqual(['message', 'path']);
    }
  });

  test('rota desconhecida passa (404 é do roteador)', () => {
    expect(validateRoute('/api/nope', { a: 1 }).ok).toBe(true);
  });
});

describe('parseBody', () => {
  test('JSON válido vira objeto', async () => {
    const r = await parseBody(post({ text: 'oi' }));
    expect(r).toEqual({ ok: true, data: { text: 'oi' } });
  });

  test('JSON malformado → 400, não objeto vazio', async () => {
    const r = await parseBody(post('{invalido'));
    expect(r).toEqual({ ok: false, status: 400, error: 'invalid JSON body' });
  });

  test('corpo não-objeto (array/string) → 400', async () => {
    expect(await parseBody(post([1, 2]))).toMatchObject({ ok: false, status: 400 });
    expect(await parseBody(post('"str"'))).toMatchObject({ ok: false, status: 400 });
  });

  test('content-length acima do limite → 413 sem parsear', async () => {
    const r = await parseBody(post({ a: 1 }, { 'content-length': String(MAX_BODY_BYTES + 1) }));
    expect(r).toMatchObject({ ok: false, status: 413 });
  });

  test('corpo gigante sem content-length → 413 pelo tamanho real', async () => {
    const big = 'x'.repeat(100);
    const r = await parseBody(post({ big: big.repeat(20000) }));
    expect(r).toMatchObject({ ok: false, status: 413 });
  });
});
