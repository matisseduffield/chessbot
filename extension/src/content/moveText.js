/**
 * Pure helpers for inferring whose turn it is from move-list text.
 *
 * The DOM scraping lives in content.js (site-specific selectors), but
 * the *logic* — "is this DOM node actually a move?" and "given N plies
 * played, whose turn is next?" — is pure string/number work and
 * belongs here. Plan §2.1 content.js split.
 */

/**
 * True if the trimmed text looks like a real SAN/LAN move token and
 * not a move number (`1.`), blank, or pure punctuation. Used to filter
 * move-list DOM children before counting plies.
 *
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
export function isRealMoveText(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (!t) return false;
  if (/^\d+\.?$/.test(t)) return false;
  return /[a-hNBRQKO]/.test(t);
}

/**
 * Given the number of plies (half-moves) already played, whose turn is
 * next? Even ply count → white to move, odd → black to move.
 *
 * @param {number} plyCount
 * @returns {"w"|"b"|null}
 */
export function plyCountToTurn(plyCount) {
  if (!Number.isFinite(plyCount) || plyCount < 0) return null;
  return (plyCount | 0) % 2 === 0 ? 'w' : 'b';
}

/**
 * Parse the text of the last row in a 2-column (white | black) move
 * list and decide whose turn is next.
 *
 *   "12. Nf3 Nc6"   → white has already replied → white's turn next
 *   "12. Nf3"       → only white's ply shown   → black's turn next
 *
 * @param {string} text
 * @returns {"w"|"b"}
 */
export function parseLastRowTurn(text) {
  const stripped = String(text || '')
    .replace(/^\d+\.?\s*/, '')
    .trim();
  const parts = stripped.split(/\s+/);
  if (parts.length >= 2 && parts[1] && !/^[\d.]+$/.test(parts[1])) {
    return 'w';
  }
  return 'b';
}

/**
 * Convenience: given an array of arbitrary move-list DOM node texts,
 * filter down to the ones that are real moves, then decide whose turn
 * is next. Returns null if no real moves were seen.
 *
 * @param {Array<string|null|undefined>} texts
 * @returns {"w"|"b"|null}
 */
export function turnFromMoveTexts(texts) {
  if (!Array.isArray(texts)) return null;
  const real = texts.filter(isRealMoveText);
  if (real.length === 0) return null;
  return plyCountToTurn(real.length);
}
