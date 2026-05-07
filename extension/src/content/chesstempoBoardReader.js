// @ts-check
/**
 * Pure ChessTempo board → FEN reader.
 *
 * Plan §2.1 / Phase 3: site-adapter contract test net for ChessTempo.
 * Different markup from Lichess / PlayStrategy:
 *   - Container is `<chess-board>`, not `<cg-board>`.
 *   - Pieces sit at percentage-based `style="left: X%; top: Y%"` (each
 *     square is 12.5%).
 *   - Class shape: `"ct-pieceClass ct-piece-whiterook"` etc. — color
 *     and type fused in one token.
 *   - There's a fast-path: ChessTempo emits an `<h2>FEN: ...</h2>` for
 *     screen readers, which is the most reliable source when present.
 *
 * Same testability shape as the other readers — takes a `Document`,
 * defaults to `document` for the production caller.
 */

import { gridToFenBoard } from './boardMath.js';

const TYPE_MAP = {
  pawn: 'p',
  rook: 'r',
  knight: 'n',
  bishop: 'b',
  queen: 'q',
  king: 'k',
};

/**
 * Try to extract the FEN from the accessibility heading ChessTempo
 * emits (`<h2>FEN: ...</h2>`). Most reliable when it exists; fall back
 * to DOM piece-walking otherwise.
 *
 * @param {Document} doc
 * @returns {string | null}
 */
export function extractFenFromHeading(doc) {
  const fenHeadings = doc.querySelectorAll('chess-board h2');
  for (const h of fenHeadings) {
    const text = (h.textContent || '').trim();
    const match = text.match(/^FEN:\s*(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Decode a `ct-piece-<color><type>` class into a FEN char.
 *
 * @param {string} className
 * @returns {string | null}
 */
export function pieceClassToFenCharCT(className) {
  if (!className || typeof className !== 'string') return null;
  const m = className.match(/ct-piece-(white|black)(pawn|rook|knight|bishop|queen|king)/);
  if (!m) return null;
  const type = TYPE_MAP[/** @type {keyof typeof TYPE_MAP} */ (m[2])];
  if (!type) return null;
  return m[1] === 'white' ? type.toUpperCase() : type.toLowerCase();
}

/**
 * Detect whether a ChessTempo board is flipped. Coordinate labels are
 * the only signal — `h` first or `1` first means flipped.
 *
 * @param {Document} doc
 * @returns {boolean}
 */
export function isChessTempoFlipped(doc) {
  const fileCoords = doc.querySelectorAll(
    'chess-board .ct-board-inner-holder .ct-file-coord, chess-board coords coord',
  );
  if (fileCoords.length > 0) {
    const first = (fileCoords[0].textContent || '').trim().toLowerCase();
    if (first === 'h') return true;
    if (first === 'a') return false;
  }
  const rankCoords = doc.querySelectorAll('chess-board .ct-rank-coord');
  if (rankCoords.length > 0) {
    const first = (rankCoords[0].textContent || '').trim();
    if (first === '1') return true;
    if (first === '8') return false;
  }
  return false;
}

/**
 * Convert a percentage `left` / `top` (each square = 12.5%) into a
 * (file, rank) pair, honouring flip. Pure — exposed for tests.
 *
 * @param {number} leftPct
 * @param {number} topPct
 * @param {boolean} flipped
 * @returns {{ file: number, rank: number } | null}
 */
export function percentToSquare(leftPct, topPct, flipped) {
  if (!Number.isFinite(leftPct) || !Number.isFinite(topPct)) return null;
  let file = Math.round(leftPct / 12.5);
  let rank = Math.round(topPct / 12.5);
  if (flipped) {
    file = 7 - file;
    rank = 7 - rank;
  }
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return { file, rank };
}

/**
 * Read a ChessTempo board into a FEN board-part string. Returns the
 * full FEN if extracted from the accessibility heading; otherwise
 * builds the board from piece elements and lets the caller post-fix
 * any side-to-move/castling fields.
 *
 * @param {Document} doc
 * @param {{ readPocket?: () => string }} [opts]
 * @returns {string | null}
 */
export function chesstempoBoardToFen(doc, opts = {}) {
  // Fast path: if the accessibility heading is present, trust it —
  // it's the only source that captures the full FEN (side-to-move,
  // castling rights, en passant) without having to reconstruct.
  const fromHeading = extractFenFromHeading(doc);
  if (fromHeading) return fromHeading;

  const ctBoard = doc.querySelector('chess-board');
  if (!ctBoard) return null;

  const pieces = ctBoard.querySelectorAll('.ct-pieceClass');
  if (!pieces.length) return null;

  const flipped = isChessTempoFlipped(doc);

  /** @type {(string | null)[][]} */
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));

  for (const piece of pieces) {
    const fenChar = pieceClassToFenCharCT(piece.className);
    if (!fenChar) continue;
    const style = /** @type {HTMLElement} */ (piece).style;
    const left = parseFloat(style?.left);
    const top = parseFloat(style?.top);
    const sq = percentToSquare(left, top, flipped);
    if (!sq) continue;
    grid[sq.rank][sq.file] = fenChar;
  }

  const readPocket = opts.readPocket || (() => '');
  return gridToFenBoard(grid, readPocket());
}
