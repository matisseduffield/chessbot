// @ts-check
/**
 * Pure PlayStrategy (Chessground) board → FEN reader.
 *
 * Plan §2.1 / Phase 3: extends the site-adapter contract test net
 * (Lichess landed in P2.G) to PlayStrategy. The two sites share the
 * Chessground markup (`<cg-board><piece transform="translate(...)">`)
 * but the piece-class scheme is different:
 *   Lichess:       `"white pawn"` / `"black knight"` / etc.
 *   PlayStrategy:  `"p1 p-piece ally"` / `"p2 n-piece enemy"` / etc.
 *
 * That's the only meaningful divergence; the geometry helpers from
 * `lichessBoard.js` (parseTranslate / translateToSquare) and the FEN
 * encoder from `boardMath.js` (gridToFenBoard) are reused as-is.
 *
 * Same testability shape as lichessBoardReader.js: takes a `Document`
 * (real or jsdom) and an optional `boardRect` so fixtures don't need
 * actual layout to produce valid output.
 */

import { parseTranslate, translateToSquare } from './lichessBoard.js';
import { gridToFenBoard } from './boardMath.js';

const TYPE_MAP = {
  'p-piece': 'p',
  'r-piece': 'r',
  'n-piece': 'n',
  'b-piece': 'b',
  'q-piece': 'q',
  'k-piece': 'k',
};

/**
 * @param {string} className
 * @returns {string | null}
 */
export function pieceClassToFenCharP1P2(className) {
  if (!className || typeof className !== 'string') return null;
  const isP1 = className.includes('p1');
  const isP2 = className.includes('p2');
  if (!isP1 && !isP2) return null;
  for (const [name, ch] of Object.entries(TYPE_MAP)) {
    if (className.includes(name)) {
      return isP1 ? ch.toUpperCase() : ch;
    }
  }
  return null;
}

/**
 * Detect whether a PlayStrategy board is flipped. Uses the same
 * `orientation-*` class on `.cg-wrap` that Lichess does, plus the
 * PlayStrategy-specific `orientation-p2`.
 *
 * @param {Document} doc
 * @returns {boolean}
 */
export function isPlayStrategyFlipped(doc) {
  const cgWrap = doc.querySelector('.cg-wrap');
  if (cgWrap) {
    if (
      cgWrap.classList.contains('orientation-black') ||
      cgWrap.classList.contains('orientation-p2')
    ) {
      return true;
    }
    if (
      cgWrap.classList.contains('orientation-white') ||
      cgWrap.classList.contains('orientation-p1')
    ) {
      return false;
    }
  }
  return false;
}

/**
 * Read a PlayStrategy Chessground board into a FEN board-part string.
 *
 * @param {Document} doc
 * @param {{
 *   boardRect?: { width: number, height: number },
 *   readPocket?: () => string,
 * }} [opts]
 * @returns {string | null}
 */
export function playstrategyBoardToFen(doc, opts = {}) {
  const board = doc.querySelector('cg-board');
  if (!board) return null;

  const pieces = board.querySelectorAll('piece');
  if (!pieces.length) return null;

  const flipped = isPlayStrategyFlipped(doc);

  const measured =
    typeof board.getBoundingClientRect === 'function' ? board.getBoundingClientRect() : null;
  const rect = opts.boardRect || measured;
  let squareW;
  let squareH;
  if (rect && rect.width > 0 && rect.height > 0) {
    squareW = rect.width / 8;
    squareH = rect.height / 8;
  } else {
    squareW = 1;
    squareH = 1;
  }

  /** @type {(string | null)[][]} */
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));

  for (const piece of pieces) {
    if (piece.classList.contains('ghost')) continue;
    const style =
      /** @type {HTMLElement} */ (piece).style &&
      /** @type {HTMLElement} */ (piece).style.transform;
    const xy = parseTranslate(style);
    if (!xy) continue;
    const sq = translateToSquare(xy.px, xy.py, squareW, squareH, flipped);
    if (!sq) continue;
    const fenChar = pieceClassToFenCharP1P2(piece.className);
    if (!fenChar) continue;
    grid[sq.rank][sq.file] = fenChar;
  }

  const readPocket = opts.readPocket || (() => '');
  return gridToFenBoard(grid, readPocket());
}
