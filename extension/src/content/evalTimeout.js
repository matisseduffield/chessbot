/**
 * Pure timeout calculator for a pending engine evaluation.
 * Extracted from content.js (plan §2.1) so it can be unit-tested.
 *
 * Semantics (preserved from the original inline version):
 *   - depth === 0 means "infinite depth". If the user also set a
 *     movetime limit, honour that + 15 s safety buffer; otherwise
 *     wait forever (Infinity).
 *   - For bounded depth, base timeout is 25 s (covers depth ≤ 15).
 *     Add +3 s per depth above 15, capped at 180 s total.
 */

const EVAL_TIMEOUT_BASE_MS = 25000;
const EVAL_TIMEOUT_MAX_MS = 180000;

/**
 * @param {number} depth  Requested search depth. 0 = infinite.
 * @param {number|null|undefined} searchMovetime  Optional movetime cap in ms.
 * @returns {number}  Timeout in ms. `Infinity` when depth=0 and no movetime.
 */
export function getEvalTimeout(depth, searchMovetime) {
  if (depth === 0) {
    if (searchMovetime) return searchMovetime + 15000;
    return Infinity;
  }
  return Math.min(
    EVAL_TIMEOUT_MAX_MS,
    Math.max(EVAL_TIMEOUT_BASE_MS, EVAL_TIMEOUT_BASE_MS + (depth - 15) * 3000),
  );
}
