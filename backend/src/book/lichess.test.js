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

  it('caches hits and serves them without refetching', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ moves: [{ uci: 'e2e4', san: 'e4', white: 1, draws: 0, black: 0 }] }),
    });
    const b = new LichessBook({ fetchImpl });
    b.setEnabled(true);
    expect(await b.lookup('fenA')).toBe('e2e4');
    expect(await b.lookup('fenA')).toBe('e2e4');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(b.stats.hits).toBe(1);
    expect(b.stats.misses).toBe(1);
  });

  it('caches "no opening data" misses too', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ moves: [] }) });
    const b = new LichessBook({ fetchImpl });
    b.setEnabled(true);
    expect(await b.lookup('fenZ')).toBeNull();
    expect(await b.lookup('fenZ')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('classifies an HTTP non-2xx response as http_error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const b = new LichessBook({ fetchImpl });
    b.setEnabled(true);
    expect(await b.lookup('fen')).toBeNull();
    expect(b.stats.errorsByReason.http_error).toBe(1);
    expect(b.stats.fetchErrors).toBe(1);
  });

  it('classifies a JSON parse failure as parse_error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      },
    });
    const b = new LichessBook({ fetchImpl });
    b.setEnabled(true);
    expect(await b.lookup('fen')).toBeNull();
    expect(b.stats.errorsByReason.parse_error).toBe(1);
  });

  it('classifies an empty moves response as not_found', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ moves: [] }),
    });
    const b = new LichessBook({ fetchImpl });
    b.setEnabled(true);
    expect(await b.lookup('fen')).toBeNull();
    expect(b.stats.errorsByReason.not_found).toBe(1);
    // not_found is not a transport failure, so the legacy total stays at 0.
    expect(b.stats.fetchErrors).toBe(0);
  });

  it('classifies an AbortError as timeout', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    });
    const b = new LichessBook({ fetchImpl });
    b.setEnabled(true);
    expect(await b.lookup('fen')).toBeNull();
    expect(b.stats.errorsByReason.timeout).toBe(1);
  });

  it('classifies other thrown errors as network_error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const b = new LichessBook({ fetchImpl });
    b.setEnabled(true);
    expect(await b.lookup('fen')).toBeNull();
    expect(b.stats.errorsByReason.network_error).toBe(1);
  });
});
