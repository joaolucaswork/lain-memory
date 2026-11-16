import { describe, it, expect } from 'bun:test';
import { ageDecayScore, applyAgeDecayToResults, classifyMemoryTier, isMem0Configured } from './mem0.js';

describe('ageDecayScore', () => {
  it('returns 1.0 for a memory created right now', () => {
    const now = new Date().toISOString();
    expect(ageDecayScore(now)).toBeCloseTo(1.0, 2);
  });

  it('facts decay with 90d half-life (~0.79 at 30d)', () => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    expect(ageDecayScore(d.toISOString())).toBeCloseTo(0.79, 1);
  });

  it('facts decay with 90d half-life (~0.63 at 60d)', () => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    expect(ageDecayScore(d.toISOString())).toBeCloseTo(0.63, 1);
  });

  it('states decay with 7d half-life (~0.5 at 7d)', () => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    expect(ageDecayScore(d.toISOString(), undefined, undefined, 'state')).toBeCloseTo(0.5, 1);
  });

  it('a 20d-old state has faded (~0.14) while a fact persists (~0.86)', () => {
    const d = new Date();
    d.setDate(d.getDate() - 20);
    const iso = d.toISOString();
    expect(ageDecayScore(iso, undefined, undefined, 'state')).toBeLessThan(0.2);
    expect(ageDecayScore(iso, undefined, undefined, 'fact')).toBeGreaterThan(0.8);
  });

  it('importance >= 0.8 still protects with 180d half-life regardless of kind', () => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    const iso = d.toISOString();
    expect(ageDecayScore(iso, undefined, 0.85, 'state')).toBeCloseTo(0.71, 1);
    expect(ageDecayScore(iso, undefined, 0.5, 'state')).toBeLessThan(0.01);
  });

  it('uses updated_at over created_at when provided', () => {
    const old = new Date();
    old.setDate(old.getDate() - 60);
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);
    expect(ageDecayScore(old.toISOString(), recent.toISOString())).toBeGreaterThan(0.8);
  });

  it('clamps to 1.0 for future dates (clock skew)', () => {
    const future = new Date();
    future.setDate(future.getDate() + 5);
    expect(ageDecayScore(future.toISOString())).toBe(1.0);
  });

  it('returns 1.0 for undefined (neutral)', () => {
    expect(ageDecayScore(undefined)).toBe(1.0);
  });
});

describe('applyAgeDecayToResults', () => {
  it('boosts recent memories relative to old ones', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    const results = [
      { id: '1', memory: 'old fact', score: 0.9, created_at: old },
      { id: '2', memory: 'recent fact', score: 0.7, created_at: now },
    ];

    const adjusted = applyAgeDecayToResults(results);
    // Neutral confidence (×0.75) both sides; recency still decides.
    expect(adjusted[0].id).toBe('2');
    expect(adjusted[1].id).toBe('1');
  });

  it('preserves original order when no timestamps available', () => {
    const results = [
      { id: '1', memory: 'a', score: 0.9 },
      { id: '2', memory: 'b', score: 0.7 },
    ];
    const adjusted = applyAgeDecayToResults(results);
    expect(adjusted[0].id).toBe('1');
  });

  it('uses updated_at when available', () => {
    const veryOld = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const recentUpdate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const results = [
      { id: '1', memory: 'old but updated', score: 0.5, created_at: veryOld, updated_at: recentUpdate },
    ];
    const adjusted = applyAgeDecayToResults(results);
    expect(adjusted[0].adjustedScore).toBeGreaterThan(0.45);
  });

  it('confirmed memories keep full score, neutral ones are scaled ×0.75', () => {
    const now = new Date().toISOString();
    const results = [
      { id: '1', memory: 'confirmed', score: 0.8, created_at: now, confidence: 1.0 },
      { id: '2', memory: 'neutral', score: 0.8, created_at: now },
    ];
    const adjusted = applyAgeDecayToResults(results);
    expect(adjusted[0].id).toBe('1');
    expect(adjusted[0].adjustedScore).toBeGreaterThan(adjusted[1].adjustedScore * 1.2);
  });

  it('stale states lose to confirmed facts with lower cosine', () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const results = [
      { id: 'state', memory: 'lendo cioran', score: 0.9, created_at: twentyDaysAgo, kind: 'state' as const },
      { id: 'fact', memory: 'mora perto do bar', score: 0.6, created_at: twentyDaysAgo, kind: 'fact' as const, confidence: 1.0 },
    ];
    const adjusted = applyAgeDecayToResults(results);
    expect(adjusted[0].id).toBe('fact');
    expect(adjusted[1].id).toBe('state');
  });
});

