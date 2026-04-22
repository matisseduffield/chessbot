// Pure helpers for chess.com variant board scraping.
// DOM access stays in content.js; these operate on extracted samples.

/**
 * Given a list of samples { dataColor, cy } (one per piece centre on the
 * board) and whether the board is flipped, decide which `data-color`
 * attribute corresponds to which logical side.
 *
 * Heuristic: the group whose average Y is larger (= toward the visual
 * bottom of the board) is the "bottom" player. On an unflipped board the
 * bottom is white; flipped, it is black. Falls back to literal
 * "white"/"black"/"w"/"b" keys, then to numeric sort.
 *
 * @param {Array<{ dataColor: string, cy: number }>} samples
 * @param {boolean} flipped
 * @returns {{ white: string, black: string } | null}
 */
export function classifyVariantColors(samples, flipped) {
  const groups = {};
  for (const { dataColor, cy } of samples) {
    if (!dataColor) continue;
    if (!groups[dataColor]) groups[dataColor] = { sumY: 0, count: 0 };
    groups[dataColor].sumY += cy;
    groups[dataColor].count++;
  }
  const keys = Object.keys(groups);
  if (keys.length === 0) return null;
  if (keys.length === 1) return { white: keys[0], black: keys[0] };
  if (keys.length === 2) {
    const avg0 = groups[keys[0]].sumY / groups[keys[0]].count;
    const avg1 = groups[keys[1]].sumY / groups[keys[1]].count;
    const bottomKey = avg0 > avg1 ? keys[0] : keys[1];
    const topKey = avg0 > avg1 ? keys[1] : keys[0];
    const whiteKey = flipped ? topKey : bottomKey;
    const blackKey = flipped ? bottomKey : topKey;
    return { white: whiteKey, black: blackKey };
  }
  // Fallback: literal color names
  const keysLower = keys.map((k) => k.toLowerCase());
  const wIdx =
    keysLower.indexOf('white') !== -1 ? keysLower.indexOf('white') : keysLower.indexOf('w');
  if (wIdx !== -1) {
    const wk = keys[wIdx];
    const bk = keys.find((k) => k !== wk) || keys[0];
    return { white: wk, black: bk };
  }
  const bIdx =
    keysLower.indexOf('black') !== -1 ? keysLower.indexOf('black') : keysLower.indexOf('b');
  if (bIdx !== -1) {
    const bk = keys[bIdx];
    const wk = keys.find((k) => k !== bk) || keys[0];
    return { white: wk, black: bk };
  }
  const sorted = [...keys].sort((a, b) => {
    const na = parseInt(a);
    const nb = parseInt(b);
    if (isNaN(na) || isNaN(nb)) return a < b ? -1 : a > b ? 1 : 0;
    return na - nb;
  });
  return { white: sorted[0], black: sorted[1] || sorted[0] };
}

/**
 * Last-move piece color → whose turn it is next (inverse).
 * @param {"w" | "b" | "white" | "black" | null | undefined} color
 * @returns {"w" | "b" | null}
 */
export function nextTurnAfterMove(color) {
  if (!color) return null;
  const c = String(color).toLowerCase();
  if (c === 'w' || c === 'white') return 'b';
  if (c === 'b' || c === 'black') return 'w';
  return null;
}
