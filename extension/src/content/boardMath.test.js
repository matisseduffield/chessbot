import { describe, it, expect } from 'vitest';
import {
  countPieces,
  fenBoardToGrid,
  uciToSquares,
  squareTopLeft,
  squareCenter,
  detectWhoMoved,
  gridToFenBoard,
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

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR';

describe('detectWhoMoved', () => {
  it('returns "w" after white plays e4', () => {
    expect(detectWhoMoved(START, AFTER_E4)).toBe('w');
  });
  it('returns "b" after black plays e5', () => {
    expect(detectWhoMoved(AFTER_E4, AFTER_E4_E5)).toBe('b');
  });
  it('returns null when boards are identical', () => {
    expect(detectWhoMoved(START, START)).toBe(null);
  });
  it('returns null for atomic-style both-sides-disappear', () => {
    const before = 'k7/8/8/8/4P3/4p3/8/K7';
    const after = 'k7/8/8/8/8/8/8/K7';
    expect(detectWhoMoved(before, after)).toBe(null);
  });
  it('handles castling (2-piece move)', () => {
    const before = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/R3K2R';
    const after = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/R4RK1';
    expect(detectWhoMoved(before, after)).toBe('w');
  });
});

describe('gridToFenBoard', () => {
  it('round-trips the starting position', () => {
    const grid = [
      ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
      ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
      ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'],
    ];
    const fen = gridToFenBoard(grid, '');
    expect(fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });
  it('omits castling when noCastling=true', () => {
    const grid = [
      ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'],
    ];
    const fen = gridToFenBoard(grid, '', { noCastling: true });
    expect(fen).toContain(' w - -');
  });
  it('appends pocket notation for drop variants', () => {
    const grid = [
      [null, null, null, null, 'k', null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, 'K', null, null, null],
    ];
    const fen = gridToFenBoard(grid, '[PPnn]');
    expect(fen).toContain('[PPnn]');
  });
  it('compresses empty runs correctly', () => {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    grid[7][0] = 'K';
    grid[0][7] = 'k';
    const fen = gridToFenBoard(grid, '');
    expect(fen.startsWith('7k/8/8/8/8/8/8/K7')).toBe(true);
  });
});
