import { describe, it, expect } from 'vitest';
import {
  parseTranslate,
  pieceClassToFenChar,
  translateToSquare,
  pieceCenterToSquare,
} from './lichessBoard.js';

describe('parseTranslate', () => {
  it('parses integer px', () => {
    expect(parseTranslate('translate(64px, 128px)')).toEqual({
      px: 64,
      py: 128,
    });
  });
  it('parses float px', () => {
    expect(parseTranslate('translate(64.5px, 128.25px)')).toEqual({
      px: 64.5,
      py: 128.25,
    });
  });
  it('parses negative px', () => {
    expect(parseTranslate('translate(-64px, -128px)')).toEqual({
      px: -64,
      py: -128,
    });
  });
  it('returns null for unrecognised strings', () => {
    expect(parseTranslate('')).toBeNull();
    expect(parseTranslate(undefined)).toBeNull();
    expect(parseTranslate('scale(2)')).toBeNull();
  });
});

describe('pieceClassToFenChar', () => {
  it('maps white pieces uppercase', () => {
    expect(pieceClassToFenChar('white pawn')).toBe('P');
    expect(pieceClassToFenChar('white knight')).toBe('N');
    expect(pieceClassToFenChar('white king')).toBe('K');
  });
  it('maps black pieces lowercase', () => {
    expect(pieceClassToFenChar('black queen')).toBe('q');
    expect(pieceClassToFenChar('black rook')).toBe('r');
  });
  it('returns null for no color', () => {
    expect(pieceClassToFenChar('pawn')).toBeNull();
  });
  it('returns null for no type', () => {
    expect(pieceClassToFenChar('white foo')).toBeNull();
  });
  it('returns null for empty/invalid', () => {
    expect(pieceClassToFenChar('')).toBeNull();
    expect(pieceClassToFenChar(null)).toBeNull();
  });
});

describe('translateToSquare', () => {
  const sqW = 64;
  const sqH = 64;
  it('maps top-left to file=0 rank=0 (unflipped)', () => {
    expect(translateToSquare(0, 0, sqW, sqH, false)).toEqual({
      file: 0,
      rank: 0,
    });
  });
  it('maps bottom-right to file=7 rank=7 (unflipped)', () => {
    expect(translateToSquare(7 * sqW, 7 * sqH, sqW, sqH, false)).toEqual({
      file: 7,
      rank: 7,
    });
  });
  it('flips coordinates when flipped=true', () => {
    expect(translateToSquare(0, 0, sqW, sqH, true)).toEqual({
      file: 7,
      rank: 7,
    });
  });
  it('returns null for out-of-bounds', () => {
    expect(translateToSquare(9 * sqW, 0, sqW, sqH, false)).toBeNull();
  });
  it('returns null for zero-size squares', () => {
    expect(translateToSquare(0, 0, 0, 64, false)).toBeNull();
  });
});

describe('pieceCenterToSquare', () => {
  const sqW = 64;
  const sqH = 64;
  const boardW = 512;
  const boardH = 512;
  it('maps top-left centre to a8 (file=0, rank=7) unflipped', () => {
    const s = pieceCenterToSquare(32, 32, sqW, sqH, boardW, boardH, false);
    expect(s).toEqual({ file: 0, rank: 7 });
  });
  it('maps bottom-right centre to h1 (file=7, rank=0) unflipped', () => {
    const s = pieceCenterToSquare(boardW - 32, boardH - 32, sqW, sqH, boardW, boardH, false);
    expect(s).toEqual({ file: 7, rank: 0 });
  });
  it('flipped inverts file and rank', () => {
    const s = pieceCenterToSquare(32, 32, sqW, sqH, boardW, boardH, true);
    expect(s).toEqual({ file: 7, rank: 0 });
  });
  it('returns null for pocket piece (far off-board)', () => {
    expect(pieceCenterToSquare(-100, 32, sqW, sqH, boardW, boardH, false)).toBeNull();
    expect(pieceCenterToSquare(32, boardH + 100, sqW, sqH, boardW, boardH, false)).toBeNull();
  });
  it('clamps slight overshoot within 5px tolerance', () => {
    const s = pieceCenterToSquare(-3, 32, sqW, sqH, boardW, boardH, false);
    expect(s).not.toBeNull();
    expect(s.file).toBe(0);
  });
});
