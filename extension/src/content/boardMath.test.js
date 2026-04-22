import { describe, it, expect } from 'vitest';
import {
  countPieces,
  fenBoardToGrid,
  uciToSquares,
  squareTopLeft,
  squareCenter,
} from './boardMath.js';

describe('countPieces', () => {
  it('counts pieces in the starting position', () => {
    expect(countPieces('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR')).toBe(32);
  });
  it('ignores slashes and digits', () => {
    expect(countPieces('8/8/8/4k3/8/8/8/4K3')).toBe(2);
  });
  it('strips crazyhouse pocket notation', () => {
    expect(countPieces('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[PPnn]')).toBe(32);
  });
  it('ignores shogi-style promotion markers', () => {
    expect(countPieces('+P+p/8/8/8/8/8/8/8')).toBe(2);
  });
  it('handles empty / falsy input', () => {
    expect(countPieces('')).toBe(0);
    expect(countPieces(null)).toBe(0);
  });
});

describe('fenBoardToGrid', () => {
  it('expands the starting FEN into 8 ranks of 8 squares', () => {
    const g = fenBoardToGrid('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
    expect(g.length).toBe(8);
    expect(g[0].length).toBe(8);
    expect(g[0][0]).toBe('r');
    expect(g[7][4]).toBe('K');
    expect(g[3][0]).toBe(null);
  });
  it('strips pocket notation', () => {
    const g = fenBoardToGrid('8/8/8/8/8/8/8/8[PP]');
    expect(g[0]).toEqual([null, null, null, null, null, null, null, null]);
  });
  it('handles multi-digit empties', () => {
    const g = fenBoardToGrid('10/8/8/8/8/8/8/8');
    expect(g[0].length).toBe(10);
  });
});

describe('uciToSquares', () => {
  it('parses e2e4', () => {
    expect(uciToSquares('e2e4')).toEqual({
      from: { file: 4, rank: 1 },
      to: { file: 4, rank: 3 },
    });
  });
  it('parses a promotion (trailing q accepted but ignored)', () => {
    const r = uciToSquares('e7e8q');
    expect(r?.to).toEqual({ file: 4, rank: 7 });
  });
  it('parses crazyhouse drop P@e4', () => {
    const r = uciToSquares('P@e4');
    expect(r).toEqual({ from: null, to: { file: 4, rank: 3 }, drop: 'P' });
  });
  it('returns null for garbage', () => {
    expect(uciToSquares('')).toBe(null);
    expect(uciToSquares('zz')).toBe(null);
    expect(uciToSquares('xxxx')).toBe(null);
  });
  it('supports multi-digit ranks (10x10 variant)', () => {
    const r = uciToSquares('a10b10');
    expect(r?.from).toEqual({ file: 0, rank: 9 });
    expect(r?.to).toEqual({ file: 1, rank: 9 });
  });
});

describe('squareTopLeft / squareCenter', () => {
  it('a1 (white POV) is bottom-left', () => {
    expect(squareTopLeft(0, 0, 100, false)).toEqual({ x: 0, y: 700 });
  });
  it('h8 (white POV) is top-right', () => {
    expect(squareTopLeft(7, 7, 100, false)).toEqual({ x: 700, y: 0 });
  });
  it('flipped board mirrors both axes', () => {
    expect(squareTopLeft(0, 0, 100, true)).toEqual({ x: 700, y: 0 });
    expect(squareTopLeft(7, 7, 100, true)).toEqual({ x: 0, y: 700 });
  });
  it('squareCenter is offset by sqSize/2', () => {
    expect(squareCenter(0, 0, 100, false)).toEqual({ x: 50, y: 750 });
  });
});
