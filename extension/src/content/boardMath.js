/**
 * Pure board math helpers extracted from content.js.
 *
 * Everything here is DOM-free, I/O-free, and fully unit-testable.
 * Plan §2.1 (content.js split).
 *
 * Re-export into content.js one-by-one so the runtime behaviour
 * stays identical; each extraction shrinks the monolith and adds
 * regression tests.
 */

/**
 * Count the number of piece squares in a (possibly fairy-variant) FEN board.
 * Strips pocket notation `[...]` suffix. Treats `+` and `~` promotion markers
 * and digits as non-piece characters.
 * @param {string} boardFen
 * @returns {number}
 */
export function countPieces(boardFen) {
  let n = 0;
  const cleaned = String(boardFen || '').replace(/\[.*?\]$/g, '');
  for (const ch of cleaned) {
    if (ch !== '/' && ch !== '+' && ch !== '~' && (ch < '0' || ch > '9')) n++;
  }
  return n;
}

/**
 * Expand a FEN board string into a 2-D grid of either `null` or a piece char.
 * Rank 0 of the returned array corresponds to rank 8 (top of the FEN).
 * @param {string} boardFen
 * @returns {(string|null)[][]}
 */
export function fenBoardToGrid(boardFen) {
  const grid = [];
  const cleaned = String(boardFen || '').replace(/\[.*?\]$/g, '');
  const rows = cleaned.split('/');
  for (const row of rows) {
    const rank = [];
    let numBuf = '';
    for (const ch of row) {
      if (ch >= '0' && ch <= '9') {
        numBuf += ch;
      } else {
        if (numBuf) {
          const n = parseInt(numBuf, 10);
          for (let i = 0; i < n; i++) rank.push(null);
          numBuf = '';
        }
        if (ch !== '+' && ch !== '~') rank.push(ch);
      }
    }
    if (numBuf) {
      const n = parseInt(numBuf, 10);
      for (let i = 0; i < n; i++) rank.push(null);
    }
    grid.push(rank);
  }
  return grid;
}

/**
 * Parse a UCI move string into source/destination file/rank indices.
 * Returns `null` for malformed input. Supports drop notation (`P@e4`)
 * and multi-digit ranks (for larger variant boards).
 * @param {string} uci
 */
export function uciToSquares(uci) {
  if (!uci || uci.length < 3) return null;
  const dropMatch = uci.match(/^([PNBRQK])@([a-z])(\d+)$/i);
  if (dropMatch) {
    const tf = dropMatch[2].charCodeAt(0) - 97;
    const tr = parseInt(dropMatch[3], 10) - 1;
    if (tf < 0 || tr < 0) return null;
    return { from: null, to: { file: tf, rank: tr }, drop: dropMatch[1].toUpperCase() };
  }
  const m = uci.match(/^([a-z])(\d+)([a-z])(\d+)/);
  if (!m) return null;
  const ff = m[1].charCodeAt(0) - 97;
  const fr = parseInt(m[2], 10) - 1;
  const tf = m[3].charCodeAt(0) - 97;
  const tr = parseInt(m[4], 10) - 1;
  if (ff < 0 || fr < 0 || tf < 0 || tr < 0) return null;
  return {
    from: { file: ff, rank: fr },
    to: { file: tf, rank: tr },
  };
}

/**
 * Where is the top-left pixel corner of a board square, given the
 * square size in px and whether the board is flipped (black POV).
 * @param {number} file  0..7 (a..h)
 * @param {number} rank  0..7 (1..8)
 * @param {number} sqSize
 * @param {boolean} flipped
 */
export function squareTopLeft(file, rank, sqSize, flipped) {
  const f = flipped ? 7 - file : file;
  const r = flipped ? rank : 7 - rank;
  return { x: f * sqSize, y: r * sqSize };
}

/**
 * Centre pixel of a square. Useful for arrow endpoints.
 */
export function squareCenter(file, rank, sqSize, flipped) {
  const tl = squareTopLeft(file, rank, sqSize, flipped);
  return { x: tl.x + sqSize / 2, y: tl.y + sqSize / 2 };
}

/**
 * Given two board FENs (boardonly, before & after), decide which side
 * played the move. Works by counting disappearances / appearances per
 * colour. Returns `"w"`, `"b"`, or `null` if ambiguous (e.g. atomic
 * captures that explode pieces of both colours).
 *
 * @param {string} prevFen
 * @param {string} currFen
 * @returns {"w"|"b"|null}
 */
export function detectWhoMoved(prevFen, currFen) {
  const prev = fenBoardToGrid(prevFen);
  const curr = fenBoardToGrid(currFen);

  let whiteAppeared = 0;
  let blackAppeared = 0;
  let whiteDisappeared = 0;
  let blackDisappeared = 0;

  const ranks = Math.max(prev.length, curr.length);
  for (let r = 0; r < ranks; r++) {
    const prevRank = prev[r] || [];
    const currRank = curr[r] || [];
    const files = Math.max(prevRank.length, currRank.length);
    for (let f = 0; f < files; f++) {
      const p = prevRank[f] || null;
      const c = currRank[f] || null;
      if (p === c) continue;
      if (p) {
        if (p === p.toUpperCase()) whiteDisappeared++;
        else blackDisappeared++;
      }
      if (c) {
        if (c === c.toUpperCase()) whiteAppeared++;
        else blackAppeared++;
      }
    }
  }

  const whiteMoved = whiteDisappeared > 0 && whiteAppeared > 0;
  const blackMoved = blackDisappeared > 0 && blackAppeared > 0;
  if (whiteMoved && !blackMoved) return 'w';
  if (blackMoved && !whiteMoved) return 'b';

  // Atomic explosions: nobody "appears" because the capturing piece is
  // also destroyed. Fall through to other detection strategies.
  if (!whiteMoved && !blackMoved && (whiteDisappeared > 0 || blackDisappeared > 0)) {
    return null;
  }

  if (whiteAppeared > blackAppeared) return 'w';
  if (blackAppeared > whiteAppeared) return 'b';
  return null;
}

/**
 * Convert a 2-D grid of pieces (see {@link fenBoardToGrid}) back into
 * the board part of a FEN. Optionally accepts a bracketed pocket
 * suffix for drop variants. Castling rights are derived from king +
 * rook positions on an 8×8 board only; pass `noCastling: true` for
 * antichess / racing-kings / horde.
 *
 * @param {(string|null)[][]} grid
 * @param {string} [pocket]  e.g. "[PPnn]" (include brackets) or ""
 * @param {{ noCastling?: boolean }} [opts]
 */
export function gridToFenBoard(grid, pocket, opts = {}) {
  const rows = [];
  const numRanks = grid.length;
  for (let r = 0; r < numRanks; r++) {
    let row = '';
    let empty = 0;
    const numFiles = grid[r].length;
    for (let f = 0; f < numFiles; f++) {
      if (grid[r][f]) {
        if (empty) {
          row += empty;
          empty = 0;
        }
        row += grid[r][f];
      } else {
        empty++;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  let castling = '';
  if (!opts.noCastling && numRanks === 8 && (grid[7] || []).length >= 8) {
    if (grid[7][4] === 'K') {
      if (grid[7][7] === 'R') castling += 'K';
      if (grid[7][0] === 'R') castling += 'Q';
    }
    if (grid[0][4] === 'k') {
      if (grid[0][7] === 'r') castling += 'k';
      if (grid[0][0] === 'r') castling += 'q';
    }
  }
  if (!castling) castling = '-';
  const pocketStr = pocket || '';
  return rows.join('/') + pocketStr + ' w ' + castling + ' - 0 1';
}
