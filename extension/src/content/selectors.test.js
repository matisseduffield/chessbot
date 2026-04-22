import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CHESSCOM, LICHESS, resolve, _resetWarnings } from './selectors.js';

function fakeRoot(map) {
  return {
    querySelector(sel) {
      return map[sel] || null;
    },
  };
}

beforeEach(() => _resetWarnings());

describe('selectors', () => {
  it('returns the first matching element', () => {
    const a = { id: 'A' };
    const b = { id: 'B' };
    const root = fakeRoot({ 'wc-chess-board': a, 'chess-board': b });
    expect(resolve(root, CHESSCOM.board, 'chesscom.board')).toBe(a);
  });

  it('falls back to subsequent selectors', () => {
    const b = { id: 'B' };
    const root = fakeRoot({ 'chess-board': b });
    expect(resolve(root, CHESSCOM.board, 'chesscom.board')).toBe(b);
  });

  it('returns null on no match and warns once', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = fakeRoot({});
    expect(resolve(root, LICHESS.board, 'lichess.board')).toBe(null);
    expect(resolve(root, LICHESS.board, 'lichess.board')).toBe(null);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('tolerates invalid selectors without throwing', () => {
    const root = {
      querySelector(sel) {
        if (sel === 'bad:(') throw new Error('bad');
        return null;
      },
    };
    expect(resolve(root, ['bad:('], 'x')).toBe(null);
  });

  it('returns null for null root', () => {
    expect(resolve(null, ['x'], 'k')).toBe(null);
  });
});
