import { describe, expect, test } from 'bun:test';
import { formatRememberResult } from './mcp.js';

// Bug: MCP remember respondia "Remembered ... Memory saved." para extração
// vazia (Mem0 não produziu átomos) — sucesso silencioso, nada persistido.

describe('formatRememberResult', () => {
  test('extração vazia nunca lê como sucesso', () => {
    const out = formatRememberResult([], 'probe');
    expect(out).toMatch(/^Nothing saved/);
    expect(out).toContain('mode:raw');
    expect(out).not.toContain('Remembered');
  });

  test('duplicata e rejeição preservam as mensagens antigas', () => {
    expect(formatRememberResult(
      [{ id: 'duplicate', memory: 'x', conflictsWith: [{ id: 'abc', score: 0.9 }] }], 'p',
    )).toBe('Memory skipped — conflicts with: abc (sim 0.90)');
    expect(formatRememberResult([{ id: 'duplicate', memory: 'x' }], 'p'))
      .toBe('Memory skipped — duplicate of existing memory.');
    expect(formatRememberResult([{ id: 'rejected', memory: 'x', reason: 'ruim' }], 'p'))
      .toBe('Memory rejected — reason: ruim');
    expect(formatRememberResult([{ id: 'rejected', memory: 'x' }], 'p'))
      .toBe('Memory rejected — reason: quality below threshold');
  });

  test('salvo de verdade mantém o formato', () => {
    expect(formatRememberResult([{ id: 'a1', memory: 'oi' }], 'p'))
      .toBe('Remembered [p]:\n- oi (id: a1)');
    expect(formatRememberResult([{ id: 'a1', memory: 'oi' }]))
      .toBe('Remembered [global]:\n- oi (id: a1)');
  });
});
