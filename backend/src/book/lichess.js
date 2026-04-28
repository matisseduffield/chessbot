'use strict';

/**
 * Lichess opening-explorer adapter (masters database).
 *
 * Caller owns the enable flag and supplies a fetch function (makes it
 * trivial to stub in tests and sidesteps global fetch availability
 * concerns across Node versions). Concurrency is limited to
 * `maxConcurrent` in-flight requests — calls beyond that return null
 * rather than queueing, matching the prior behaviour.
 *
 * Results are cached in-memory with a small LRU keyed on FEN, so puzzle
 * batches that revisit the same opening positions don't hit the network
 * twice. Cache is best-effort: misses still fall through to fetch().
 */

const { forModule } = require('../lib/logger');

const log = forModule('lichess-book');

class LichessBook {
  constructor({
    maxConcurrent = 2,
    timeoutMs = 5000,
    fetchImpl = globalThis.fetch,
    cacheSize = 1000,
    cacheTtlMs = 60 * 60 * 1000, // 1h — opening-book data is effectively static
  } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl;
    this.enabled = false;
    this._inFlight = 0;
    this._cache = new Map(); // fen -> { uci: string|null, ts: number }
    this._cacheMax = cacheSize;
    this._cacheTtlMs = cacheTtlMs;
    this.stats = { hits: 0, misses: 0, fetchErrors: 0 };
  }

  setEnabled(v) {
    this.enabled = !!v;
  }

  _cacheGet(fen) {
    const e = this._cache.get(fen);
    if (!e) return undefined;
    if (Date.now() - e.ts > this._cacheTtlMs) {
      this._cache.delete(fen);
      return undefined;
    }
    // LRU touch
    this._cache.delete(fen);
    this._cache.set(fen, e);
    return e.uci;
  }

  _cacheSet(fen, uci) {
    if (this._cache.size >= this._cacheMax) {
      const oldest = this._cache.keys().next().value;
      if (oldest !== undefined) this._cache.delete(oldest);
    }
    this._cache.set(fen, { uci, ts: Date.now() });
  }

  /**
   * Look up a FEN and return the UCI move with the most total games, or
   * null if disabled, rate-limited, miss, or any error.
   * @param {string} fen
   * @returns {Promise<string | null>}
   */
  async lookup(fen) {
    if (!this.enabled) return null;
    const cached = this._cacheGet(fen);
    if (cached !== undefined) {
      this.stats.hits++;
      return cached;
    }
    if (this._inFlight >= this.maxConcurrent) return null;
    this.stats.misses++;
    this._inFlight++;
    try {
      const url = `https://explorer.lichess.ovh/masters?fen=${encodeURIComponent(fen)}&topGames=0&recentGames=0`;
      const res = await this._fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) {
        // Don't cache transient errors — try again next time.
        return null;
      }
      let data;
      try {
        data = await res.json();
      } catch {
        log.warn('invalid JSON response');
        return null;
      }
      const best = pickBestMove(data);
      if (!best) {
        // Cache "no opening data" misses too — saves the next call.
        this._cacheSet(fen, null);
        return null;
      }
      log.info(
        { uci: best.uci, san: best.san, games: best.white + best.draws + best.black },
        'hit',
      );
      this._cacheSet(fen, best.uci);
      return best.uci;
    } catch (err) {
      this.stats.fetchErrors++;
      log.warn({ err: err.message }, 'lookup failed');
      return null;
    } finally {
      this._inFlight--;
    }
  }
}

/**
 * Given a Lichess response, return the entry with the most total games
 * or null if the response has no moves. Exposed for unit tests.
 */
function pickBestMove(data) {
  if (!data || !Array.isArray(data.moves) || data.moves.length === 0) return null;
  return data.moves.reduce((a, b) =>
    a.white + a.draws + a.black >= b.white + b.draws + b.black ? a : b,
  );
}

module.exports = { LichessBook, pickBestMove };