describe('classifyMemoryTier', () => {
  it('classifies a fresh memory as hot', () => {
    const now = new Date().toISOString();
    expect(classifyMemoryTier(now, 'lain')).toBe('hot');
  });

  it('classifies a 20-day-old project memory as warm', () => {
    const d = new Date();
    d.setDate(d.getDate() - 20);
    expect(classifyMemoryTier(d.toISOString(), 'lain')).toBe('warm');
  });

  it('classifies a 45-day-old project memory as cold', () => {
    const d = new Date();
    d.setDate(d.getDate() - 45);
    expect(classifyMemoryTier(d.toISOString(), 'lain')).toBe('cold');
  });

  it('never classifies global memories as cold', () => {
    const d = new Date();
    d.setDate(d.getDate() - 200);
    expect(classifyMemoryTier(d.toISOString(), undefined)).toBe('warm');
  });

  it('returns hot for undated memories (no penalty)', () => {
    expect(classifyMemoryTier(undefined, 'lain')).toBe('hot');
  });
});

describe('relevanceBoost', () => {
  it('should export touchMemoryTimestamp and getMemoryTouchTimestamp', async () => {
    const { touchMemoryTimestamp, getMemoryTouchTimestamp } = await import('./mem0.js');
    expect(typeof touchMemoryTimestamp).toBe('function');
    expect(typeof getMemoryTouchTimestamp).toBe('function');
  });
});

describe('isMem0Configured', () => {
  it('returns true when QDRANT_HOST and LAIN_OPENAI_API_KEY are set', () => {
    const origQdrant = process.env.QDRANT_HOST;
    const origOpenai = process.env.LAIN_OPENAI_API_KEY;
    const origMem0 = process.env.MEM0_API_KEY;

    process.env.QDRANT_HOST = 'localhost';
    process.env.LAIN_OPENAI_API_KEY = 'sk-test';
    delete process.env.MEM0_API_KEY;

    expect(isMem0Configured()).toBe(true);

    // Restore
    if (origQdrant !== undefined) process.env.QDRANT_HOST = origQdrant; else delete process.env.QDRANT_HOST;
    if (origOpenai !== undefined) process.env.LAIN_OPENAI_API_KEY = origOpenai; else delete process.env.LAIN_OPENAI_API_KEY;
    if (origMem0 !== undefined) process.env.MEM0_API_KEY = origMem0; else delete process.env.MEM0_API_KEY;
  });

  it('returns false when neither QDRANT_HOST nor MEM0_API_KEY is set', () => {
    const origQdrant = process.env.QDRANT_HOST;
    const origOpenai = process.env.LAIN_OPENAI_API_KEY;
    const origMem0 = process.env.MEM0_API_KEY;

    delete process.env.QDRANT_HOST;
    delete process.env.MEM0_API_KEY;
    delete process.env.LAIN_OPENAI_API_KEY;

    expect(isMem0Configured()).toBe(false);

    if (origQdrant !== undefined) process.env.QDRANT_HOST = origQdrant;
    if (origOpenai !== undefined) process.env.LAIN_OPENAI_API_KEY = origOpenai;
    if (origMem0 !== undefined) process.env.MEM0_API_KEY = origMem0;
  });
});
