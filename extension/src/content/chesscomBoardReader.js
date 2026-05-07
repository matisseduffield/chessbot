// @ts-check
/**
 * Pure Chess.com board → FEN reader (primary path).
 *
 * Plan §2.1 / Phase 3: extends the site-adapter contract test net to
 * Chess.com. Scope kept narrow on purpose — only the primary
 * piece-class detection path is here:
 *
 *   1. Piece type from `class="wp"` / `class="bk"` etc.
 *   2. Position from either `getBoundingClientRect` or the
 *      `square-XY` class fallback.
 *   3. Flip detection from JS property / class / attribute /
 *      shadow-DOM indicator / coordinate labels.
 *
 * Out of scope (still authoritative inside content.js):
 *   - Variant pages that use `data-piece` + `data-color` and
 *     classify colour by piece-Y-centroid.
 *   - Crazyhouse / drop pockets.
 *   - Premove ghost-piece opacity filtering (we still skip the
 *     `ghost` class but don't compute opacity in jsdom).
 *
 * Same testability shape as the other readers — takes a `Document`
 * + element-level helpers so jsdom fixtures don't need a layout
 * engine to produce a valid FEN.
 */

import { gridToFenBoard } from './boardMath.js';

const PIECE_CLASS_RE = /\b([wb])([prnbqk])\b/;
const SQUARE_CLASS_RE = /\bsquare-(\d)(\d)\b/;

/**
 * Decode a chess.com piece class token (`"wp"`, `"bk"`, etc.) into a
 * FEN character. Returns null if no `wb-letter` token is present.
 *
 * @param {string} className
 * @returns {string | null}
 */
export function pieceClassToFenCharCC(className) {
  if (!className || typeof className !== 'string') return null;
  const m = className.match(PIECE_CLASS_RE);
  if (!m) return null;
  return m[1] === 'w' ? m[2].toUpperCase() : m[2].toLowerCase();
}

/**
 * Decode a chess.com `square-XY` class into a `{ file, rank }` pair
 * where file/rank are zero-indexed (a1 = file 0, rank 0).
 *
 * The chess.com encoding is `square-<file><rank>` with file/rank both
 * `1..8`, e.g. `square-12` is a1 (Wait — actually it's file=1, rank=2;
 * inspect to confirm). Returns null if no match.
 *
 * @param {string} className
 * @returns {{ file: number, rank: number } | null}
 */
export function parseChesscomSquareClass(className) {
  if (!className || typeof className !== 'string') return null;
  const m = className.match(SQUARE_CLASS_RE);
  if (!m) return null;
  const file = parseInt(m[1], 10) - 1;
  const rank = parseInt(m[2], 10) - 1;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return { file, rank };
}

/**
 * Detect whether a chess.com board is flipped. Takes the board
 * element and an optional `cachedPlayerColor` so the production
 * caller can pass `_cachedPlayerColor === 'b'` directly.
 *
 * Tries each method in order:
 *   1. Cached player color (most reliable when available).
 *   2. JS property on the custom element (`isFlipped` / `flipped`).
 *   3. `flipped` class on the board element.
 *   4. `flipped` attribute on the board element.
 *   5. Shadow-DOM `[class*='flipped']` / `[flipped]` indicator.
 *   6. Ancestor elements with flip indicator (variant pages).
 *   7. Coordinate labels — `h` first means flipped.
 *
 * @param {Element} board
 * @param {{
 *   cachedPlayerColor?: 'w' | 'b' | null,
 *   doc?: Document,
 * }} [opts]
 * @returns {boolean}
 */
export function isChesscomFlipped(board, opts = {}) {
  return detectChesscomFlipConfidence(board, opts) === 'flipped';
}

/**
 * Tri-state flip detection. Returns 'unknown' when none of the
 * positive signals (cached player color, JS property, flipped class,
 * shadow-DOM marker, ancestor class, coord labels) fire — callers can
 * then prompt the user instead of silently guessing 'unflipped'.
 *
 * Note that the JS-property branch CAN distinguish flipped/unflipped
 * (some chess.com builds expose `flipped: false`), but the others are
 * positive-only — they prove "flipped" but not "unflipped".
 *
 * @param {Element} board
 * @param {{
 *   cachedPlayerColor?: 'w' | 'b' | null,
 *   doc?: Document,
 * }} [opts]
 * @returns {'flipped' | 'unflipped' | 'unknown'}
 */
