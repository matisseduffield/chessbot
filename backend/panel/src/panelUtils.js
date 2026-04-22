// Pure utility functions for the panel UI.
// Plan §2.1 (monolith extraction) — these were previously defined inline in
// backend/panel/index.html. Keeping them in a module lets us unit-test them
// under vitest and sets up the progressive migration toward a proper Vite
// build (tracked as the final "Large" item in plans/improvement-plan.md).

/**
 * Escape HTML-significant characters for safe interpolation.
 * @param {unknown} s
 * @returns {string}
 */
export function escHtml(s) {
  if (s === null || s === undefined || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Parse a 6-digit #RRGGBB hex colour into {r, g, b} integers.
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number }}
 */
export function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

/**
 * Lighten a hex colour by blending toward white.
 * @param {string} hex  "#RRGGBB"
 * @param {number} amount 0..1
 * @returns {string}
 */
export function lighten(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  const lr = Math.min(255, Math.round(r + (255 - r) * amount));
  const lg = Math.min(255, Math.round(g + (255 - g) * amount));
  const lb = Math.min(255, Math.round(b + (255 - b) * amount));
  return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
}

/**
 * Format an engine score/mate for display: "+1.2", "−M3", etc.
 * @param {{ score?: number | null, mate?: number | null }} line
 * @returns {string}
 */
export function formatScore(line) {
  if (line && line.mate !== undefined && line.mate !== null) {
    return (line.mate >= 0 ? '+' : '−') + 'M' + Math.abs(line.mate);
  }
  if (line && line.score !== undefined && line.score !== null) {
    const v = line.score / 100;
    return (v >= 0 ? '+' : '') + v.toFixed(1);
  }
  return '?';
}

/**
 * Derive board dimensions from a FEN's piece-placement field.
 * Supports non-8x8 variants (e.g. capablanca 10x8, grand 10x10) and
 * ignores the Crazyhouse pocket `[...]` suffix.
 *
 * @param {string} fen
 * @returns {{ files: number, ranks: number }}
 */
export function parseBoardDimensions(fen) {
  if (!fen) return { files: 8, ranks: 8 };
  let boardPart = fen.split(' ')[0];
  boardPart = boardPart.replace(/\[.*?\]$/g, '');
  const rows = boardPart.split('/');
  const ranks = rows.length;
  let maxFiles = 0;
  for (const row of rows) {
    let files = 0;
    let numBuf = '';
    for (const ch of row) {
      if (ch >= '0' && ch <= '9') {
        numBuf += ch;
      } else {
        if (numBuf) {
          files += parseInt(numBuf);
          numBuf = '';
        }
        if (ch !== '+' && ch !== '~') files++;
      }
    }
    if (numBuf) files += parseInt(numBuf);
    if (files > maxFiles) maxFiles = files;
  }
  return { files: maxFiles || 8, ranks: ranks || 8 };
}
