import { describe, it, expect } from 'vitest';
import { classifyVariantColors, nextTurnAfterMove } from './chesscomBoard.js';

describe('classifyVariantColors', () => {
  it('returns null for no samples', () => {
    expect(classifyVariantColors([], false)).toBeNull();
  });

  it('unflipped: higher cy group = white', () => {
    const samples = [
      { dataColor: '0', cy: 50 }, // top
      { dataColor: '0', cy: 60 },
      { dataColor: '1', cy: 450 }, // bottom
      { dataColor: '1', cy: 460 },
    ];
    expect(classifyVariantColors(samples, false)).toEqual({
      white: '1',
      black: '0',
    });
  });

  it('flipped: higher cy group = black', () => {
    const samples = [
      { dataColor: '0', cy: 50 },
      { dataColor: '1', cy: 450 },
    ];
    expect(classifyVariantColors(samples, true)).toEqual({
      white: '0',
      black: '1',
    });
  });

  it('single-group fallback maps both keys to it', () => {
    expect(classifyVariantColors([{ dataColor: 'x', cy: 10 }], false)).toEqual({
      white: 'x',
      black: 'x',
    });
  });

  it("3+ groups with a literal 'white' key picks it", () => {
    const samples = [
      { dataColor: 'white', cy: 50 },
      { dataColor: 'red', cy: 100 },
      { dataColor: 'blue', cy: 200 },
    ];
    const r = classifyVariantColors(samples, false);
    expect(r.white).toBe('white');
    expect(r.black).not.toBe('white');
  });

  it('3+ groups, no literals, numeric sort — lower = white', () => {
    const samples = [
      { dataColor: '3', cy: 50 },
      { dataColor: '1', cy: 100 },
      { dataColor: '2', cy: 200 },
    ];
    expect(classifyVariantColors(samples, false)).toEqual({
      white: '1',
      black: '2',
    });
  });

  it('skips samples with missing dataColor', () => {
    const samples = [
      { dataColor: '', cy: 10 },
      { dataColor: 'a', cy: 20 },
      { dataColor: 'b', cy: 400 },
    ];
    const r = classifyVariantColors(samples, false);
    expect(r).toEqual({ white: 'b', black: 'a' });
  });
});

describe('nextTurnAfterMove', () => {
  it('w → b', () => {
    expect(nextTurnAfterMove('w')).toBe('b');
    expect(nextTurnAfterMove('white')).toBe('b');
    expect(nextTurnAfterMove('WHITE')).toBe('b');
  });
  it('b → w', () => {
    expect(nextTurnAfterMove('b')).toBe('w');
    expect(nextTurnAfterMove('black')).toBe('w');
  });
  it('returns null for unknown / empty', () => {
    expect(nextTurnAfterMove(null)).toBeNull();
    expect(nextTurnAfterMove('')).toBeNull();
    expect(nextTurnAfterMove('red')).toBeNull();
  });
});