export function detectChesscomFlipConfidence(board, opts = {}) {
  if (opts.cachedPlayerColor === 'b') return 'flipped';
  if (opts.cachedPlayerColor === 'w') return 'unflipped';
  const doc = opts.doc || board.ownerDocument || globalThis.document;

  // 1. JS property on the custom element — explicit boolean.
  try {
    const b = /** @type {any} */ (board);
    if (b.isFlipped === true || b.flipped === true) return 'flipped';
    if (b.isFlipped === false || b.flipped === false) return 'unflipped';
  } catch {
    /* ignore */
  }

  // 2. flipped class on the board element.
  if (board.classList && board.classList.contains('flipped')) return 'flipped';
  // 3. flipped attribute.
  if (board.getAttribute && board.getAttribute('flipped') !== null) return 'flipped';

  // 4. Shadow DOM flipped indicator.
  const root = /** @type {any} */ (board).shadowRoot;
  if (root) {
    const inner = root.querySelector("[class*='flipped'], [flipped]");
    if (inner) return 'flipped';
  }

  // 5. Ancestor elements (variant pages may carry the class up
  // a couple of levels rather than on the board itself).
  let ancestor = board.parentElement;
  for (let i = 0; i < 5 && ancestor && ancestor !== (doc && doc.body); i++) {
    const acls =
      typeof ancestor.className === 'string'
        ? ancestor.className
        : ancestor.getAttribute && ancestor.getAttribute('class');
    if (acls && /\bflipped\b/i.test(acls)) return 'flipped';
    if (ancestor.getAttribute && ancestor.getAttribute('flipped') !== null) return 'flipped';
    ancestor = ancestor.parentElement;
  }

  // 6. Coordinate labels — h first means flipped, a first means
  // unflipped, anything else doesn't tell us.
  if (doc) {
    const coords = doc.querySelectorAll(
      ".coordinates-row, .coords-row, .coords-files, coords-files, [class*='coord'], [class*='Coord'], [class*='notation']",
    );
    for (const c of coords) {
      const txt = (c.textContent || '').trim().toLowerCase();
      if (txt.startsWith('h')) return 'flipped';
      if (txt.startsWith('a')) return 'unflipped';
    }
  }

  return 'unknown';
}

/**
 * Read a chess.com board into a FEN board-part string. Primary path
 * only — uses each piece's `square-XY` class for position. Variant
 * pages (data-piece + data-color) and drop pockets fall back to the
 * inline reader in content.js for now.
 *
 * Note on flip: chess.com's `square-XY` class names the LOGICAL square
 * (a1 = `square-11`), not the visual one — so flip detection isn't
 * needed to reconstruct the board, only to interpret turns / arrows
 * (handled outside this function).
 *
 * @param {Document} doc
 * @param {{
 *   pieceSelector?: string,
 *   readPocket?: () => string,
 * }} [opts]
 * @returns {string | null}
 */
export function chesscomBoardToFen(doc, opts = {}) {
  const board =
    doc.querySelector('wc-chess-board') ||
    doc.querySelector('chess-board') ||
    doc.querySelector('[class*="board"][class*="chess"]');
  if (!board) return null;

  const selector = opts.pieceSelector || '[class*="piece"]';
  const pieces = board.querySelectorAll(selector);
  if (!pieces.length) return null;

  /** @type {(string | null)[][]} */
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  let placed = 0;

  for (const piece of pieces) {
    const classes =
      typeof piece.className === 'string' ? piece.className : piece.getAttribute('class') || '';
    if (/\bghost\b/.test(classes)) continue;
    const fenChar = pieceClassToFenCharCC(classes);
    if (!fenChar) continue;
    const sq = parseChesscomSquareClass(classes);
    if (!sq) continue;
    // grid rank 0 = chess rank 8, so invert when placing.
    grid[7 - sq.rank][sq.file] = fenChar;
    placed++;
  }

  if (placed < 2) return null;

  const readPocket = opts.readPocket || (() => '');
  return gridToFenBoard(grid, readPocket());
}
