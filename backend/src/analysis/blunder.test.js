import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyMove, scoreToCp, MATE_VALUE } = require('./blunder');

describe('scoreToCp', () => {
  it('returns cp for cp scores', () => {
    expect(scoreToCp({ cp: 42 })).toBe(42);
    expect(scoreToCp({ cp: -100 })).toBe(-100);
  });
  it('maps positive mate to a very large positive cp', () => {
    const v = scoreToCp({ mate: 3 });
    expect(v).toBeGreaterThan(MATE_VALUE - 100);
  });
  it('maps negative mate to a very large negative cp', () => {
    const v = scoreToCp({ mate: -3 });
    expect(v).toBeLessThan(-MATE_VALUE + 100);
  });
  it('returns null for missing / invalid input', () => {
    expect(scoreToCp(null)).toBeNull();
    expect(scoreToCp(undefined)).toBeNull();
    expect(scoreToCp({})).toBeNull();
  });
});

describe('classifyMove', () => {
  it('flags a >=200cp drop as blunder', () => {
    const r = classifyMove({ cp: 50 }, { cp: -200 });
    expect(r?.severity).toBe('blunder');
    expect(r?.drop).toBe(250);
  });

  it('flags a 100-199cp drop as mistake', () => {
    const r = classifyMove({ cp: 50 }, { cp: -80 });
    expect(r?.severity).toBe('mistake');
  });

  it('flags a 50-99cp drop as inaccuracy', () => {
    const r = classifyMove({ cp: 50 }, { cp: -10 });
    expect(r?.severity).toBe('inaccuracy');
  });

  it('does not flag tiny drops', () => {
    const r = classifyMove({ cp: 20 }, { cp: 10 });
    expect(r?.severity).toBeNull();
  });

  it('does not flag improvements', () => {
    const r = classifyMove({ cp: 20 }, { cp: 100 });
    expect(r?.severity).toBeNull();
    expect(r?.drop).toBeLessThan(0);
  });

  it('flags missed-mate as blunder', () => {
    const r = classifyMove({ mate: 2 }, { cp: 0 });
    expect(r?.severity).toBe('blunder');
  });

  it('returns null when data missing', () => {
    expect(classifyMove(null, { cp: 0 })).toBeNull();
    expect(classifyMove({ cp: 0 }, null)).toBeNull();
  });

  it('respects custom thresholds', () => {
    const r = classifyMove({ cp: 100 }, { cp: 40 }, { blunder: 50, mistake: 30, inaccuracy: 20 });
    expect(r?.severity).toBe('blunder');
  });
});
