import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  heuristicKind,
  rankRecallResults,
  setMemoryFeedback,
} from './mem0.js';
import { connectRedis, getRedis, isRedisAvailable } from './redis.js';
import { newTestPoint, deleteTestPoints } from './test-points.js';

const feedbackIds: string[] = [];
const fbId = async (tag: string) => {
  const id = await newTestPoint(`rank-test-${tag}`);
  feedbackIds.push(id);
  return id;
};

beforeAll(async () => {
  await connectRedis();
  if (!isRedisAvailable()) throw new Error('Redis required for memory-ranking tests');
});

afterAll(async () => {
  await deleteTestPoints(feedbackIds).catch(() => {});
  if (!isRedisAvailable()) return;
  const r = getRedis();
  for (const id of feedbackIds) {
    await r.del(`mem0:feedback:${id}`).catch(() => {});
  }
});

describe('heuristicKind', () => {
  it('flags transient states', () => {
    expect(heuristicKind('O usuário está lendo Cioran')).toBe('state');
    expect(heuristicKind('O usuário tomou bupropiona hoje')).toBe('state');
    expect(heuristicKind('O usuário está com dor de cabeça')).toBe('state');
    expect(heuristicKind('Consulta às 14h30 na terça')).toBe('state');
  });

  it('defaults everything else to fact', () => {
    expect(heuristicKind('O usuário mora perto de um bar')).toBe('fact');
    expect(heuristicKind('O usuário tem psiquiatra pelo SUS')).toBe('fact');
    expect(heuristicKind('Na época agitada, o usuário fumava')).toBe('fact');
    expect(heuristicKind('')).toBe('fact');
  });
});

describe('rankRecallResults', () => {
  it('drops archived and ranks confirmed fact above stale state', async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const factId = await fbId('fact');
    const stateId = await fbId('state');
    const archId = await fbId('arch');

    await setMemoryFeedback(factId, { confidence: 1.0, kind: 'fact', last_confirmed_at: now });
    await setMemoryFeedback(stateId, { kind: 'state' });
    await setMemoryFeedback(archId, { status: 'archived' });

    const ranked = await rankRecallResults([
      { id: archId, memory: 'memoria arquivada', score: 0.99, created_at: now },
      { id: stateId, memory: 'o usuario esta lendo cioran', score: 0.9, created_at: twentyDaysAgo },
      { id: factId, memory: 'o usuario mora perto do bar', score: 0.6, created_at: twentyDaysAgo },
    ], 'bar cioran');

    expect(ranked.map((r) => r.id)).toEqual([factId, stateId]);
    expect(ranked[0].confidence).toBe(1.0);
    expect(ranked[0].kind).toBe('fact');
    expect(ranked[1].kind).toBe('state');
  });

  it('passes through unvoted memories with neutral defaults', async () => {
    const id = await fbId('fresh');
    const now = new Date().toISOString();
    const ranked = await rankRecallResults(
      [{ id, memory: 'fato novo', score: 0.8, created_at: now }],
      'fato novo',
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].confidence).toBe(0.5);
    expect(ranked[0].kind).toBe('fact');
    expect(ranked[0].adjustedScore).toBeGreaterThan(0);
  });
});
