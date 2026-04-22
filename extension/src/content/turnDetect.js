// Pure helpers for turn detection from board-relative clock position.
// DOM queries stay in content.js; these take already-detected booleans.

/**
 * Given whether the running clock is on the "bottom" side of the board
 * (relative to the player), and whether the board is flipped, return
 * whose turn it is.
 *
 * @param {boolean} isBottom - running clock is the bottom-side clock
 * @param {boolean} flipped  - board is flipped (white at top)
 * @returns {"w" | "b"}
 */
export function turnFromRunningClock(isBottom, flipped) {
  if (isBottom) return flipped ? 'b' : 'w';
  return flipped ? 'w' : 'b';
}
