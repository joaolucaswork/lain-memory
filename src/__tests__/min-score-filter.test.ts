import { describe, it, expect } from 'bun:test';

const { applyMinScoreFilter, resolveMinRecallScore, DEFAULT_MIN_RECALL_SCORE } = await import('../mem0.js');

// ── AC-8: applyMinScoreFilter pure-function contract ─────────────────────────

describe('applyMinScoreFilter', () => {
  it('returns all results when minScore is 0 (filter disabled)', () => {
    const results = [
      { id: '1', memory: 'a', score: 0.1 },
      { id: '2', memory: 'b', score: 0.5 },
      { id: '3', memory: 'c', score: 0.9 },
    ];
    expect(applyMinScoreFilter(results, 0)).toEqual(results);
  });

  it('returns all results when minScore is negative (filter disabled)', () => {
    const results = [{ id: '1', memory: 'a', score: 0.0 }];
    expect(applyMinScoreFilter(results, -1)).toEqual(results);
  });

  it('drops results below threshold and keeps at-threshold and above', () => {
    const results = [
      { id: '1', memory: 'low',  score: 0.30 },
      { id: '2', memory: 'at',   score: 0.45 },
      { id: '3', memory: 'high', score: 0.55 },
    ];
    const filtered = applyMinScoreFilter(results, 0.45);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(r => r.score)).toEqual([0.45, 0.55]);
  });

  it('keeps result scored exactly at threshold (>= semantics)', () => {
    const results = [{ id: '1', memory: 'exact', score: 0.45 }];
    expect(applyMinScoreFilter(results, 0.45)).toHaveLength(1);
  });

  it('returns empty array when all results are below threshold', () => {
    const results = [
      { id: '1', memory: 'a', score: 0.1 },
      { id: '2', memory: 'b', score: 0.2 },
    ];
    expect(applyMinScoreFilter(results, 0.5)).toEqual([]);
  });

  it('handles results with missing score (treated as 0)', () => {
    const results = [
      { id: '1', memory: 'no-score' },
      { id: '2', memory: 'has-score', score: 0.6 },
    ];
    const filtered = applyMinScoreFilter(results, 0.5);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].memory).toBe('has-score');
  });

  it('returns empty array when input is empty', () => {
    expect(applyMinScoreFilter([], 0.45)).toEqual([]);
  });
});

// ── AC-9: resolveMinRecallScore env-controlled threshold ──────────────────────

describe('searchMemory — min-score threshold', () => {
  it('DEFAULT_MIN_RECALL_SCORE is the calibrated threshold (0.356)', () => {
    expect(DEFAULT_MIN_RECALL_SCORE).toBe(0.356);
  });

  it('applies calibrated default when LAIN_MIN_RECALL_SCORE env is not set', () => {
    const result = resolveMinRecallScore({});
    expect(result).toBe(DEFAULT_MIN_RECALL_SCORE);
  });

  it('uses env override when LAIN_MIN_RECALL_SCORE is set', () => {
    const result = resolveMinRecallScore({ LAIN_MIN_RECALL_SCORE: '0.45' });
    expect(result).toBe(0.45);
  });

  it('disables filter when LAIN_MIN_RECALL_SCORE is set to 0', () => {
    const result = resolveMinRecallScore({ LAIN_MIN_RECALL_SCORE: '0' });
    expect(result).toBe(0);
  });
});
