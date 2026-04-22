/**
 * Pure formatting helpers for engine PV lines. Extracted from
 * content.js (plan §2.1) so they can be unit-tested without a DOM.
 *
 * A "line" here is the engine's MultiPV entry shape:
 *   { score?: number, mate?: number|null, pv?: string[], depth?: number }
 */

/**
 * @typedef {Object} PvLineLike
 * @property {number} [score]  centipawns, from side-to-move's POV
 * @property {number|null} [mate]  plies to mate (positive = winning)
 */

/**
 * Format a line's evaluation as a human-readable string like
 * "+0.8", "−2.3", "+M4", or "?" when nothing is known yet.
 *
 * @param {PvLineLike} line
 * @returns {string}
 */
export function formatScore(line) {
  if (line == null) return '?';
  if (line.mate !== undefined && line.mate !== null) {
    return (line.mate >= 0 ? '+' : '\u2212') + 'M' + Math.abs(line.mate);
  }
  if (line.score !== undefined && line.score !== null) {
    const val = line.score / 100;
    return (val >= 0 ? '+' : '') + val.toFixed(1);
  }
  return '?';
}

/**
 * Is this line losing for the side to move? Used to colour the
 * on-board arrow red when even the best engine line is bad.
 *
 * Threshold: mate-against (negative mate) is always losing,
 * centipawn score below −50 counts as losing, otherwise false.
 *
 * @param {PvLineLike} line
 * @returns {boolean}
 */
export function isLineLosing(line) {
  if (line == null) return false;
  if (line.mate !== undefined && line.mate !== null) return line.mate < 0;
  if (line.score !== undefined && line.score !== null) return line.score < -50;
  return false;
}
