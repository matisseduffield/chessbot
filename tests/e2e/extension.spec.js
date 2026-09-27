import { test, expect, chromium } from '@playwright/test';
import { resolve } from 'node:path';

// Isolated Chromium profile with the actual MV3 worker and both content worlds.
// Supported-site URLs serve local fixtures; no chess account or game is touched.
test('installed extension reads Chess.com and Lichess, routes sessions, and hides training PVs', async () => {
  test.setTimeout(60000);
  const extension = resolve('extension/dist');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const chessHtml = `<html><body><wc-chess-board id="board-play-computer" style="display:block;width:480px;height:480px"></wc-chess-board><script>
      document.querySelector('wc-chess-board').game={getVariant:()=> 'chess',getFEN:()=> '${fen}',getPlayingAs:()=>1,getOptions:()=>({flipped:false}),isGameOver:()=>false};
    </script></body></html>`;
    const names = { r: 'rook', n: 'knight', b: 'bishop', q: 'queen', k: 'king', p: 'pawn' };
    let pieces = '';
    for (const [row, rank, color] of [
      ['rnbqkbnr', 0, 'black'],
      ['pppppppp', 1, 'black'],
      ['PPPPPPPP', 6, 'white'],
      ['RNBQKBNR', 7, 'white'],
    ]) {
      [...row].forEach((piece, file) => {
        pieces += `<piece class="${color} ${names[piece.toLowerCase()]}" style="position:absolute;width:60px;height:60px;transform:translate(${file * 60}px,${rank * 60}px)"></piece>`;
      });
    }
    const lichessHtml = `<html><body><div class="cg-wrap orientation-white"><cg-board style="display:block;position:relative;width:480px;height:480px">${pieces}</cg-board></div></body></html>`;
    await context.route('https://www.chess.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: chessHtml }),
    );
    await context.route('https://lichess.org/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: lichessHtml }),
    );
    const panel = await context.newPage();
    await panel.goto('http://localhost:8080');
    const chess = await context.newPage();
    await chess.goto('https://www.chess.com/play/computer');
    await expect
      .poll(() => panel.evaluate(() => window.state.currentData?.fen), { timeout: 15000 })
      .toBe(fen);
    await expect.poll(() => panel.evaluate(() => window.state.currentData?.bestmove)).toBeTruthy();
    await expect(chess.locator('#chessbot-arrow-svg')).toBeAttached();
    const chessSession = await panel.evaluate(() => window.state.currentData.sessionId);
    const lichess = await context.newPage();
    await lichess.goto('https://lichess.org/analysis');
    await expect(panel.locator('#board-session')).toBeVisible({ timeout: 15000 });
    await expect.poll(() => panel.locator('#board-session option').count()).toBe(3);
    await panel.locator('#board-session').selectOption(chessSession);
    await expect
      .poll(() => panel.evaluate(() => window.state.currentData?.sessionId))
      .toBe(chessSession);
    await panel.getByText('Training mode', { exact: true }).click();
    await expect
      .poll(() => panel.evaluate(() => window.state.currentData?.trainingHidden))
      .toBe(true);
    await expect(panel.locator('#pvs')).toContainText('Training:');
    expect(await panel.evaluate(() => window.state.currentData.bestmove)).toBeNull();
    await expect(chess.locator('.chessbot-hint-btn')).toBeAttached({ timeout: 15000 });
    const worker = context.serviceWorkers()[0];
    expect(worker).toBeTruthy();
    await chess.reload();
    await expect(chess.locator('.chessbot-hint-btn')).toBeAttached({ timeout: 15000 });
  } finally {
    await context.close();
  }
});
