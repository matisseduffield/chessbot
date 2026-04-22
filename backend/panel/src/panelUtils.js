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

// ── PV move formatting ──────────────────────────────────────
const PV_PIECE_GLYPHS = {
  K: '\u2654',
  Q: '\u2655',
  R: '\u2656',
  B: '\u2657',
  N: '\u2658',
};

/**
 * Wrap leading piece letter in a span with the piece glyph.
 * Pure: operates on an already-escaped SAN string.
 * @param {string} sanEscaped
 * @returns {string}
 */
export function decorateMove(sanEscaped) {
  return String(sanEscaped).replace(
    /^([KQRBN])/,
    (_, p) => `<span class="pv-piece">${PV_PIECE_GLYPHS[p]}</span>`,
  );
}

/**
 * Format a principal variation move list as HTML with alternating move
 * numbers. `moves` is an array of SAN strings. `fen` supplies the starting
 * side-to-move + fullmove number.
 * @param {string[]} moves
 * @param {string} fen
 * @returns {string}
 */
export function formatPVMoves(moves, fen) {
  if (!moves || !moves.length) return '';
  const parts = fen ? fen.split(' ') : [];
  let moveNum = parseInt(parts[5]) || 1;
  let isBlack = parts[1] === 'b';
  let html = '';
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (!isBlack || i === 0) {
      html += `<span class="pv-movenum">${moveNum}${isBlack && i === 0 ? '...' : '.'}</span>`;
    }
    html += `<span class="pv-move">${decorateMove(escHtml(m))}</span>`;
    if (isBlack) moveNum++;
    isBlack = !isBlack;
  }
  return html;
}

// ── Material calculation ────────────────────────────────────
const PIECE_VALUES = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  P: 1,
  N: 3,
  B: 3,
  R: 5,
  Q: 9,
};
const MATERIAL_ICONS = {
  p: '\u265f',
  n: '\u265e',
  b: '\u265d',
  r: '\u265c',
  q: '\u265b',
  P: '\u2659',
  N: '\u2658',
  B: '\u2657',
  R: '\u2656',
  Q: '\u2655',
};
const MATERIAL_BASELINE = {
  p: 8,
  n: 2,
  b: 2,
  r: 2,
  q: 1,
  P: 8,
  N: 2,
  B: 2,
  R: 2,
  Q: 1,
};

/**
 * Compute total material value and per-piece counts for each side from a FEN.
 * @param {string} fen
 * @returns {{ white: number, black: number, whitePieces: Record<string, number>, blackPieces: Record<string, number>, diff: number }}
 */
export function calculateMaterial(fen) {
  if (!fen) {
    return { white: 0, black: 0, whitePieces: {}, blackPieces: {}, diff: 0 };
  }
  const board = fen.split(' ')[0];
  const whitePieces = {};
  const blackPieces = {};
  let whiteVal = 0;
  let blackVal = 0;
  for (const ch of board) {
    if ('PNBRQ'.includes(ch)) {
      whitePieces[ch] = (whitePieces[ch] || 0) + 1;
      whiteVal += PIECE_VALUES[ch];
    } else if ('pnbrq'.includes(ch)) {
      blackPieces[ch] = (blackPieces[ch] || 0) + 1;
      blackVal += PIECE_VALUES[ch];
    }
  }
  return {
    white: whiteVal,
    black: blackVal,
    whitePieces,
    blackPieces,
    diff: whiteVal - blackVal,
  };
}

/**
 * Render the "captured opponent pieces" icon strip for one side.
 * `myColor` is "w" or "b" — the side whose captures we're showing.
 * @param {Record<string, number>} _myPieces
 * @param {Record<string, number>} oppPieces
 * @param {"w" | "b"} myColor
 * @returns {string}
 */
export function materialAdvantageHtml(_myPieces, oppPieces, myColor) {
  const oppKeys = myColor === 'w' ? 'pnbrq' : 'PNBRQ';
  const captured = {};
  for (const ch of oppKeys) {
    const have = oppPieces[ch] || 0;
    const diff = MATERIAL_BASELINE[ch] - have;
    if (diff > 0) captured[ch] = diff;
  }
  let html = '';
  for (const [ch, count] of Object.entries(captured)) {
    for (let i = 0; i < count; i++) {
      html += `<span style="opacity:0.7">${MATERIAL_ICONS[ch]}</span>`;
    }
  }
  return html;
}
