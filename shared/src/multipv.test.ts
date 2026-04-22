import { describe, it, expect } from 'vitest';
import { formatMultiPv, formatScore } from './multipv';

describe('formatScore', () => {
  it('formats positive cp with + sign', () => {
    expect(formatScore(130)).toBe('+1.30');
  });
  it('formats negative cp without + sign', () => {
    expect(formatScore(-50)).toBe('-0.50');
  });
  it('formats mate scores', () => {
    expect(formatScore(undefined, 3)).toBe('#3');
    expect(formatScore(undefined, -2)).toBe('#-2');
  });
  it('defaults to 0.00 when no score', () => {
    expect(formatScore()).toBe('0.00');
  });
});

describe('formatMultiPv', () => {
  it('keeps only the deepest iteration per multipv index', () => {
    const r = formatMultiPv([
      { multipv: 1, depth: 10, score: 30, pv: ['e2e4'] },
      { multipv: 1, depth: 20, score: 40, pv: ['e2e4', 'e7e5'] },
      { multipv: 2, depth: 18, score: 20, pv: ['d2d4'] },
    ]);
    expect(r.length).toBe(2);
    expect(r[0].depth).toBe(20);
    expect(r[0].moves).toEqual(['e2e4', 'e7e5']);
  });

  it('sorts by multipv rank ascending', () => {
    const r = formatMultiPv([
      { multipv: 3, depth: 15, score: -10, pv: ['c2c4'] },
      { multipv: 1, depth: 15, score: 50, pv: ['e2e4'] },
      { multipv: 2, depth: 15, score: 20, pv: ['d2d4'] },
    ]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it('exposes firstMove for quick arrow rendering', () => {
    const r = formatMultiPv([{ multipv: 1, depth: 5, score: 0, pv: ['g1f3', 'g8f6'] }]);
    expect(r[0].firstMove).toBe('g1f3');
  });

  it('handles empty pv safely', () => {
    const r = formatMultiPv([{ multipv: 1, depth: 1, pv: [] }]);
    expect(r[0].firstMove).toBe('');
  });

  it('exposes raw scoreCp and mate fields', () => {
    const r = formatMultiPv([
      { multipv: 1, depth: 5, score: 50, pv: ['a'] },
      { multipv: 2, depth: 5, mate: 3, pv: ['b'] },
    ]);
    expect(r[0].scoreCp).toBe(50);
    expect(r[0].mate).toBe(null);
    expect(r[1].mate).toBe(3);
    expect(r[1].scoreCp).toBe(null);
  });
});
