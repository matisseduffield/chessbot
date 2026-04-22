import { describe, it, expect } from 'vitest';
import { isKingInCheck } from './threeCheck.js';

describe('isKingInCheck', () => {
  it('returns false for the starting position', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
    expect(isKingInCheck(start, 'w')).toBe(false);
    expect(isKingInCheck(start, 'b')).toBe(false);
  });

  it('detects a rook check on the e-file', () => {
    // Black rook on e8, white king on e1, clear file
    const fen = '4r3/8/8/8/8/8/8/4K3';
    expect(isKingInCheck(fen, 'w')).toBe(true);
  });

  it('rook check blocked by own piece is not a check', () => {
    const fen = '4r3/8/8/8/8/8/4P3/4K3';
    expect(isKingInCheck(fen, 'w')).toBe(false);
  });

  it('detects a diagonal bishop check', () => {
    const fen = '7b/8/8/8/8/8/8/K7';
    expect(isKingInCheck(fen, 'w')).toBe(true);
  });

  it('detects a knight check', () => {
    const fen = '4k3/8/3n4/8/4K3/8/8/8';
    expect(isKingInCheck(fen, 'w')).toBe(true);
  });

  it('detects pawn check (white king attacked by black pawn)', () => {
    const fen = '8/8/8/3p4/4K3/8/8/8';
    expect(isKingInCheck(fen, 'w')).toBe(true);
  });

  it('detects pawn check (black king attacked by white pawn)', () => {
    const fen = '8/8/4k3/3P4/8/8/8/8';
    expect(isKingInCheck(fen, 'b')).toBe(true);
  });

  it('queen check along a diagonal', () => {
    const fen = '7q/8/8/8/8/8/8/K7';
    expect(isKingInCheck(fen, 'w')).toBe(true);
  });

  it('returns false when king is missing from the board', () => {
    const fen = '8/8/8/8/8/8/8/8';
    expect(isKingInCheck(fen, 'w')).toBe(false);
  });

  it('pawn one rank away but not diagonal is NOT a check', () => {
    // Black pawn directly in front of white king -> not attacking
    const fen = '8/8/8/8/4p3/4K3/8/8';
    expect(isKingInCheck(fen, 'w')).toBe(false);
  });
});
