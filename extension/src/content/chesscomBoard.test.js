import { describe, it, expect } from 'vitest';
import {
  classifyVariantColors,
  nextTurnAfterMove,
  hexLuminance,
  meanFillLuminance,
  classifyVariantBoard,
} from './chesscomBoard.js';

describe('hexLuminance', () => {
  it('parses #rrggbb and #rgb', () => {
    expect(Math.round(hexLuminance('#ffffff'))).toBe(255);
    expect(Math.round(hexLuminance('#000000'))).toBe(0);
    expect(Math.round(hexLuminance('#fff'))).toBe(255);
  });
  it('returns null for junk', () => {
    expect(hexLuminance('none')).toBeNull();
    expect(hexLuminance(null)).toBeNull();
  });
});

describe('meanFillLuminance', () => {
  // Real palettes captured from the chess.com Duck variant board.
  it('white sprite (#f8f8f8 body) is lighter than black (#4e4c4b body)', () => {
    const white = meanFillLuminance(['#f8f8f8', '#fff', '#1a1a1a']);
    const black = meanFillLuminance(['#4e4c4b', '#fff', '#1a1a1a']);
    expect(white).toBeGreaterThan(black);
  });
  it('returns null when nothing parses', () => {
    expect(meanFillLuminance(['none', 'url(#x)'])).toBeNull();
    expect(meanFillLuminance([])).toBeNull();
  });
});

describe('classifyVariantBoard', () => {
  const whiteFills = ['#f8f8f8', '#fff', '#1a1a1a'];
  const blackFills = ['#4e4c4b', '#fff', '#1a1a1a'];
  const wLum = meanFillLuminance(whiteFills);
  const bLum = meanFillLuminance(blackFills);

  it('player white: white pieces at the bottom, not flipped', () => {
    const r = classifyVariantBoard([
      { dataColor: '5', lum: wLum, avgCyNorm: 0.85, count: 16 },
      { dataColor: '6', lum: bLum, avgCyNorm: 0.15, count: 16 },
    ]);
    expect(r.white).toBe('5');
    expect(r.black).toBe('6');
    expect(r.flipped).toBe(false);
    expect(r.playerColor).toBe('w');
    expect(r.confident).toBe(true);
  });

  it('player black: white pieces at the top, flipped (the reported bug)', () => {
    const r = classifyVariantBoard([
      { dataColor: '5', lum: wLum, avgCyNorm: 0.15, count: 16 },
      { dataColor: '6', lum: bLum, avgCyNorm: 0.85, count: 16 },
    ]);
    expect(r.white).toBe('5');
    expect(r.flipped).toBe(true);
    expect(r.playerColor).toBe('b');
    expect(r.confident).toBe(true);
  });

  it('not confident on a lopsided/low-piece read (so it never locks wrong)', () => {
    const r = classifyVariantBoard([
      { dataColor: '5', lum: wLum, avgCyNorm: 0.39, count: 16 },
      { dataColor: '6', lum: bLum, avgCyNorm: 0.24, count: 5 },
    ]);
    expect(r.confident).toBe(false);
  });

  it('color mapping still resolves even when not confident', () => {
    const r = classifyVariantBoard([
      { dataColor: '5', lum: wLum, avgCyNorm: 0.39, count: 16 },
      { dataColor: '6', lum: bLum, avgCyNorm: 0.24, count: 5 },
    ]);
    expect(r.white).toBe('5');
    expect(r.black).toBe('6');
  });

  it('returns null for empty input', () => {
    expect(classifyVariantBoard([])).toBeNull();
  });
});

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
