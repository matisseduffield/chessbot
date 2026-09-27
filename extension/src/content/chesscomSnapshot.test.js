import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { Chess } from 'chess.js';
import { captureBotPosition, readBotPosition, SNAPSHOT_ATTRIBUTE } from './chesscomSnapshot.js';

const url = 'https://www.chess.com/play/computer';
function fixture(fen = new Chess().fen()) {
  const doc = new JSDOM('<wc-chess-board id="board-play-computer"></wc-chess-board>', { url })
    .window.document;
  const board = doc.querySelector('wc-chess-board');
  board.game = {
    getVariant: () => 'chess',
    getFEN: () => fen,
    getPlayingAs: () => 1,
    getOptions: () => ({ flipped: true }),
    isGameOver: () => false,
  };
  return { doc, board };
}
describe('Chess.com computer game bridge', () => {
  it('preserves lost castling rights after king and rook return, turn and counters', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R b - - 8 24';
    const { doc, board } = fixture(fen);
    board.setAttribute(SNAPSHOT_ATTRIBUTE, JSON.stringify(captureBotPosition(board, url, 1000)));
    expect(readBotPosition(doc, 1100)).toMatchObject({ fen, flipped: true, playerColor: 'w' });
  });
  it('preserves en passant on a page opened in the middle of a game', () => {
    const fen = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 29';
    const { doc, board } = fixture(fen);
    board.setAttribute(SNAPSHOT_ATTRIBUTE, JSON.stringify(captureBotPosition(board, url, 1000)));
    const value = readBotPosition(doc, 1100);
    expect(value.fen).toBe(fen);
    expect(new Chess(value.fen).moves()).toContain('exd6');
  });
  it('rejects stale, malformed and oversized snapshots', () => {
    const { doc, board } = fixture();
    board.setAttribute(SNAPSHOT_ATTRIBUTE, JSON.stringify(captureBotPosition(board, url, 1000)));
    expect(readBotPosition(doc, 2600)).toBeNull();
    for (const raw of [
      '{',
      'x'.repeat(1025),
      JSON.stringify({ version: 1, fen: 'bad', at: 1000 }),
    ]) {
      board.setAttribute(SNAPSHOT_ATTRIBUTE, raw);
      expect(readBotPosition(doc, 1100)).toBeNull();
    }
  });
  it('does not bridge human games or variants', () => {
    const { board } = fixture();
    expect(captureBotPosition(board, 'https://www.chess.com/play/online')).toBeNull();
    board.game.getVariant = () => 'chess960';
    expect(captureBotPosition(board, url)).toBeNull();
  });
  it('tolerates missing or changing page APIs', () => {
    const { board } = fixture();
    board.game.getFEN = () => {
      throw new Error('not ready');
    };
    expect(captureBotPosition(board, url)).toBeNull();
  });
});
