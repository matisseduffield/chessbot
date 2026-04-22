import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { LichessBook, pickBestMove } = require('./lichess');

describe('pickBestMove', () => {
  it('returns null for empty response', () => {
    expect(pickBestMove(null)).toBeNull();
    expect(pickBestMove({})).toBeNull();
    expect(pickBestMove({ moves: [] })).toBeNull();
  });

  it('picks the move with most total games', () => {
    const data = {
      moves: [
        { uci: 'e2e4', san: 'e4', white: 100, draws: 50, black: 30 },
        { uci: 'd2d4', san: 'd4', white: 200, draws: 80, black: 40 },
        { uci: 'c2c4', san: 'c4', white: 10, draws: 5, black: 2 },
      ],
    };
    expect(pickBestMove(data).uci).toBe('d2d4');
  });
});

describe('LichessBook.lookup', () => {
  it('returns null when disabled', async () => {
    const fetchImpl = vi.fn();
    const b = new LichessBook({ fetchImpl });
    expect(await b.lookup('fen')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns best uci on hit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        moves: [
          { uci: 'e2e4', san: 'e4', white: 100, draws: 50, black: 30 },
          { uci: 'd2d4', san: 'd4', white: 200, draws: 80, black: 40 },
        ],
      }),
    });
    const b = new LichessBook({ fetchImpl });
    b.setEnabled(true);
    expect(await b.lookup('fen')).toBe('d2d4');
  });

  it('returns null on non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false });
    const b = new LichessBook({ fetchImpl });
    b.setEnabled(true);
    expect(await b.lookup('fen')).toBeNull();
  });

  it('returns null and swallows error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    const b = new LichessBook({ fetchImpl });
    b.setEnabled(true);
    expect(await b.lookup('fen')).toBeNull();
  });

  it('rate-limits concurrent calls', async () => {
    let resolveFetch;
    const pending = new Promise((r) => {
      resolveFetch = r;
    });
    const fetchImpl = vi.fn().mockReturnValue(pending);
    const b = new LichessBook({ maxConcurrent: 1, fetchImpl });
    b.setEnabled(true);
    const p1 = b.lookup('fen1');
    // Second call should short-circuit to null, not increment in-flight
    expect(await b.lookup('fen2')).toBeNull();
    resolveFetch({ ok: true, json: async () => ({ moves: [] }) });
    expect(await p1).toBeNull();
  });
});
