import { describe, it, expect } from 'vitest';
import { parsePgn, buildAnnotatedPgn } from './pgn';

const SAMPLE = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.04.20"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 { Main line } 4. Ba4 Nf6 5. O-O Be7 1-0
`;

describe('parsePgn', () => {
  it('extracts headers', () => {
    const r = parsePgn(SAMPLE);
    expect(r.headers.White).toBe('Alice');
    expect(r.headers.Black).toBe('Bob');
    expect(r.headers.Result).toBe('1-0');
  });

  it('extracts SAN moves in order without comments or numbers', () => {
    const r = parsePgn(SAMPLE);
    expect(r.moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7']);
  });

  it('captures the result token', () => {
    expect(parsePgn(SAMPLE).result).toBe('1-0');
  });

  it('strips NAG tokens and variations', () => {
    const pgn = `[Event "?"]\n\n1. e4 $1 e5 (1... c5 2. Nf3) 2. Nf3 *\n`;
    const r = parsePgn(pgn);
    expect(r.moves).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('handles black-to-move continuation markers (1...)', () => {
    const pgn = `[Event "?"]\n\n1. e4 e5 2... Nc6 *\n`;
    const r = parsePgn(pgn);
    expect(r.moves).toEqual(['e4', 'e5', 'Nc6']);
  });
});

describe('buildAnnotatedPgn', () => {
  it('writes standard seven-tag roster', () => {
    const out = buildAnnotatedPgn({}, [], '*');
    expect(out).toMatch(/^\[Event "\?"\]/);
    expect(out).toMatch(/\[Result "\*"\]/);
  });

  it('emits [%eval] comments for scored moves', () => {
    const out = buildAnnotatedPgn(
      { White: 'A', Black: 'B' },
      [
        { san: 'e4', scoreCp: 30 },
        { san: 'e5', scoreCp: 20 },
      ],
      '*',
    );
    expect(out).toContain('[%eval 0.30]');
    expect(out).toContain('[%eval 0.20]');
    expect(out).toContain('1. e4');
    expect(out.trim().endsWith('*')).toBe(true);
  });

  it('emits mate-style eval', () => {
    const out = buildAnnotatedPgn({}, [{ san: 'Qh5#', mate: 1, nag: '#' }], '1-0');
    expect(out).toContain('[%eval #1]');
  });

  it('round-trips: parse(build(moves)) returns same SAN sequence', () => {
    const moves = [{ san: 'e4' }, { san: 'e5' }, { san: 'Nf3' }, { san: 'Nc6' }];
    const written = buildAnnotatedPgn({ White: 'A', Black: 'B' }, moves, '*');
    const parsed = parsePgn(written);
    expect(parsed.moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('escapes quotes in header values', () => {
    const out = buildAnnotatedPgn({ White: 'A "quote"' }, [], '*');
    expect(out).toContain('[White "A \\"quote\\""]');
  });
});
