import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { EvalCache } = require('./evalCache');

describe('EvalCache', () => {
  it('returns null on miss', () => {
    const c = new EvalCache();
    expect(c.get('fen', 'chess', 10, 1)).toBeNull();
  });

  it('returns stored value on hit', () => {
    const c = new EvalCache();
    c.set('fen', 'chess', 10, 1, { bestmove: 'e2e4' });
    expect(c.get('fen', 'chess', 10, 1)).toEqual({ bestmove: 'e2e4' });
  });

  it('distinguishes by all four dimensions', () => {
    const c = new EvalCache();
    c.set('f1', 'chess', 10, 1, 'A');
    c.set('f1', 'chess', 10, 2, 'B');
    c.set('f1', 'chess', 12, 1, 'C');
    c.set('f1', 'chess960', 10, 1, 'D');
    c.set('f2', 'chess', 10, 1, 'E');
    expect(c.get('f1', 'chess', 10, 1)).toBe('A');
    expect(c.get('f1', 'chess', 10, 2)).toBe('B');
    expect(c.get('f1', 'chess', 12, 1)).toBe('C');
    expect(c.get('f1', 'chess960', 10, 1)).toBe('D');
    expect(c.get('f2', 'chess', 10, 1)).toBe('E');
  });

  it('expires entries after TTL', () => {
    let t = 1_000_000;
    const c = new EvalCache({ ttlMs: 1000, now: () => t });
    c.set('f', 'chess', 10, 1, 'X');
    expect(c.get('f', 'chess', 10, 1)).toBe('X');
    t += 1001;
    expect(c.get('f', 'chess', 10, 1)).toBeNull();
  });

  it('evicts oldest when full', () => {
    const c = new EvalCache({ max: 3 });
    c.set('a', 'chess', 10, 1, 'A');
    c.set('b', 'chess', 10, 1, 'B');
    c.set('c', 'chess', 10, 1, 'C');
    c.set('d', 'chess', 10, 1, 'D'); // evicts A
    expect(c.get('a', 'chess', 10, 1)).toBeNull();
    expect(c.get('b', 'chess', 10, 1)).toBe('B');
    expect(c.size).toBe(3);
  });

  it('touches on get for LRU', () => {
    const c = new EvalCache({ max: 3 });
    c.set('a', 'chess', 10, 1, 'A');
    c.set('b', 'chess', 10, 1, 'B');
    c.set('c', 'chess', 10, 1, 'C');
    c.get('a', 'chess', 10, 1); // refresh A
    c.set('d', 'chess', 10, 1, 'D'); // should evict B, not A
    expect(c.get('a', 'chess', 10, 1)).toBe('A');
    expect(c.get('b', 'chess', 10, 1)).toBeNull();
  });

  it('purgeExpired removes stale entries', () => {
    let t = 1000;
    const c = new EvalCache({ ttlMs: 100, now: () => t });
    c.set('a', 'chess', 10, 1, 'A');
    t = 1050;
    c.set('b', 'chess', 10, 1, 'B');
    t = 1200; // a is expired, b still fresh? 1200-1050=150>100 — both expired
    c.purgeExpired();
    expect(c.size).toBe(0);
  });

  it('overwrites without double-counting against max', () => {
    const c = new EvalCache({ max: 2 });
    c.set('a', 'chess', 10, 1, 'A');
    c.set('a', 'chess', 10, 1, 'A2');
    c.set('b', 'chess', 10, 1, 'B');
    expect(c.size).toBe(2);
    expect(c.get('a', 'chess', 10, 1)).toBe('A2');
  });
});
