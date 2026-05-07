'use strict';
// @ts-check

/**
 * Blunder / mistake / inaccuracy classification (plan §8.2).
 *
 * Given the evaluation of the position *before* a move (from the perspective
 * of the side to move) and the evaluation *after* the move (from the same
 * side's perspective), compute the centipawn drop and return a classification:
 *
 *   - 'blunder'    : drop ≥ 200 cp
 *   - 'mistake'    : drop ≥ 100 cp
 *   - 'inaccuracy' : drop ≥ 50 cp
 *   - null         : unremarkable
 *
 * Mate swings are mapped to large magnitudes so missed-mate is flagged.
 */

const MATE_VALUE = 100_000;

/**
 * @typedef {{ cp?: number|null, mate?: number|null }} Score
 * @typedef {{ blunder?: number, mistake?: number, inaccuracy?: number }} Thresholds
 * @typedef {{ drop: number, severity: 'blunder'|'mistake'|'inaccuracy'|null }} Classification
 */

/**
 * @param {Score | null | undefined} s
 * @returns {number | null}
 */
function scoreToCp(s) {
  if (!s) return null;
  if (typeof s.mate === 'number' && Number.isFinite(s.mate)) {
    return s.mate > 0 ? MATE_VALUE - s.mate : -MATE_VALUE - s.mate;
  }
  if (typeof s.cp === 'number' && Number.isFinite(s.cp)) return s.cp;
  return null;
}

/**
 * @param {Score | null | undefined} before
 * @param {Score | null | undefined} after
 * @param {Thresholds} [thresholds]
 * @returns {Classification | null}
 */
function classifyMove(before, after, thresholds = {}) {
  const b = scoreToCp(before);
  const a = scoreToCp(after);
  if (b == null || a == null) return null;

  const bl = thresholds.blunder ?? 200;
  const mi = thresholds.mistake ?? 100;
  const ia = thresholds.inaccuracy ?? 50;

  const drop = b - a;
  if (drop >= bl) return { drop, severity: 'blunder' };
  if (drop >= mi) return { drop, severity: 'mistake' };
  if (drop >= ia) return { drop, severity: 'inaccuracy' };
  return { drop, severity: null };
}

/**
 * @param {Score | null | undefined} bestBefore
 * @param {Score | null | undefined} afterFromSame
 */
function classifyUserMove(bestBefore, afterFromSame) {
  return classifyMove(bestBefore, afterFromSame);
}

module.exports = { classifyMove, classifyUserMove, scoreToCp, MATE_VALUE };
