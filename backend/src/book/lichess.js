'use strict';

/**
 * Lichess opening-explorer adapter (masters database).
 *
 * Caller owns the enable flag and supplies a fetch function (makes it
 * trivial to stub in tests and sidesteps global fetch availability
 * concerns across Node versions). Concurrency is limited to
 * `maxConcurrent` in-flight requests — calls beyond that return null
 * rather than queueing, matching the prior behaviour.
 */

const { forModule } = require('../lib/logger');

const log = forModule('lichess-book');

class LichessBook {
  constructor({ maxConcurrent = 2, timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl;
    this.enabled = false;
    this._inFlight = 0;
  }

  setEnabled(v) {
    this.enabled = !!v;
  }

  /**
   * Look up a FEN and return the UCI move with the most total games, or
   * null if disabled, rate-limited, miss, or any error.
   * @param {string} fen
   * @returns {Promise<string | null>}
   */
  async lookup(fen) {
    if (!this.enabled) return null;
    if (this._inFlight >= this.maxConcurrent) return null;
    this._inFlight++;
    try {
      const url = `https://explorer.lichess.ovh/masters?fen=${encodeURIComponent(fen)}&topGames=0&recentGames=0`;
      const res = await this._fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return null;
      let data;
      try {
        data = await res.json();
      } catch {
        log.warn('invalid JSON response');
        return null;
      }
      const best = pickBestMove(data);
      if (!best) return null;
      log.info(
        { uci: best.uci, san: best.san, games: best.white + best.draws + best.black },
        'hit',
      );
      return best.uci;
    } catch (err) {
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
