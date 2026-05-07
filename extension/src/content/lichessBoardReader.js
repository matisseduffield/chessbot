// @ts-check
/**
 * Pure Lichess / PlayStrategy (Chessground) board → FEN reader.
 *
 * Extracted from content.js (plan §2.1, P2.G) so site-adapter contract
 * tests can drive it against checked-in HTML fixtures via jsdom — that
 * way an upstream selector change (e.g. lichess renames `cg-board` or
 * tweaks the piece class shape) breaks a unit test instead of going
 * unnoticed until a real user complains.
 *
 * The reader takes a `document` (real or jsdom) so callers in the
 * content script just pass `document` and tests pass `jsdom.window.document`.
 *
 * Pocket pieces (crazyhouse / drop variants) live in different markup
 * and require detected variant context the content script owns; this
 * module exposes a `readPocket` hook so callers can supply that
 * separately. The default is `() => ''` (no pocket).
 */

import { parseTranslate, pieceClassToFenChar, translateToSquare } from './lichessBoard.js';
import { gridToFenBoard } from './boardMath.js';

/**
 * Detect whether the Lichess/PlayStrategy board is flipped (black at bottom).
 * Looks at the `orientation-*` class on `.cg-wrap` first, then falls back
 * to coordinate labels.
 *
 * @param {Document} doc
 * @returns {boolean}
 */
export function isLichessFlipped(doc) {
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
  const ranks = doc.querySelector('coords.ranks coord:first-child');
  if (ranks && ranks.textContent && ranks.textContent.trim() === '1') return true;
  return false;
}

/**
 * Read the current Chessground board into a FEN board-part string.
 *
 * Returns null if the board element is absent or empty (caller treats
 * that as "no board on this page yet"). Geometry comes from the
 * caller-provided rect so jsdom fixtures — which don't lay out — can
 * still produce valid output. Production code passes
 * `board.getBoundingClientRect()`.
 *
 * @param {Document} doc
 * @param {{
 *   boardRect?: { width: number, height: number },
 *   readPocket?: () => string,
 * }} [opts]
 * @returns {string | null} FEN board portion, or null on miss.
 */
export function lichessBoardToFen(doc, opts = {}) {
  const board = doc.querySelector('cg-board');
  if (!board) return null;

  const pieces = board.querySelectorAll('piece');
  if (!pieces.length) return null;

  const flipped = isLichessFlipped(doc);

  // jsdom doesn't compute layout, so getBoundingClientRect returns
  // zeros. Fall back to a synthetic 8×8 of unit squares (1px each)
  // when the board has no measurable size — pieces' transform values
  // in fixtures are also expressed in those same arbitrary units.
  const measured =
    typeof board.getBoundingClientRect === 'function' ? board.getBoundingClientRect() : null;
  const rect = opts.boardRect || measured;
  let squareW;
  let squareH;
  if (rect && rect.width > 0 && rect.height > 0) {
    squareW = rect.width / 8;
    squareH = rect.height / 8;
  } else {
    // Each fixture piece's transform is in board-square units (0..7)
    // multiplied by FIXTURE_SQ_SIZE; tests opt into that convention.
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

    const fenChar = pieceClassToFenChar(piece.className);
    if (!fenChar) continue;

    grid[sq.rank][sq.file] = fenChar;
  }

  const readPocket = opts.readPocket || (() => '');
  return gridToFenBoard(grid, readPocket());
}
