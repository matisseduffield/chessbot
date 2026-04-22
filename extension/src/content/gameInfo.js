/**
 * Pure helper for assigning scraped top/bottom player names + clock
 * readings to white/black sides based on board orientation.
 *
 * Extracted from content.js `scrapeGameInfo` (plan §2.1).
 *
 * Input:
 *   - topName / bottomName: trimmed user strings from the DOM
 *   - topClock / bottomClock: trimmed clock strings from the DOM
 *   - flipped: boolean — true when the board is oriented with the
 *     user playing black (so black sits at the bottom of the board)
 *
 * Output: a `{ white, black, flipped }` subtree compatible with
 * the existing `game_info` WS frame.
 */

/**
 * @typedef {Object} PlayerSlot
 * @property {string} name
 * @property {string} clock
 */

/**
 * @typedef {Object} GameInfoSides
 * @property {PlayerSlot} white
 * @property {PlayerSlot} black
 * @property {boolean} flipped
 */

/**
 * @param {{ topName: string, bottomName: string, topClock: string, bottomClock: string, flipped: boolean }} args
 * @returns {GameInfoSides}
 */
export function assignPlayersByOrientation({
  topName,
  bottomName,
  topClock,
  bottomClock,
  flipped,
}) {
  const top = { name: topName || '', clock: topClock || '' };
  const bottom = { name: bottomName || '', clock: bottomClock || '' };
  if (flipped) {
    return { white: top, black: bottom, flipped: true };
  }
  return { white: bottom, black: top, flipped: false };
}
