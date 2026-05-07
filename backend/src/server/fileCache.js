'use strict';
// @ts-check

/**
 * Async file-list cache for the engine / books / syzygy directories.
 *
 * Extracted from server.js (plan §2.1, P2.F). Two-step API so the
 * request path never blocks on disk:
 *
 *   const cache = new FileCache({ engineDir, booksDir, syzygyDir });
 *   await cache.refresh();          // initial population
 *   const stop = cache.start();      // background poller (returns disposer)
 *   const snap = cache.get();        // sync snapshot
 *
 * Snapshots are plain objects with `engines`, `books`, `syzygy`
 * arrays. Each entry is `{ name, path }`. Missing directories are
 * silently treated as empty (matches the prior behaviour and keeps
 * a fresh checkout of the repo from blowing up on first start).
 */

const fs = require('node:fs');
const path = require('node:path');
const { forModule } = require('../lib/logger');

const fsp = fs.promises;
const log = forModule('file-cache');

const DEFAULT_TTL_MS = 10_000;
// Likely-non-binary filenames we strip out when scanning the engine
// directory on macOS/Linux (binaries there are typically extension-less).
const ENGINE_SKIP_EXT = new Set(['.md', '.txt', '.json', '.log', '.html', '.sh']);

/**
 * @typedef {{ name: string, path: string }} FileEntry
 * @typedef {{
 *   engines: FileEntry[],
 *   books: FileEntry[],
 *   syzygy: FileEntry[],
 *   ts: number,
 * }} Snapshot
 */

/**
 * Recursively walk a directory and return files whose lowercased name
 * ends with one of the given extensions. Pass `['']` to include
 * everything (callers post-filter).
 * @param {string} dir
 * @param {string[]} extensions
 * @returns {Promise<FileEntry[]>}
 */
async function scanFilesAsync(dir, extensions) {
  /** @type {FileEntry[]} */
  const results = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return results; // directory missing or unreadable — treat as empty
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await scanFilesAsync(full, extensions);
      results.push(...sub);
    } else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
      results.push({ name: entry.name, path: full });
    }
  }
  return results;
}

class FileCache {
  /**
   * @param {{
   *   engineDir: string,
   *   booksDir: string,
   *   syzygyDir: string,
   *   platform?: NodeJS.Platform,
   * }} opts
   */
  constructor({ engineDir, booksDir, syzygyDir, platform = process.platform }) {
    this.engineDir = engineDir;
    this.booksDir = booksDir;
    this.syzygyDir = syzygyDir;
    this._platform = platform;
    /** @type {Snapshot} */
    this._snapshot = { engines: [], books: [], syzygy: [], ts: 0 };
  }

  /** @returns {Promise<FileEntry[]>} */
  async _listEngines() {
    if (this._platform === 'win32') {
      return scanFilesAsync(this.engineDir, ['.exe']);
    }
    // Extension-less binaries on macOS/Linux. Walk and post-filter
    // out files that look like docs/configs.
    const all = await scanFilesAsync(this.engineDir, ['']);
    return all.filter((f) => {
      const dot = f.name.lastIndexOf('.');
      if (dot < 0) return true;
      return !ENGINE_SKIP_EXT.has(f.name.slice(dot).toLowerCase());
    });
  }

  /** @returns {Promise<FileEntry[]>} */
  _listBooks() {
    return scanFilesAsync(this.booksDir, ['.bin']);
  }

  /** @returns {Promise<FileEntry[]>} */
  async _listSyzygyDirs() {
    /** @type {FileEntry[]} */
    const results = [];
    let rootEntries;
    try {
      rootEntries = await fsp.readdir(this.syzygyDir, { withFileTypes: true });
    } catch {
      return results;
    }
    // The directory itself counts if it contains tablebase files.
    const hasTB = rootEntries.some(
      (e) => !e.isDirectory() && (e.name.endsWith('.rtbw') || e.name.endsWith('.rtbz')),
    );
    if (hasTB) {
      results.push({ name: path.basename(this.syzygyDir), path: this.syzygyDir });
    }
    // Plus any subdirectory containing tablebase files.
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;
      const subPath = path.join(this.syzygyDir, entry.name);
      let subFiles;
      try {
        subFiles = await fsp.readdir(subPath);
      } catch {
        continue;
      }
      const subHasTB = subFiles.some((f) => f.endsWith('.rtbw') || f.endsWith('.rtbz'));
      if (subHasTB) results.push({ name: entry.name, path: subPath });
    }
    return results;
  }

  /**
   * Re-scan all three directories and update the in-memory snapshot.
   * Errors are logged at warn level and leave the previous snapshot
   * intact — the request path never sees an empty cache mid-flight.
   */
  async refresh() {
    try {
      const [engines, books, syzygy] = await Promise.all([
        this._listEngines(),
        this._listBooks(),
        this._listSyzygyDirs(),
      ]);
      this._snapshot = { engines, books, syzygy, ts: Date.now() };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'file-cache refresh failed',
      );
    }
  }

  /**
   * Start a background interval that calls refresh() every ttlMs.
   * Returns a disposer that clears the interval. The returned timer
   * is unref'd so it doesn't keep the process alive on its own.
   * @param {number} [ttlMs]
   */
  start(ttlMs = DEFAULT_TTL_MS) {
    const timer = setInterval(() => {
      void this.refresh();
    }, ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  /** @returns {Snapshot} */
  get() {
    return this._snapshot;
  }
}

module.exports = { FileCache, scanFilesAsync };
