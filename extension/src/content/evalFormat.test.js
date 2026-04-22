import { describe, it, expect } from 'vitest';
import { formatScore, isLineLosing } from './evalFormat.js';

describe('formatScore', () => {
  it('renders small positive cp with one decimal and + sign', () => {
    expect(formatScore({ score: 80 })).toBe('+0.8');
  });

  it('renders zero eval with + sign', () => {
    expect(formatScore({ score: 0 })).toBe('+0.0');
  });

  it('renders negative cp with real minus (no explicit + sign)', () => {
    expect(formatScore({ score: -234 })).toBe('-2.3');
  });

  it('renders mate-for with +M', () => {
    expect(formatScore({ mate: 4 })).toBe('+M4');
  });

  it('renders mate-against with a Unicode minus and M', () => {
    expect(formatScore({ mate: -2 })).toBe('\u2212M2');
  });

  it('mate takes precedence over score', () => {
    expect(formatScore({ score: 50, mate: 1 })).toBe('+M1');
  });

  it('returns ? when nothing is known', () => {
    expect(formatScore({})).toBe('?');
    expect(formatScore(/** @type {any} */ (null))).toBe('?');
  });

  it('ignores score=null / mate=null', () => {
    expect(formatScore({ score: null, mate: null })).toBe('?');
  });
});

describe('isLineLosing', () => {
  it('mate-for is not losing', () => {
    expect(isLineLosing({ mate: 3 })).toBe(false);
  });

  it('mate-against is losing', () => {
    expect(isLineLosing({ mate: -1 })).toBe(true);
  });

  it('score below -50 cp is losing', () => {
    expect(isLineLosing({ score: -120 })).toBe(true);
  });

  it('score at -50 cp is not yet losing (strict <)', () => {
    expect(isLineLosing({ score: -50 })).toBe(false);
  });

  it('positive cp is not losing', () => {
    expect(isLineLosing({ score: 30 })).toBe(false);
  });

  it('empty or null line is not losing', () => {
    expect(isLineLosing({})).toBe(false);
    expect(isLineLosing(/** @type {any} */ (null))).toBe(false);
  });
});
