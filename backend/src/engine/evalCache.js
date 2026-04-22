'use strict';
// @ts-check

/**
 * LRU+TTL cache for engine evaluations.
 *
 * Key shape: `${fen}:${variant}:${depth}:${multiPV}` so changing any
 * of these dimensions busts the cache. Evicts the oldest entry when
 * full and expired entries on access. A `purgeExpired()` helper is
 * provided for periodic sweeps so memory doesn't creep upward for
 * long-idle caches (the server calls this on a 60s interval).
 *
 * Disk persistence (plan §4.5): `saveToDisk` / `loadFromDisk` write
 * the live entries as JSON. Expired entries are dropped on load so a
 * cold start never returns stale data.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX = 500;

/**
 * @template T
 * @typedef {{ result: T, ts: number }} CacheEntry
 */

/**
 * @template T
 */
class EvalCache {
  /**
   * @param {{ ttlMs?: number, max?: number, now?: () => number }} [opts]
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this._now = now;
    /** @type {Map<string, CacheEntry<T>>} */
    this._map = new Map();
  }

  /**
   * @param {string} fen
   * @param {string} variant
   * @param {number} depth
   * @param {number} multiPV
   * @returns {string}
   */
  _key(fen, variant, depth, multiPV) {
    return `${fen}:${variant}:${depth}:${multiPV}`;
  }

  /**
   * @param {string} fen
   * @param {string} variant
   * @param {number} depth
   * @param {number} multiPV
   * @returns {T | null}
   */
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

  /**
   * @param {string} fen
   * @param {string} variant
   * @param {number} depth
   * @param {number} multiPV
   * @param {T} result
   */
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

  /**
   * Persist the live (non-expired) entries to disk as JSON.
   * Writes atomically via a temp file + rename so a crash mid-save
   * never corrupts the cache file.
   * @param {string} filePath
   */
  saveToDisk(filePath) {
    const cutoff = this._now() - this.ttlMs;
    const entries = [];
    for (const [key, entry] of this._map) {
      if (entry.ts > cutoff) entries.push([key, entry]);
    }
    const payload = JSON.stringify({ version: 1, ttlMs: this.ttlMs, entries });
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, filePath);
    return entries.length;
  }

  /**
   * Load entries from a previous `saveToDisk`. Missing file → no-op.
   * Corrupt JSON → logs to stderr (via thrown Error) and returns 0.
   * Expired entries are dropped.
   * @param {string} filePath
   * @returns {number} count of entries loaded
   */
  loadFromDisk(filePath) {
    if (!fs.existsSync(filePath)) return 0;
    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return 0;
    }
    if (!parsed || !Array.isArray(parsed.entries)) return 0;
    const cutoff = this._now() - this.ttlMs;
    let loaded = 0;
    for (const [key, entry] of parsed.entries) {
      if (!entry || typeof entry.ts !== 'number') continue;
      if (entry.ts <= cutoff) continue;
      if (this._map.size >= this.max) break;
      this._map.set(key, entry);
      loaded++;
    }
    return loaded;
  }
}

module.exports = { EvalCache };
