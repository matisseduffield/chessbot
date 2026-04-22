'use strict';

/**
 * Pure parsers for Stockfish UCI output lines.
 *
 * These are the functions used to turn engine stdout into structured
 * data. They take no I/O, have no side effects, and are fully covered
 * by unit tests. The live bridge (`stockfishBridge.js`) delegates all
 * line parsing to this module so the parsing logic can be tested in
 * isolation and reused from future tools (PGN analyser, benchmarks).
 */

/**
 * Parse a single `info ... pv ...` line from Stockfish.
 * Returns null if the line is not an info+pv line.
 *
 * @param {string} line
 * @returns {null | {
 *   depth: number,
 *   multipv: number,
 *   score?: number,
 *   mate?: number,
 *   nodes?: number,
 *   nps?: number,
 *   timeMs?: number,
 *   seldepth?: number,
 *   wdl?: { win: number, draw: number, loss: number },
 *   pv: string[],
 *   move: string,
 * }}
 */
function parseInfoLine(line) {
  if (typeof line !== 'string') return null;
  if (!line.startsWith('info')) return null;
  if (!line.includes(' pv ')) return null;

  const depthMatch = line.match(/\bdepth (\d+)/);
  const pvMatch = line.match(/\bpv (.+)/);
  if (!depthMatch || !pvMatch) return null;

  const pv = pvMatch[1].trim().split(/\s+/);
  if (pv.length === 0 || !pv[0]) return null;

  const multipvMatch = line.match(/\bmultipv (\d+)/);
  const seldepthMatch = line.match(/\bseldepth (\d+)/);
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  const nodesMatch = line.match(/\bnodes (\d+)/);
  const npsMatch = line.match(/\bnps (\d+)/);
  const timeMatch = line.match(/\btime (\d+)/);
  const wdlMatch = line.match(/\bwdl (\d+) (\d+) (\d+)/);

  const info = {
    depth: parseInt(depthMatch[1], 10),
    multipv: multipvMatch ? parseInt(multipvMatch[1], 10) : 1,
    pv,
    move: pv[0],
  };
  if (seldepthMatch) info.seldepth = parseInt(seldepthMatch[1], 10);
  if (cpMatch) info.score = parseInt(cpMatch[1], 10);
  if (mateMatch) info.mate = parseInt(mateMatch[1], 10);
  if (nodesMatch) info.nodes = parseInt(nodesMatch[1], 10);
  if (npsMatch) info.nps = parseInt(npsMatch[1], 10);
  if (timeMatch) info.timeMs = parseInt(timeMatch[1], 10);
  if (wdlMatch) {
    info.wdl = {
      win: parseInt(wdlMatch[1], 10),
      draw: parseInt(wdlMatch[2], 10),
      loss: parseInt(wdlMatch[3], 10),
    };
  }
  return info;
}

/**
 * Parse a `bestmove X [ponder Y]` line.
 * @param {string} line
 * @returns {null | { bestmove: string | null, ponder?: string }}
 */
function parseBestmoveLine(line) {
  if (typeof line !== 'string') return null;
  if (!line.startsWith('bestmove')) return null;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const bestmove = parts[1];
  if (!bestmove || bestmove === '(none)') {
    return { bestmove: null };
  }
  const ponderIdx = parts.indexOf('ponder');
  const result = { bestmove };
  if (ponderIdx > 0 && parts[ponderIdx + 1]) {
    result.ponder = parts[ponderIdx + 1];
  }
  return result;
}

/**
 * Parse an `option name X type Y ...` line. Returns just the option name.
 * Used during the UCI handshake to discover supported options.
 * @param {string} line
 * @returns {string | null}
 */
function parseOptionLine(line) {
  if (typeof line !== 'string') return null;
  const match = line.match(/^option name (.+?) type /);
  return match ? match[1] : null;
}

module.exports = {
  parseInfoLine,
  parseBestmoveLine,
  parseOptionLine,
};
