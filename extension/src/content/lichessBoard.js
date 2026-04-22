// Pure helpers for reading Lichess / PlayStrategy (chessground) boards.
// DOM access stays in content.js; these operate on already-extracted strings/numbers.

const TYPE_MAP = {
  pawn: 'p',
  rook: 'r',
  knight: 'n',
  bishop: 'b',
  queen: 'q',
  king: 'k',
};

/**
 * Parse a chessground piece `transform: translate(Xpx, Ypx)` string.
 * @param {string | undefined | null} transform
 * @returns {{ px: number, py: number } | null}
 */
export function parseTranslate(transform) {
  if (!transform) return null;
  const m = transform.match(/translate\((-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\)/);
  if (!m) return null;
  return { px: parseFloat(m[1]), py: parseFloat(m[2]) };
}

/**
 * Map a chessground piece class (e.g. "white pawn") to a FEN piece character.
 * @param {string} className
 * @returns {string | null} 'P','p','r',... or null if unrecognised
 */
export function pieceClassToFenChar(className) {
  if (!className || typeof className !== 'string') return null;
  const isWhite = className.includes('white');
  const isBlack = className.includes('black');
  if (!isWhite && !isBlack) return null;
  for (const name of Object.keys(TYPE_MAP)) {
    if (className.includes(name)) {
      const ch = TYPE_MAP[name];
      return isWhite ? ch.toUpperCase() : ch;
    }
  }
  return null;
}

/**
 * Convert a piece's translate(px, py) into board coordinates, honouring flip.
 * Returns null if the computed square is out of bounds.
 *
 * @param {number} px
 * @param {number} py
 * @param {number} squareW
 * @param {number} squareH
 * @param {boolean} flipped
 * @returns {{ file: number, rank: number } | null} file 0-7 (a-h), rank 0-7 (top row first)
 */
export function translateToSquare(px, py, squareW, squareH, flipped) {
  if (!(squareW > 0) || !(squareH > 0)) return null;
  let file = Math.round(px / squareW);
  let rank = Math.round(py / squareH);
  if (flipped) {
    file = 7 - file;
    rank = 7 - rank;
  }
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return { file, rank };
}

/**
 * Convert a piece's board-relative centre (cx, cy) into logical square.
 * Used by chess.com reader. Unlike `translateToSquare`, this uses Math.floor
 * and treats `flipped` differently (visual-file → logical-file = 7-visual).
 *
 * Returns null if the centre is outside the board by more than 5px on either axis.
 *
 * @param {number} cx board-relative x (piece centre - boardRect.left)
 * @param {number} cy board-relative y
 * @param {number} squareW
 * @param {number} squareH
 * @param {number} boardW
 * @param {number} boardH
 * @param {boolean} flipped
 * @returns {{ file: number, rank: number } | null}
 */
export function pieceCenterToSquare(cx, cy, squareW, squareH, boardW, boardH, flipped) {
  if (!(squareW > 0) || !(squareH > 0)) return null;
  if (cx < -5 || cx > boardW + 5 || cy < -5 || cy > boardH + 5) return null;
  let visFile = Math.floor(cx / squareW);
  let visRank = Math.floor(cy / squareH);
  visFile = Math.max(0, Math.min(7, visFile));
  visRank = Math.max(0, Math.min(7, visRank));
  const file = flipped ? 7 - visFile : visFile;
  const rank = flipped ? visRank : 7 - visRank;
  return { file, rank };
}
