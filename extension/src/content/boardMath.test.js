import { describe, it, expect } from 'vitest';
import {
  countPieces,
  fenBoardToGrid,
  uciToSquares,
  squareTopLeft,
  squareCenter,
  detectWhoMoved,
  detectEnPassantTarget,
  epTargetFromHighlightedSquares,
  parseDuckMove,
  DUCK_FEN_CHAR,
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

describe('detectEnPassantTarget', () => {
  it('detects e2-e4 → e3', () => {
    expect(detectEnPassantTarget(START, AFTER_E4)).toBe('e3');
  });
  it('detects e7-e5 → e6', () => {
    expect(detectEnPassantTarget(AFTER_E4, AFTER_E4_E5)).toBe('e6');
  });
  it('detects the b-file push that triggered this fix (b2-b4 → b3)', () => {
    // White pushes the b-pawn 2 squares; a black pawn on a4 should now be
    // able to capture en passant on b3.
    const before = '8/8/8/8/p7/8/1P6/8';
    const after = '8/8/8/8/pP6/8/8/8';
    expect(detectEnPassantTarget(before, after)).toBe('b3');
  });
  it('detects a single-pawn-only position (a2-a4)', () => {
    const before = '8/8/8/8/8/8/P7/8';
    const after = '8/8/8/8/P7/8/8/8';
    expect(detectEnPassantTarget(before, after)).toBe('a4'.replace('4', '3')); // a3
  });
  it('returns "-" for a one-square pawn push (e2-e3)', () => {
    const before = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
    const after = 'rnbqkbnr/pppppppp/8/8/8/4P3/PPPP1PPP/RNBQKBNR';
    expect(detectEnPassantTarget(before, after)).toBe('-');
  });
  it('returns "-" for a knight jump from b1 to c3 (different file)', () => {
    const before = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
    const after = 'rnbqkbnr/pppppppp/8/8/8/2N5/PPPPPPPP/R1BQKBNR';
    expect(detectEnPassantTarget(before, after)).toBe('-');
  });
  it('returns "-" for captures (more than one square changes)', () => {
    // Black pawn on d5 captures white pawn on e4 (cxe4 style)
    const before = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR';
    const after = 'rnbqkbnr/ppp1pppp/8/8/4p3/8/PPPP1PPP/RNBQKBNR';
    expect(detectEnPassantTarget(before, after)).toBe('-');
  });
  it('returns "-" when boards are identical', () => {
    expect(detectEnPassantTarget(START, START)).toBe('-');
  });
  it('returns "-" for empty / null input', () => {
    expect(detectEnPassantTarget('', START)).toBe('-');
    expect(detectEnPassantTarget(START, '')).toBe('-');
    expect(detectEnPassantTarget(null, null)).toBe('-');
  });
});

describe('epTargetFromHighlightedSquares', () => {
  // Helper: build a hasPawnAt that always returns true (verifies the geometry path).
  const anyPawn = () => true;
  // Helper: returns true only for the given (file, rank, color).
  const onlyPawnAt = (f, r, c) => (file, rank, color) => file === f && rank === r && color === c;

  it('detects b2-b4 → b3 from highlights', () => {
    // b2 = file 1, rank 1; b4 = file 1, rank 3
    const squares = [
      { file: 1, rank: 1 },
      { file: 1, rank: 3 },
    ];
    expect(epTargetFromHighlightedSquares(squares, onlyPawnAt(1, 3, 'w'))).toBe('b3');
  });
  it('detects b4-b2 (reversed order) → b3', () => {
    const squares = [
      { file: 1, rank: 3 },
      { file: 1, rank: 1 },
    ];
    expect(epTargetFromHighlightedSquares(squares, anyPawn)).toBe('b3');
  });
  it('detects e7-e5 → e6 (black push)', () => {
    const squares = [
      { file: 4, rank: 6 },
      { file: 4, rank: 4 },
    ];
    expect(epTargetFromHighlightedSquares(squares, onlyPawnAt(4, 4, 'b'))).toBe('e6');
  });
  it('returns "-" when no pawn at destination', () => {
    const squares = [
      { file: 1, rank: 1 },
      { file: 1, rank: 3 },
    ];
    expect(epTargetFromHighlightedSquares(squares, () => false)).toBe('-');
  });
  it('returns "-" for one-square pushes', () => {
    const squares = [
      { file: 1, rank: 1 },
      { file: 1, rank: 2 },
    ];
    expect(epTargetFromHighlightedSquares(squares, anyPawn)).toBe('-');
  });
  it('returns "-" for different files (captures, knight moves)', () => {
    const squares = [
      { file: 1, rank: 1 },
      { file: 2, rank: 3 },
    ];
    expect(epTargetFromHighlightedSquares(squares, anyPawn)).toBe('-');
  });
  it('returns "-" for moves not on the canonical pawn-push ranks', () => {
    // rank 0→2 (impossible — no pieces start on rank 1 for a 2-square push)
    const squares = [
      { file: 0, rank: 0 },
      { file: 0, rank: 2 },
    ];
    expect(epTargetFromHighlightedSquares(squares, anyPawn)).toBe('-');
  });
  it('returns "-" for wrong-shape input', () => {
    expect(epTargetFromHighlightedSquares([], anyPawn)).toBe('-');
    expect(epTargetFromHighlightedSquares([{ file: 1, rank: 1 }], anyPawn)).toBe('-');
    expect(epTargetFromHighlightedSquares(null, anyPawn)).toBe('-');
  });
  it('returns "-" when hasPawnAt is not a function', () => {
    const squares = [
      { file: 1, rank: 1 },
      { file: 1, rank: 3 },
    ];
    expect(epTargetFromHighlightedSquares(squares, null)).toBe('-');
  });
});

describe('parseDuckMove', () => {
  it('splits a comma-separated compound move', () => {
    expect(parseDuckMove('e2e4,d6')).toEqual({ pieceMove: 'e2e4', duckTo: 'd6' });
  });
  it('splits a space-separated compound move', () => {
    expect(parseDuckMove('e2e4 d6')).toEqual({ pieceMove: 'e2e4', duckTo: 'd6' });
  });
  it('splits a concatenated compound move', () => {
    expect(parseDuckMove('e2e4d6')).toEqual({ pieceMove: 'e2e4', duckTo: 'd6' });
  });
  it('keeps a promotion on the chess move and splits the duck square', () => {
    expect(parseDuckMove('e7e8q,a3')).toEqual({ pieceMove: 'e7e8q', duckTo: 'a3' });
  });
  it('returns duckTo null for a plain move', () => {
    expect(parseDuckMove('e2e4')).toEqual({ pieceMove: 'e2e4', duckTo: null });
  });
  it('handles empty / malformed input', () => {
    expect(parseDuckMove('')).toEqual({ pieceMove: null, duckTo: null });
    expect(parseDuckMove(null)).toEqual({ pieceMove: null, duckTo: null });
  });
});

describe('DUCK_FEN_CHAR serialization', () => {
  it('gridToFenBoard emits the duck char as a piece', () => {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    grid[7][4] = 'K';
    grid[0][4] = 'k';
    grid[3][3] = DUCK_FEN_CHAR; // duck on d5
    const fen = gridToFenBoard(grid, '', { noCastling: true });
    expect(fen.split(' ')[0]).toBe('4k3/8/8/3*4/8/8/8/4K3');
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
