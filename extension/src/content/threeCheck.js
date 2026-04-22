/**
 * Pure 3-check / king-safety helpers extracted from content.js.
 * DOM-free and fully unit-testable. Plan §2.1 (content.js split).
 */

import { fenBoardToGrid } from './boardMath.js';

/**
 * Brute-force attack scan: is the given colour's king attacked on this
 * board? Used for the 3-check variant counter and for marking ply-check
 * annotations when the page move-list isn't trustworthy.
 *
 * @param {string} boardPart  FEN board portion (ranks joined by `/`)
 * @param {"w"|"b"} kingColor
 * @returns {boolean}
 */
export function isKingInCheck(boardPart, kingColor) {
  const grid = fenBoardToGrid(boardPart);
  const kingChar = kingColor === 'w' ? 'K' : 'k';
  let kr = -1,
    kf = -1;
  for (let r = 0; r < grid.length; r++)
    for (let f = 0; f < grid[r].length; f++)
      if (grid[r][f] === kingChar) {
        kr = r;
        kf = f;
      }
  if (kr < 0) return false;
  const nR = grid.length,
    nF = grid[0].length;
  const atk =
    kingColor === 'b'
      ? { P: 'P', N: 'N', B: 'B', R: 'R', Q: 'Q' }
      : { P: 'p', N: 'n', B: 'b', R: 'r', Q: 'q' };
  for (const [dr, df] of [
    [-2, -1],
    [-2, 1],
    [-1, -2],
    [-1, 2],
    [1, -2],
    [1, 2],
    [2, -1],
    [2, 1],
  ]) {
    const r = kr + dr,
      f = kf + df;
    if (r >= 0 && r < nR && f >= 0 && f < nF && grid[r][f] === atk.N) return true;
  }
  for (const [dr, df] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    for (let i = 1; i < 8; i++) {
      const r = kr + dr * i,
        f = kf + df * i;
      if (r < 0 || r >= nR || f < 0 || f >= nF) break;
      const p = grid[r][f];
      if (p) {
        if (p === atk.R || p === atk.Q) return true;
        break;
      }
    }
  }
  for (const [dr, df] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    for (let i = 1; i < 8; i++) {
      const r = kr + dr * i,
        f = kf + df * i;
      if (r < 0 || r >= nR || f < 0 || f >= nF) break;
      const p = grid[r][f];
      if (p) {
        if (p === atk.B || p === atk.Q) return true;
        break;
      }
    }
  }
  if (kingColor === 'b') {
    if (kr + 1 < nR && kf - 1 >= 0 && grid[kr + 1][kf - 1] === atk.P) return true;
    if (kr + 1 < nR && kf + 1 < nF && grid[kr + 1][kf + 1] === atk.P) return true;
  } else {
    if (kr - 1 >= 0 && kf - 1 >= 0 && grid[kr - 1][kf - 1] === atk.P) return true;
    if (kr - 1 >= 0 && kf + 1 < nF && grid[kr - 1][kf + 1] === atk.P) return true;
  }
  return false;
}
