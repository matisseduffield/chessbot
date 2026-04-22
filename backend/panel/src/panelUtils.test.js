import { describe, it, expect } from 'vitest';
import {
  escHtml,
  hexToRgb,
  lighten,
  formatScore,
  parseBoardDimensions,
  decorateMove,
  formatPVMoves,
  calculateMaterial,
  materialAdvantageHtml,
} from './panelUtils.js';

describe('escHtml', () => {
  it('escapes &, <, >, "', () => {
    expect(escHtml(`<a href="x">&lt;`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;lt;');
  });
  it("returns '' for null / undefined / empty", () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
    expect(escHtml('')).toBe('');
  });
  it('coerces non-strings', () => {
    expect(escHtml(42)).toBe('42');
  });
});

describe('hexToRgb', () => {
  it('parses pure colours', () => {
    expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('#00ff00')).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb('#0000ff')).toEqual({ r: 0, g: 0, b: 255 });
  });
  it('parses uppercase hex', () => {
    expect(hexToRgb('#ABCDEF')).toEqual({ r: 0xab, g: 0xcd, b: 0xef });
  });
});

describe('lighten', () => {
  it('amount=0 returns the input colour', () => {
    expect(lighten('#336699', 0)).toBe('#336699');
  });
  it('amount=1 returns white', () => {
    expect(lighten('#336699', 1)).toBe('#ffffff');
  });
  it('amount=0.5 is roughly halfway to white', () => {
    // (0x33 + (255-0x33)*0.5) = 0x99, etc.
    expect(lighten('#000000', 0.5)).toBe('#808080');
  });
});

describe('formatScore', () => {
  it('formats positive mate', () => {
    expect(formatScore({ mate: 3 })).toBe('+M3');
  });
  it('formats negative mate with minus-sign (U+2212)', () => {
    expect(formatScore({ mate: -4 })).toBe('−M4');
  });
  it('formats centipawn score', () => {
    expect(formatScore({ score: 123 })).toBe('+1.2');
    expect(formatScore({ score: -250 })).toBe('-2.5');
    expect(formatScore({ score: 0 })).toBe('+0.0');
  });
  it('returns ? for missing data', () => {
    expect(formatScore({})).toBe('?');
    expect(formatScore(null)).toBe('?');
  });
  it('mate=0 still formats (+M0)', () => {
    expect(formatScore({ mate: 0 })).toBe('+M0');
  });
});

describe('parseBoardDimensions', () => {
  it('defaults to 8x8 for empty input', () => {
    expect(parseBoardDimensions('')).toEqual({ files: 8, ranks: 8 });
    expect(parseBoardDimensions(null)).toEqual({ files: 8, ranks: 8 });
  });
  it('parses standard startpos', () => {
    expect(
      parseBoardDimensions('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
    ).toEqual({ files: 8, ranks: 8 });
  });
  it('parses 10x8 (Capablanca-like)', () => {
    expect(parseBoardDimensions('10/10/10/10/10/10/10/10 w - - 0 1')).toEqual({
      files: 10,
      ranks: 8,
    });
  });
  it('strips crazyhouse pocket suffix', () => {
    expect(
      parseBoardDimensions('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[PPnn] w - - 0 1'),
    ).toEqual({ files: 8, ranks: 8 });
  });
  it("ignores '+' and '~' promotion markers", () => {
    expect(parseBoardDimensions('+P+P+P+P+P+P+P+P/8 w - - 0 1').files).toBe(8);
  });
});

describe('decorateMove', () => {
  it('wraps leading piece letter with glyph span', () => {
    expect(decorateMove('Nf3')).toBe('<span class="pv-piece">\u2658</span>f3');
    expect(decorateMove('Qxd5')).toBe('<span class="pv-piece">\u2655</span>xd5');
  });
  it('leaves pawn moves untouched', () => {
    expect(decorateMove('e4')).toBe('e4');
    expect(decorateMove('exd5')).toBe('exd5');
  });
  it('leaves castling untouched (not a piece letter)', () => {
    expect(decorateMove('O-O')).toBe('O-O');
  });
});

describe('formatPVMoves', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  it('returns empty for empty moves', () => {
    expect(formatPVMoves([], startFen)).toBe('');
  });
  it("prefixes white's move with '1.'", () => {
    const html = formatPVMoves(['e4'], startFen);
    expect(html).toContain('1.');
    expect(html).toContain('e4');
    expect(html).not.toContain('1...');
  });
  it("prefixes black's first move with '1...'", () => {
    const fenBlack = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const html = formatPVMoves(['e5'], fenBlack);
    expect(html).toContain('1...');
  });
  it('increments move number after black plays', () => {
    const html = formatPVMoves(['e4', 'e5', 'Nf3'], startFen);
    expect(html).toContain('1.');
    expect(html).toContain('2.');
  });
});

describe('calculateMaterial', () => {
  it('starting position is balanced', () => {
    const m = calculateMaterial('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(m.white).toBe(m.black);
    expect(m.diff).toBe(0);
    expect(m.whitePieces.P).toBe(8);
    expect(m.blackPieces.p).toBe(8);
  });
  it('empty fen returns zeros', () => {
    expect(calculateMaterial('')).toEqual({
      white: 0,
      black: 0,
      whitePieces: {},
      blackPieces: {},
      diff: 0,
    });
  });
  it('material advantage reflected in diff', () => {
    // White is missing a queen (−9)
    const m = calculateMaterial('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1');
    expect(m.diff).toBe(-9);
  });
});

describe('materialAdvantageHtml', () => {
  it('no captures → empty string', () => {
    const html = materialAdvantageHtml({}, { p: 8, n: 2, b: 2, r: 2, q: 1 }, 'w');
    expect(html).toBe('');
  });
  it('shows captured pawns for white', () => {
    const html = materialAdvantageHtml({}, { p: 6, n: 2, b: 2, r: 2, q: 1 }, 'w');
    // 2 captured black pawns
    const count = (html.match(/\u265f/g) || []).length;
    expect(count).toBe(2);
  });
  it('shows captured pieces for black', () => {
    const html = materialAdvantageHtml({}, { P: 8, N: 1, B: 2, R: 2, Q: 1 }, 'b');
    const count = (html.match(/\u2658/g) || []).length;
    expect(count).toBe(1);
  });
});
