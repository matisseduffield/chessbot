import { describe, it, expect } from 'vitest';
import {
  STARTING_FEN,
  stripCrazyhousePocket,
  getBoardPart,
  getTurn,
  toEpd,
  parseFen,
  validateFen,
  injectThreeCheckCounters,
  isStandardStart,
} from './fen';

describe('getBoardPart / getTurn / toEpd', () => {
  it('extracts fields from a standard FEN', () => {
    expect(getBoardPart(STARTING_FEN)).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
    expect(getTurn(STARTING_FEN)).toBe('w');
    expect(toEpd(STARTING_FEN)).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
  });

  it('returns safe defaults on bad input', () => {
    expect(getBoardPart('' as unknown as string)).toBe('');
    expect(getTurn('' as unknown as string)).toBe('w');
    expect(toEpd(null as unknown as string)).toBe('');
  });

  it('reads black to move', () => {
    expect(getTurn('rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR b KQkq c6 0 2')).toBe('b');
  });
});

describe('stripCrazyhousePocket', () => {
  it('strips a trailing pocket', () => {
    expect(stripCrazyhousePocket('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[PP]')).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
    );
  });
  it('is a no-op when no pocket present', () => {
    expect(stripCrazyhousePocket('rnbqkbnr/8/8/8/8/8/8/RNBQKBNR')).toBe(
      'rnbqkbnr/8/8/8/8/8/8/RNBQKBNR',
    );
  });
});

describe('parseFen', () => {
  it('parses a full 6-field FEN', () => {
    const r = parseFen(STARTING_FEN);
    expect(r).toEqual({
      board: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      turn: 'w',
      castling: 'KQkq',
      enPassant: '-',
      halfmove: 0,
      fullmove: 1,
      hasPocket: false,
    });
  });

  it('flags hasPocket for crazyhouse', () => {
    const r = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1');
    expect(r?.hasPocket).toBe(true);
    expect(r?.board.includes('[')).toBe(false);
  });

  it('accepts minimal 2-field FEN', () => {
    const r = parseFen('8/8/8/8/8/8/8/8 w');
    expect(r?.turn).toBe('w');
    expect(r?.castling).toBe('-');
    expect(r?.fullmove).toBe(1);
  });

  it('returns null for totally malformed input', () => {
    expect(parseFen('')).toBeNull();
    expect(parseFen('garbage')).toBeNull();
    expect(parseFen(null as unknown as string)).toBeNull();
  });
});

describe('validateFen', () => {
  it('accepts the starting position', () => {
    expect(validateFen(STARTING_FEN)).toEqual({ valid: true });
  });
  it('rejects empty input', () => {
    expect(validateFen('')).toEqual({ valid: false, reason: 'empty' });
  });
  it('rejects missing turn field', () => {
    expect(validateFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR')).toEqual({
      valid: false,
      reason: 'missing turn field',
    });
  });
  it('rejects invalid turn', () => {
    const r = validateFen('8/8/8/8/8/8/8/8 x KQkq - 0 1');
    expect(r.valid).toBe(false);
  });
  it('accepts crazyhouse pocket', () => {
    expect(validateFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1')).toEqual({
      valid: true,
    });
  });
});

describe('injectThreeCheckCounters', () => {
  it('adds default counter to a 6-field FEN', () => {
    const r = injectThreeCheckCounters(STARTING_FEN);
    expect(r).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 3+3 0 1');
  });
  it('leaves 7-field FEN with existing counter alone', () => {
    const seven = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 2+3 0 1';
    expect(injectThreeCheckCounters(seven)).toBe(seven);
  });
  it('ignores non-6-field FENs', () => {
    expect(injectThreeCheckCounters('8/8/8/8/8/8/8/8 w')).toBe('8/8/8/8/8/8/8/8 w');
  });
});

describe('isStandardStart', () => {
  it('detects the starting position regardless of clocks', () => {
    expect(isStandardStart(STARTING_FEN)).toBe(true);
    expect(isStandardStart('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 99 50')).toBe(
      true,
    );
  });
  it('returns false after a move', () => {
    expect(isStandardStart('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')).toBe(
      false,
    );
  });
});
