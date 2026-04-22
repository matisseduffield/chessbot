'use strict';

/**
 * LRU+TTL cache for engine evaluations.
 *
 * Key shape: `${fen}:${variant}:${depth}:${multiPV}` so changing any
 * of these dimensions busts the cache. Evicts the oldest entry when
 * full and expired entries on access. A `purgeExpired()` helper is
 * provided for periodic sweeps so memory doesn't creep upward for
 * long-idle caches (the server calls this on a 60s interval).
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX = 500;

class EvalCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this._now = now;
    this._map = new Map();
  }

  _key(fen, variant, depth, multiPV) {
    return `${fen}:${variant}:${depth}:${multiPV}`;
  }

  get(fen, variant, depth, multiPV) {
    const key = this._key(fen, variant, depth, multiPV);
    const entry = this._map.get(key);
    if (!entry) return null;
    if (this._now() - entry.ts > this.ttlMs) {
      this._map.delete(key);
      return null;
    }
    // LRU touch
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.result;
  }

  set(fen, variant, depth, multiPV, result) {
    const key = this._key(fen, variant, depth, multiPV);
    if (this._map.size >= this.max && !this._map.has(key)) {
      const oldest = this._map.keys().next().value;
      if (oldest !== undefined) this._map.delete(oldest);
    }
    this._map.set(key, { result, ts: this._now() });
  }

  purgeExpired() {
    const cutoff = this._now() - this.ttlMs;
    for (const [key, entry] of this._map) {
      if (entry.ts <= cutoff) this._map.delete(key);
    }
  }

  get size() {
    return this._map.size;
  }

  clear() {
    this._map.clear();
  }
}

module.exports = { EvalCache };
