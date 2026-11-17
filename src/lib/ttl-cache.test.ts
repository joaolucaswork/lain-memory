import { describe, it, expect } from 'bun:test';
import { TtlCache } from './ttl-cache.js';

describe('TtlCache', () => {
  it('roundtrips a value within TTL', () => {
    const cache = new TtlCache<string>();
    cache.set('k', 'v', 60);
    expect(cache.get('k')).toBe('v');
  });

  it('expires immediately with zero TTL', () => {
    const cache = new TtlCache<string>();
    cache.set('k', 'v', 0);
    expect(cache.get('k')).toBeNull();
  });

  it('evicts the oldest entry past capacity', () => {
    const cache = new TtlCache<string>({ maxEntries: 2 });
    cache.set('a', '1', 60);
    cache.set('b', '2', 60);
    cache.set('c', '3', 60);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('3');
  });

  it('clear drops everything', () => {
    const cache = new TtlCache<number>();
    cache.set('a', 1, 60);
    cache.clear();
    expect(cache.get('a')).toBeNull();
    expect(cache.size).toBe(0);
  });
});
