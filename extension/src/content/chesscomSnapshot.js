import { validateFen } from 'chess.js';

export const SNAPSHOT_ATTRIBUTE = 'data-chessbot-position';
export const SNAPSHOT_EVENT = 'chessbot-position';

export function isComputerPage(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === 'https://www.chess.com' && /^\/play\/computer\/?$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

// Runs in the page world. Only these read-only, public game getters cross
// the boundary; no account data or callable page objects are exposed.
export function captureBotPosition(board, url, now = Date.now()) {
  if (!isComputerPage(url) || board?.id !== 'board-play-computer') return null;
  try {
    const game = board.game;
    if (game?.getVariant() !== 'chess') return null;
    const fen = game.getFEN();
    if (!validateFen(fen).ok) return null;
    const side = game.getPlayingAs();
    if (side !== 1 && side !== 2) return null;
    return {
      version: 1,
      fen,
      flipped: !!game.getOptions().flipped,
      playerColor: side === 1 ? 'w' : 'b',
      gameOver: !!game.isGameOver(),
      at: now,
    };
  } catch {
    return null;
  }
}

// Runs in the isolated content-script world. DOM attributes are untrusted
// page data: bound their size, validate shape and age, then validate the FEN.
export function readBotPosition(doc, now = Date.now()) {
  if (!isComputerPage(doc.location.href)) return null;
  const raw = doc.querySelector('#board-play-computer')?.getAttribute(SNAPSHOT_ATTRIBUTE);
  if (!raw || raw.length > 1024) return null;
  try {
    const value = JSON.parse(raw);
    if (
      value.version !== 1 ||
      typeof value.fen !== 'string' ||
      value.fen.split(' ').length !== 6 ||
      !Number.isFinite(value.at) ||
      now - value.at > 1500 ||
      value.at > now + 250 ||
      !['w', 'b'].includes(value.playerColor) ||
      typeof value.flipped !== 'boolean' ||
      typeof value.gameOver !== 'boolean' ||
      !validateFen(value.fen).ok
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
