import { describe, it, expect } from 'vitest';
import { buildPgnFromHistory } from './pgn.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('buildPgnFromHistory', () => {
  it('returns a header-only PGN when evalHistory is empty', () => {
    const { pgn, derivedMoveCount, totalEntries } = buildPgnFromHistory({});
    expect(derivedMoveCount).toBe(0);
    expect(totalEntries).toBe(0);
    expect(pgn).toContain('[Event "ChessBot Export"]');
    expect(pgn.trimEnd().endsWith('*')).toBe(true);
  });

  it('derives the SAN move for a one-ply transition', () => {
    const { pgn, derivedMoveCount } = buildPgnFromHistory({
      evalHistory: [
        // A position after 1. e4
        { fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', cp: 25 },
      ],
    });
    expect(derivedMoveCount).toBe(1);
    expect(pgn).toContain('1. e4');
    // Eval annotation in the [%eval ...] format from shared/pgn.ts.
    expect(pgn).toContain('[%eval 0.25]');
  });

  it('skips a leading start-position entry without emitting a phantom ply', () => {
    const { pgn, derivedMoveCount } = buildPgnFromHistory({
      evalHistory: [
        { fen: START_FEN, cp: 20 },
        { fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', cp: 25 },
      ],
    });
    expect(derivedMoveCount).toBe(1);
    expect(pgn).toContain('1. e4');
    expect(pgn).not.toMatch(/1\.\s*\.\.\./);
  });

  it('threads multiple plies into a real game', () => {
    // 1. e4 e5 2. Nf3 Nc6
    const { pgn, derivedMoveCount } = buildPgnFromHistory({
      evalHistory: [
        { fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', cp: 25 },
        { fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', cp: 18 },
        { fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2', cp: 22 },
        { fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', cp: 18 },
      ],
    });
    expect(derivedMoveCount).toBe(4);
    expect(pgn).toContain('1. e4');
    expect(pgn).toContain('e5');
    expect(pgn).toContain('Nf3');
    expect(pgn).toContain('Nc6');
    expect(pgn).toContain('[%eval 0.25]');
    expect(pgn).toContain('[%eval 0.22]');
  });

  it('writes mate annotations as [%eval #N]', () => {
    // After 1. f3 e5 2. g4 — Black plays Qh4# next; we test the mate annotation
    // on the move BEFORE that, mid-search.
    const { pgn } = buildPgnFromHistory({
      evalHistory: [
        { fen: 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1', cp: -10 },
        { fen: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2', mate: -2 },
      ],
    });
    expect(pgn).toContain('[%eval #-2]');
  });

  it('stops the move list when two FENs are not reachable in one ply', () => {
    // After 1. e4 jumps directly to "after 1. d4 d5" — not reachable in
    // one move. Should derive only the first move (e4 from start).
    const { derivedMoveCount, pgn } = buildPgnFromHistory({
      evalHistory: [
        { fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', cp: 25 },
        { fen: 'rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2', cp: 10 },
      ],
    });
    expect(derivedMoveCount).toBe(1);
    expect(pgn).toContain('1. e4');
    expect(pgn).not.toContain('d4');
  });

  it('honours an explicit non-standard startFen (puzzle / midgame)', () => {
    // K-vs-K endgame as the starting position. White plays Ke2.
    // (Picked specifically so the resulting position is legal —
    // adjacent-kings positions chess.js rejects on parse.)
    const startFen = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
    const { pgn, derivedMoveCount } = buildPgnFromHistory({
      startFen,
      evalHistory: [{ fen: '4k3/8/8/8/8/8/4K3/8 b - - 1 1', cp: 0 }],
    });
    expect(derivedMoveCount).toBe(1);
    expect(pgn).toMatch(/1\. K[a-h]\d/);
  });

  it('emits PGN headers from gameInfo', () => {
    const { pgn } = buildPgnFromHistory({
      gameInfo: { white: { name: 'Magnus' }, black: { name: 'Hikaru' } },
    });
    expect(pgn).toContain('[White "Magnus"]');
    expect(pgn).toContain('[Black "Hikaru"]');
  });

  it('falls back to "?" for missing player names', () => {
    const { pgn } = buildPgnFromHistory({});
    expect(pgn).toContain('[White "?"]');
    expect(pgn).toContain('[Black "?"]');
  });

  it('survives malformed FENs without throwing', () => {
    expect(() =>
      buildPgnFromHistory({
        evalHistory: [{ fen: 'definitely-not-a-fen' }],
      }),
    ).not.toThrow();
  });
});
