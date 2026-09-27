import { it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { startPositionPublisher } from './chesscomPublisher';
import { SNAPSHOT_EVENT, readBotPosition } from './chesscomSnapshot';

it('publishes a board change on the next frame, ignores its own overlays and cleans up', async () => {
  const dom = new JSDOM(
    '<wc-chess-board id="board-play-computer"><i class="piece"></i></wc-chess-board>',
    { url: 'https://www.chess.com/play/computer' },
  );
  const doc = dom.window.document,
    board = doc.querySelector('wc-chess-board');
  const shadow = board.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<i class="piece"></i>';
  let fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  board.game = {
    getVariant: () => 'chess',
    getFEN: () => fen,
    getPlayingAs: () => 1,
    getOptions: () => ({ flipped: false }),
    isGameOver: () => false,
  };
  let nextFrame;
  const host = {
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: vi.fn((fn) => {
      nextFrame = fn;
      return 1;
    }),
    cancelAnimationFrame: vi.fn(),
    setInterval: vi.fn(() => 2),
    clearInterval: vi.fn(),
  };
  const changed = vi.fn();
  doc.addEventListener(SNAPSHOT_EVENT, changed);
  const stop = startPositionPublisher(doc, host);
  try {
    expect(changed).toHaveBeenCalledOnce();
    fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    board.querySelector('i').className = 'piece square-54';
    await Promise.resolve();
    expect(host.requestAnimationFrame).toHaveBeenCalledOnce();
    nextFrame();
    expect(readBotPosition(doc).fen).toBe(fen);
    expect(changed).toHaveBeenCalledTimes(2);
    const overlay = doc.createElement('div');
    overlay.id = 'chessbot-arrow-svg';
    board.append(overlay);
    await Promise.resolve();
    expect(host.requestAnimationFrame).toHaveBeenCalledOnce();
    shadow.querySelector('i').className = 'piece square-55';
    await Promise.resolve();
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
  expect(host.cancelAnimationFrame).toHaveBeenCalledWith(1);
  expect(host.clearInterval).toHaveBeenCalledWith(2);
  expect(readBotPosition(doc)).toBeNull();
  dom.window.close();
});
