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

  it('round-trips via saveToDisk / loadFromDisk', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const file = path.join(os.tmpdir(), `evalcache-test-${Date.now()}-${Math.random()}.json`);
    try {
      const a = new EvalCache();
      a.set('f1', 'chess', 10, 1, { bestmove: 'e2e4', score: 25 });
      a.set('f2', 'chess', 12, 2, { bestmove: 'd2d4', score: 30 });
      const saved = a.saveToDisk(file);
      expect(saved).toBe(2);

      const b = new EvalCache();
      const loaded = b.loadFromDisk(file);
      expect(loaded).toBe(2);
      expect(b.get('f1', 'chess', 10, 1)).toEqual({ bestmove: 'e2e4', score: 25 });
      expect(b.get('f2', 'chess', 12, 2)).toEqual({ bestmove: 'd2d4', score: 30 });
    } finally {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  });

  it('loadFromDisk drops expired entries', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const file = path.join(os.tmpdir(), `evalcache-expire-${Date.now()}-${Math.random()}.json`);
    try {
      let t = 1_000_000;
      const a = new EvalCache({ ttlMs: 1000, now: () => t });
      a.set('fresh', 'chess', 10, 1, 'F');
      a.saveToDisk(file);
      t += 2000; // past TTL
      const b = new EvalCache({ ttlMs: 1000, now: () => t });
      const loaded = b.loadFromDisk(file);
      expect(loaded).toBe(0);
      expect(b.get('fresh', 'chess', 10, 1)).toBeNull();
    } finally {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  });

  it('loadFromDisk is a no-op if file is missing', () => {
    const c = new EvalCache();
    expect(c.loadFromDisk('/nonexistent/path/to/cache.json')).toBe(0);
    expect(c.size).toBe(0);
  });

  it('loadFromDisk handles corrupt JSON gracefully', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const file = path.join(os.tmpdir(), `evalcache-corrupt-${Date.now()}-${Math.random()}.json`);
    try {
      fs.writeFileSync(file, '{not valid json');
      const c = new EvalCache();
      expect(c.loadFromDisk(file)).toBe(0);
      expect(c.size).toBe(0);
    } finally {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  });
});
