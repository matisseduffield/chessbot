/**
 * Pure helper that applies a UCI move string to a FEN board part
 * and returns the resulting board part. Extracted from content.js
 * (plan §2.1) so it can be unit-tested without a DOM.
 *
 * Input:  full FEN ("...") and UCI like "e2e4" or "e7e8q"
 * Output: new board part ("rnbq.../.../..." without side-to-move)
 *         or null if the move is structurally invalid.
 *
 * Behavior preserved from the original:
 *   - Handles castling by moving the rook when the king moves 2 files.
 *   - Handles en passant by removing the captured pawn when a pawn
 *     moves diagonally to an empty square.
 *   - Handles promotion by replacing the piece letter.
 *   - Returns null when the source square is empty or uci is malformed.
 *
 * This is intentionally not a full legality checker — callers pass
 * moves they've already resolved from the engine or the DOM.
 */

/**
 * @param {string} fen Full FEN string. Only the board part is used.
 * @param {string} uci UCI move like "e2e4" or "e7e8q".
 * @returns {string|null} New board part, or null on malformed input.
 */
export function applyUciMoveToBoard(fen, uci) {
  if (!fen || !uci || uci.length < 4) return null;
  const parts = fen.split(' ');
  const board = parts[0];
  const rows = board.split('/');
  if (rows.length !== 8) return null;

  const grid = rows.map((row) => {
    let expanded = '';
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') expanded += '.'.repeat(parseInt(ch));
      else expanded += ch;
    }
    return expanded.split('');
  });

  const fc = uci.charCodeAt(0) - 97;
  const fr = 8 - parseInt(uci[1]);
  const tc = uci.charCodeAt(2) - 97;
  const tr = 8 - parseInt(uci[3]);
  const promo = uci.length > 4 ? uci[4] : null;

  if (fr < 0 || fr > 7 || fc < 0 || fc > 7 || tr < 0 || tr > 7 || tc < 0 || tc > 7) {
    return null;
  }

  const piece = grid[fr][fc];
  if (piece === '.') return null;

  const destWasEmpty = grid[tr][tc] === '.';

  grid[fr][fc] = '.';
  let placed = piece;
  if (promo) placed = piece === piece.toUpperCase() ? promo.toUpperCase() : promo.toLowerCase();
  grid[tr][tc] = placed;

  if (piece.toLowerCase() === 'k' && Math.abs(fc - tc) === 2) {
    if (tc > fc) {
      grid[fr][7] = '.';
      grid[fr][5] = piece === 'K' ? 'R' : 'r';
    } else {
      grid[fr][0] = '.';
      grid[fr][3] = piece === 'K' ? 'R' : 'r';
    }
  }

  if (piece.toLowerCase() === 'p' && fc !== tc && destWasEmpty) {
    const epRow = piece === 'P' ? tr + 1 : tr - 1;
    if (epRow >= 0 && epRow < 8) {
      const captured = grid[epRow][tc];
      if (captured.toLowerCase() === 'p' && captured !== piece) grid[epRow][tc] = '.';
    }
  }

  return grid
    .map((row) => {
      let s = '';
      let empty = 0;
      for (const c of row) {
        if (c === '.') {
          empty++;
        } else {
          if (empty) {
            s += empty;
            empty = 0;
          }
          s += c;
        }
      }
      if (empty) s += empty;
      return s;
    })
    .join('/');
}
