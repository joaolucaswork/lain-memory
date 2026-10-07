// server/src/contradiction-detector.test.ts
import { describe, it, expect } from 'bun:test';
import { classifyMemoryAction, jaccardSimilarity, type MemoryAction } from './contradiction-detector.js';

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical texts', () => {
    expect(jaccardSimilarity('hello world foo', 'hello world foo')).toBeCloseTo(1.0);
  });

  it('returns 0.0 for completely different texts', () => {
    expect(jaccardSimilarity('the quick brown fox jumps', 'alpha beta gamma delta epsilon')).toBeCloseTo(0.0);
  });

  it('returns high similarity for near-duplicates', () => {
    const sim = jaccardSimilarity(
      'Lucas prefers dark mode in IDEs',
      'Lucas prefers dark mode in all IDEs'
    );
    expect(sim).toBeGreaterThan(0.6);
  });

  it('returns moderate similarity for overlapping texts', () => {
    const sim = jaccardSimilarity(
      'Branch crwsnxhfyfjxsjtxpeoe is used on Droplet and Vercel',
      'Branch crwsnxhfyfjxsjtxpeoe is used ONLY on Vercel'
    );
    expect(sim).toBeGreaterThan(0.3);
    expect(sim).toBeLessThan(0.85);
  });
});

describe('classifyMemoryAction', () => {
  it('returns ADD when no similar memories exist', async () => {
    const result = await classifyMemoryAction(
      'Lucas prefers dark mode in all IDEs',
      []
    );
    expect(result.action).toBe('ADD');
    expect(result.supersedes).toEqual([]);
  });

  it('returns NOOP for near-exact duplicate (via Jaccard, no LLM)', async () => {
    const result = await classifyMemoryAction(
      'Lucas prefers dark mode',
      [{ id: 'mem-1', memory: 'Lucas prefers dark mode', score: 0.99 }]
    );
    expect(result.action).toBe('NOOP');
  });
});
