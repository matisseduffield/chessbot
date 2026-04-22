'use strict';

/**
 * ECO (Encyclopedia of Chess Openings) lookup.
 *
 * Loads tab-separated opening files from a directory into an in-memory
 * EPD → { code, name } map. Loading is sync (only runs at startup) and
 * strips UTF-8 BOM from input files. Lookups are O(1).
 *
 * TSV format: `eco\tname\tepd` per row, with a one-line header.
 */

const fs = require('fs');
const path = require('path');
const { forModule } = require('../lib/logger');

const log = forModule('eco');
const openings = new Map();

/**
 * Parse TSV content into [epd, entry] pairs. Exposed for unit tests so
 * they can exercise parsing without touching the filesystem.
 * @param {string} content
 * @returns {Array<[string, { code: string, name: string }]>}
 */
function parseTsv(content) {
  if (typeof content !== 'string') return [];
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const rows = content.split('\n');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const parts = rows[i].split('\t');
    if (parts.length >= 3) {
      const epd = parts[2].trim();
      if (!epd) continue;
      out.push([epd, { code: parts[0].trim(), name: parts[1].trim() }]);
    }
  }
  return out;
}

/**
 * Load every `*.tsv` file under `dir` into the in-memory map.
 * Clears any previously loaded entries so the function is idempotent.
 */
function loadEco(dir) {
  if (!fs.existsSync(dir)) {
    log.info({ dir }, 'directory not found');
    return;
  }
  openings.clear();
  let count = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.tsv')) continue;
    const full = path.join(dir, file);
    const content = fs.readFileSync(full, 'utf-8');
    for (const [epd, entry] of parseTsv(content)) {
      openings.set(epd, entry);
      count++;
    }
  }
  log.info({ count }, 'loaded openings');
}

/**
 * Look up an EPD string (FEN without move counters).
 * @param {string} epd
 * @returns {{ code: string, name: string } | null}
 */
function lookup(epd) {
  if (!epd || typeof epd !== 'string') return null;
  return openings.get(epd) || null;
}

/** Current entry count. Primarily for diagnostics/tests. */
function size() {
  return openings.size;
}

/** Clear the in-memory map. Primarily for tests. */
function _reset() {
  openings.clear();
}

/** Seed the map directly. Primarily for tests. */
function _seed(entries) {
  for (const [epd, entry] of entries) openings.set(epd, entry);
}

module.exports = { loadEco, lookup, parseTsv, size, _reset, _seed };
