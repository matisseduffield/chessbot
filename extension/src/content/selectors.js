/**
 * DOM selector registry for chess.com and lichess.
 *
 * chess.com and lichess ship UI tweaks frequently. This file exists so
 * the fix is a one-line edit rather than a hunt through content.js.
 * See improvement-plan §6.1.
 *
 * Each entry is a list of selectors tried in order. The first to
 * resolve wins. A resolver logs exactly once per selector when nothing
 * matches so a broken chess.com update surfaces as a single visible
 * warning instead of silent breakage.
 */

export const CHESSCOM = {
  board: ['wc-chess-board', 'chess-board', '.board'],
  moveList: ['.move-list-container', 'wc-vertical-move-list', '.vertical-move-list-component'],
  lastMoveSquare: ['.highlight.last-move', '.square.highlight'],
  myClock: ['.clock-bottom', '.clock-component.clock-player-turn'],
  opponentClock: ['.clock-top'],
  whiteName: ['.board-layout-top .user-username', '.player-row.top .user-tagline'],
  blackName: ['.board-layout-bottom .user-username', '.player-row.bottom .user-tagline'],
};

export const LICHESS = {
  board: ['cg-container', '.cg-wrap', '.main-board'],
  moveList: ['l4x', 'rm6', 'move-list', '.replay'],
  lastMoveSquare: ['.last-move'],
  myClock: ['.rclock-bottom', '.clock.clock-bottom'],
  opponentClock: ['.rclock-top', '.clock.clock-top'],
  whiteName: ['.ruser-top .user-link', '.player.white .name'],
  blackName: ['.ruser-bottom .user-link', '.player.black .name'],
};

const warned = new Set();

/**
 * Resolve a selector list against a root element.
 * @param {Document | Element} root
 * @param {readonly string[]} selectors
 * @param {string} key – identifier used in the one-time warning
 * @returns {Element | null}
 */
export function resolve(root, selectors, key) {
  if (!root || !selectors) return null;
  for (const sel of selectors) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch {
      // invalid selector — skip
    }
  }
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[chessbot] selector "${key}" did not match any of:`, selectors);
  }
  return null;
}

/** Test hook: clear the "already-warned" set. */
export function _resetWarnings() {
  warned.clear();
}
