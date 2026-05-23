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
 * Relative luminance (0–255 scale) of a `#rgb` / `#rrggbb` colour, or null
 * if unparseable. Used to tell white from black variant pieces by the SVG
 * fill palette (white pieces have a light body fill, black a dark one).
 * @param {string} hex
 * @returns {number | null}
 */
export function hexLuminance(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Mean luminance of a list of `#hex` fills (non-hex entries ignored), or null
 * if none parse. The white and black sprites share highlight (#fff) and
 * outline (#1a1a1a) fills, so those cancel out when two groups are compared;
 * the distinguishing body fill drives the difference.
 * @param {string[]} fills
 * @returns {number | null}
 */
export function meanFillLuminance(fills) {
  const lums = [];
  for (const f of fills || []) {
    const l = hexLuminance(f);
    if (l != null) lums.push(l);
  }
  if (!lums.length) return null;
  return lums.reduce((a, b) => a + b, 0) / lums.length;
}

/**
 * Decide white/black/orientation for a chess.com variant board from per
 * `data-color` groups. `data-color` values are arbitrary per game, so colour
 * is taken from the SVG luminance (lighter group = white) and orientation
 * from vertical position (white nearer the top ⇒ board is flipped ⇒ the
 * player is Black).
 *
 * `confident` is true only with a clear two-sided opening-like layout (both
 * sides ≥ 8 pieces, distinct luminance, well-separated vertically) so callers
 * lock orientation at game start and never on a lopsided/end-game read.
 *
 * @param {Array<{ dataColor: string, lum: number|null, avgCyNorm: number, count: number }>} groups
 * @returns {{ white: string, black: string, flipped: boolean, playerColor: 'w'|'b', confident: boolean } | null}
 */
export function classifyVariantBoard(groups) {
  const valid = (groups || []).filter((g) => g && g.lum != null && g.count > 0);
  if (valid.length === 0) return null;
  if (valid.length === 1) {
    return {
      white: valid[0].dataColor,
      black: valid[0].dataColor,
      flipped: false,
      playerColor: 'w',
      confident: false,
    };
  }
  const sorted = [...valid].sort((a, b) => b.count - a.count);
  const a = sorted[0];
  const b = sorted[1];
  const whiteG = a.lum >= b.lum ? a : b;
  const blackG = a.lum >= b.lum ? b : a;
  // White nearer the visual top (smaller normalized cy) ⇒ board is flipped.
  const flipped = whiteG.avgCyNorm < blackG.avgCyNorm;
  const confident =
    whiteG.count >= 8 &&
    blackG.count >= 8 &&
    Math.abs(whiteG.lum - blackG.lum) > 8 &&
    Math.abs(whiteG.avgCyNorm - blackG.avgCyNorm) > 0.25;
  return {
    white: whiteG.dataColor,
    black: blackG.dataColor,
    flipped,
    playerColor: flipped ? 'b' : 'w',
    confident,
  };
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
