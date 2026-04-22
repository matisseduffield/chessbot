import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseInfoLine, parseBestmoveLine, parseOptionLine } = require('./uciParser');

describe('parseInfoLine', () => {
  it('returns null for non-info lines', () => {
    expect(parseInfoLine('bestmove e2e4')).toBeNull();
    expect(parseInfoLine('readyok')).toBeNull();
    expect(parseInfoLine('')).toBeNull();
  });

  it('returns null for info lines without a pv', () => {
    expect(parseInfoLine('info depth 1 seldepth 1 multipv 1 score cp 20 nodes 20')).toBeNull();
    expect(parseInfoLine('info string NNUE evaluation using nn-... enabled')).toBeNull();
  });

  it('parses a standard multipv info line', () => {
    const line =
      'info depth 12 seldepth 18 multipv 1 score cp 35 nodes 12345 nps 200000 time 61 pv e2e4 e7e5 g1f3';
    const r = parseInfoLine(line);
    expect(r).toEqual({
      depth: 12,
      multipv: 1,
      seldepth: 18,
      score: 35,
      nodes: 12345,
      nps: 200000,
      timeMs: 61,
      pv: ['e2e4', 'e7e5', 'g1f3'],
      move: 'e2e4',
    });
  });

  it('parses a mate score', () => {
    const r = parseInfoLine('info depth 10 multipv 1 score mate 3 nodes 100 pv h5h7');
    expect(r.mate).toBe(3);
    expect(r.score).toBeUndefined();
    expect(r.move).toBe('h5h7');
  });

  it('parses negative mate (getting mated)', () => {
    const r = parseInfoLine('info depth 8 multipv 1 score mate -2 nodes 50 pv a1a2 a8a7');
    expect(r.mate).toBe(-2);
  });

  it('parses wdl when present', () => {
    const r = parseInfoLine(
      'info depth 20 multipv 1 score cp 15 wdl 450 500 50 nodes 1 pv e2e4',
    );
    expect(r.wdl).toEqual({ win: 450, draw: 500, loss: 50 });
  });

  it('defaults multipv to 1 when absent', () => {
    const r = parseInfoLine('info depth 5 score cp 10 nodes 1 pv d2d4');
    expect(r.multipv).toBe(1);
  });

  it('handles negative centipawns', () => {
    const r = parseInfoLine('info depth 4 multipv 1 score cp -150 nodes 10 pv e7e5');
    expect(r.score).toBe(-150);
  });
});

describe('parseBestmoveLine', () => {
  it('returns null for non-bestmove lines', () => {
    expect(parseBestmoveLine('info depth 1 pv e2e4')).toBeNull();
    expect(parseBestmoveLine('')).toBeNull();
  });

  it('parses a plain bestmove', () => {
    expect(parseBestmoveLine('bestmove e2e4')).toEqual({ bestmove: 'e2e4' });
  });

  it('parses bestmove with ponder', () => {
    expect(parseBestmoveLine('bestmove e2e4 ponder e7e5')).toEqual({
      bestmove: 'e2e4',
      ponder: 'e7e5',
    });
  });

  it('returns null bestmove for "(none)"', () => {
    expect(parseBestmoveLine('bestmove (none)')).toEqual({ bestmove: null });
  });

  it('handles promotion', () => {
    expect(parseBestmoveLine('bestmove e7e8q ponder a1a2')).toEqual({
      bestmove: 'e7e8q',
      ponder: 'a1a2',
    });
  });
});

describe('parseOptionLine', () => {
  it('returns the option name', () => {
    expect(parseOptionLine('option name Threads type spin default 1 min 1 max 1024')).toBe(
      'Threads',
    );
    expect(parseOptionLine('option name UCI_ShowWDL type check default false')).toBe(
      'UCI_ShowWDL',
    );
  });

  it('returns null for non-option lines', () => {
    expect(parseOptionLine('id name Stockfish 18')).toBeNull();
    expect(parseOptionLine('')).toBeNull();
  });

  it('handles multi-word option names', () => {
    expect(parseOptionLine('option name Skill Level type spin default 20 min 0 max 20')).toBe(
      'Skill Level',
    );
  });
});
