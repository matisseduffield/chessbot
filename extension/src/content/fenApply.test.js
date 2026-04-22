import { describe, it, expect } from 'vitest';
import { applyUciMoveToBoard } from './fenApply.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('applyUciMoveToBoard', () => {
  it('plays 1.e4', () => {
    const out = applyUciMoveToBoard(START, 'e2e4');
    expect(out).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR');
  });

  it('plays 1...e5', () => {
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const out = applyUciMoveToBoard(afterE4, 'e7e5');
    expect(out).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR');
  });

  it('handles kingside castling (white)', () => {
    const pos = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
    const out = applyUciMoveToBoard(pos, 'e1g1');
    expect(out).toBe('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R4RK1');
  });

  it('handles queenside castling (black)', () => {
    const pos = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1';
    const out = applyUciMoveToBoard(pos, 'e8c8');
    expect(out).toBe('2kr3r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R');
  });

  it('handles pawn promotion', () => {
    const pos = '8/4P3/8/8/8/8/8/8 w - - 0 1';
    const out = applyUciMoveToBoard(pos, 'e7e8q');
    expect(out).toBe('4Q3/8/8/8/8/8/8/8');
  });

  it('handles black pawn promotion with lowercase piece', () => {
    const pos = '8/8/8/8/8/8/4p3/8 b - - 0 1';
    const out = applyUciMoveToBoard(pos, 'e2e1n');
    expect(out).toBe('8/8/8/8/8/8/8/4n3');
  });

  it('handles en passant capture (white)', () => {
    const pos = '8/8/8/3pP3/8/8/8/8 w - d6 0 1';
    const out = applyUciMoveToBoard(pos, 'e5d6');
    expect(out).toBe('8/8/3P4/8/8/8/8/8');
  });

  it('handles en passant capture (black)', () => {
    const pos = '8/8/8/8/3pP3/8/8/8 b - e3 0 1';
    const out = applyUciMoveToBoard(pos, 'd4e3');
    expect(out).toBe('8/8/8/8/8/4p3/8/8');
  });

  it('returns null when source square is empty', () => {
    expect(applyUciMoveToBoard(START, 'e4e5')).toBeNull();
  });

  it('returns null for malformed uci', () => {
    expect(applyUciMoveToBoard(START, 'e2')).toBeNull();
    expect(applyUciMoveToBoard(START, '')).toBeNull();
    expect(applyUciMoveToBoard('', 'e2e4')).toBeNull();
  });

  it('returns null for out-of-range squares', () => {
    // "i1" is off-board
    expect(applyUciMoveToBoard(START, 'i1i2')).toBeNull();
  });

  it('returns null for invalid FEN row count', () => {
    expect(applyUciMoveToBoard('8/8/8 w - - 0 1', 'a1a2')).toBeNull();
  });

  it('does not treat a straight pawn capture as en passant', () => {
    const pos = '8/8/8/3p4/4P3/8/8/8 w - - 0 1';
    const out = applyUciMoveToBoard(pos, 'e4d5');
    expect(out).toBe('8/8/8/3P4/8/8/8/8');
  });
});
