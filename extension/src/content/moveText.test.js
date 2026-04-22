import { describe, it, expect } from 'vitest';
import { isRealMoveText, plyCountToTurn, parseLastRowTurn, turnFromMoveTexts } from './moveText.js';

describe('isRealMoveText', () => {
  it('accepts SAN pawn moves', () => {
    expect(isRealMoveText('e4')).toBe(true);
    expect(isRealMoveText('exd5')).toBe(true);
  });
  it('accepts piece moves', () => {
    expect(isRealMoveText('Nf3')).toBe(true);
    expect(isRealMoveText('Qxd5+')).toBe(true);
    expect(isRealMoveText('O-O')).toBe(true);
    expect(isRealMoveText('O-O-O#')).toBe(true);
  });
  it('rejects move numbers', () => {
    expect(isRealMoveText('1')).toBe(false);
    expect(isRealMoveText('1.')).toBe(false);
    expect(isRealMoveText('42.')).toBe(false);
  });
  it('rejects blank / null / whitespace', () => {
    expect(isRealMoveText('')).toBe(false);
    expect(isRealMoveText(null)).toBe(false);
    expect(isRealMoveText(undefined)).toBe(false);
    expect(isRealMoveText('   ')).toBe(false);
  });
  it('rejects punctuation-only text', () => {
    expect(isRealMoveText('...')).toBe(false);
    expect(isRealMoveText('- -')).toBe(false);
  });
});

describe('plyCountToTurn', () => {
  it('0 plies → white to move', () => {
    expect(plyCountToTurn(0)).toBe('w');
  });
  it('1 ply → black to move', () => {
    expect(plyCountToTurn(1)).toBe('b');
  });
  it('even ply counts → white', () => {
    expect(plyCountToTurn(4)).toBe('w');
    expect(plyCountToTurn(200)).toBe('w');
  });
  it('odd ply counts → black', () => {
    expect(plyCountToTurn(5)).toBe('b');
    expect(plyCountToTurn(201)).toBe('b');
  });
  it('rejects negatives / NaN', () => {
    expect(plyCountToTurn(-1)).toBe(null);
    expect(plyCountToTurn(NaN)).toBe(null);
  });
});

describe('parseLastRowTurn', () => {
  it('both plies present → white to move', () => {
    expect(parseLastRowTurn('12. Nf3 Nc6')).toBe('w');
  });
  it('only white played → black to move', () => {
    expect(parseLastRowTurn('12. Nf3')).toBe('b');
  });
  it('handles missing move number', () => {
    expect(parseLastRowTurn('Nf3 Nc6')).toBe('w');
    expect(parseLastRowTurn('Nf3')).toBe('b');
  });
  it('ignores dotted-number second token', () => {
    expect(parseLastRowTurn('12. Nf3 13.')).toBe('b');
  });
});

describe('turnFromMoveTexts', () => {
  it('returns null for empty input', () => {
    expect(turnFromMoveTexts([])).toBe(null);
    expect(turnFromMoveTexts(null)).toBe(null);
  });
  it('filters noise and counts real plies', () => {
    const texts = ['1.', 'e4', 'e5', '2.', 'Nf3'];
    expect(turnFromMoveTexts(texts)).toBe('b'); // 3 real plies
  });
  it('4 real plies → white to move', () => {
    expect(turnFromMoveTexts(['e4', 'e5', 'Nf3', 'Nc6'])).toBe('w');
  });
});
