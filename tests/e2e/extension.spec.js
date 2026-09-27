import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';

// Isolated Chromium profile with the actual MV3 worker and both content worlds.
// Supported-site URLs serve local fixtures; no chess account or game is touched.
test('installed extension reads Chess.com and Lichess, routes sessions, and hides training PVs', async ({
  playwright,
}, testInfo) => {
  test.setTimeout(60000);
  const extension = resolve('extension/dist');
  const context = await playwright.chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.on('console', (message) => {
    if (message.type() === 'error') console.error('[extension fixture]', message.text());
  });
  context.on('page', (page) =>
    page.on('pageerror', (error) => console.error('[extension fixture]', error.message)),
  );
  try {
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    expect(worker.url()).toContain('chrome-extension://');
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const glyphs = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
    const squares = new Chess(fen)
      .board()
      .flatMap((row, r) =>
        row.map(
          (piece, f) =>
            `<div style="background:${(r + f) % 2 ? '#769656' : '#eeeed2'};display:grid;place-items:center;font-size:48px;color:${piece?.color === 'w' ? 'white' : '#17221b'};text-shadow:0 1px 2px #17221b">${piece ? glyphs[piece.type] : ''}</div>`,
        ),
      )
      .join('');
    const chessHtml = `<html><body style="background:#10141c;color:#e2e8f0;font:14px system-ui;padding:28px"><p style="margin:0 0 32px">ChessBot overlay verification · controlled starting position</p><wc-chess-board id="board-play-computer" style="position:relative;display:block;width:480px;height:480px"><div style="position:absolute;inset:0;display:grid;grid-template-columns:repeat(8,1fr);grid-template-rows:repeat(8,1fr)">${squares}</div></wc-chess-board><p>Ranked suggestions · engine depth shown above the board</p><script>
      window.fixtureFen='${fen}'; window.fixtureFlipped=false; window.fixtureOver=false;
      document.querySelector('wc-chess-board').game={getVariant:()=> 'chess',getFEN:()=> window.fixtureFen,getPlayingAs:()=>1,getOptions:()=>({flipped:window.fixtureFlipped}),isGameOver:()=>window.fixtureOver};
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
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: chessHtml }),
    );
    await context.route('https://lichess.org/**', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: lichessHtml }),
    );
    const panel = await context.newPage();
    await panel.goto('http://localhost:8080');
    const chess = await context.newPage();
    await chess.goto('https://www.chess.com/play/computer');
    await expect
      .poll(() => panel.locator('#board-session option').count(), { timeout: 15000 })
      .toBe(2);
    await expect
      .poll(() => panel.evaluate(() => window.state.currentData?.fen), { timeout: 15000 })
      .toBe(fen);
    await expect
      .poll(() => panel.evaluate(() => window.state.currentData?.bestmove), { timeout: 15000 })
      .toBeTruthy();
    await expect(chess.locator('#chessbot-arrow-svg')).toBeAttached();
    await panel.getByText('Depth on website', { exact: true }).click();
    await expect(chess.locator('#chessbot-depth-badge')).toContainText(/Ready|Cached/);
    await panel.locator('#multipv-slider').press('Home');
    await panel.locator('#multipv-slider').press('ArrowRight');
    await panel.locator('#multipv-slider').press('ArrowRight');
    await expect(panel.locator('#multipv-slider')).toHaveValue('3');
    await expect.poll(() => panel.evaluate(() => window.state.currentData?.lines?.length)).toBe(3);
    await expect(chess.locator('#chessbot-arrow-svg path[data-from]')).toHaveCount(3);
    const choices = panel.locator('#pvs button.pv-card');
    await expect(choices).toHaveCount(3);
    await choices.nth(1).press('Enter');
    await expect(choices.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(choices.nth(1)).toBeFocused();
    await expect(panel.locator('#board-svg .board-coordinates text')).toHaveCount(16);
    await expect(panel.locator('#board-svg .move-arrow[fill="#00bcd4"]')).toHaveCount(1);
    await choices.first().press('Enter');
    const originalSize = panel.viewportSize();
    await panel.setViewportSize({ width: 390, height: 844 });
    expect(
      await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect(choices.first()).toBeVisible();
    expect(
      await panel
        .locator('#board-svg')
        .evaluate((el) => el.getBoundingClientRect().right <= innerWidth),
    ).toBe(true);
    await panel.setViewportSize(originalSize);
    await expect(chess.locator('#chessbot-depth-badge')).toContainText(/Ready|Cached/);
    await chess.screenshot({
      path: testInfo.outputPath('ranked-overlay.png'),
      clip: { x: 20, y: 16, width: 540, height: 600 },
    });
    const arrowsMatchSquares = () =>
      chess.evaluate(() => {
        const board = document.querySelector('#board-play-computer').getBoundingClientRect();
        const paths = [...document.querySelectorAll('#chessbot-arrow-svg path[data-from]')];
        const inside = (point, square) => {
          const file = square.charCodeAt(0) - 97,
            rank = Number(square[1]) - 1;
          const x = window.fixtureFlipped ? 7 - file : file;
          const y = window.fixtureFlipped ? rank : 7 - rank;
          return (
            point.x >= board.left + (x * board.width) / 8 &&
            point.x <= board.left + ((x + 1) * board.width) / 8 &&
            point.y >= board.top + (y * board.height) / 8 &&
            point.y <= board.top + ((y + 1) * board.height) / 8
          );
        };
        return (
          paths.length > 0 &&
          paths.every((path) => {
            const points = path
              .getAttribute('d')
              .match(/-?\d+(?:\.\d+)?/g)
              .map(Number);
            const matrix = path.getScreenCTM();
            return (
              inside(
                new DOMPoint(points[0], points[1]).matrixTransform(matrix),
                path.dataset.from,
              ) &&
              inside(new DOMPoint(points[6], points[7]).matrixTransform(matrix), path.dataset.to)
            );
          })
        );
      });
    await expect.poll(arrowsMatchSquares).toBe(true);
    await chess.evaluate(() =>
      Object.assign(document.querySelector('#board-play-computer').style, {
        width: '640px',
        height: '640px',
      }),
    );
    await expect.poll(arrowsMatchSquares).toBe(true);
    await chess.evaluate(() => {
      window.fixtureFlipped = true;
      document.querySelector('#board-play-computer').classList.add('flipped');
    });
    await expect.poll(arrowsMatchSquares).toBe(true);
    // A new authoritative position must replace the previous answer, including EP.
    const nextFen = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 29';
    const snapshotMs = await chess.evaluate(
      (next) =>
        new Promise((resolve) => {
          const started = performance.now();
          document.addEventListener('chessbot-position', function changed() {
            document.removeEventListener('chessbot-position', changed);
            resolve(performance.now() - started);
          });
          window.fixtureFen = next;
          document.querySelector('#board-play-computer').classList.add('position-changed');
        }),
      nextFen,
    );
    console.log(
      `[fixture timing] board mutation to position snapshot: ${Math.round(snapshotMs)} ms`,
    );
    await expect.poll(() => panel.evaluate(() => window.state.currentData?.fen)).toBe(nextFen);
    await expect.poll(() => panel.evaluate(() => window.state.currentData?.bestmove)).toBeTruthy();
    const answer = await panel.evaluate(() => window.state.currentData.bestmove);
    expect(new Chess(nextFen).move(answer)).toBeTruthy();
    await expect.poll(arrowsMatchSquares).toBe(true);
    await chess.evaluate((initial) => {
      window.fixtureFen = initial;
      window.fixtureFlipped = false;
      document.querySelector('#board-play-computer').className = 'restored';
    }, fen);
    await expect.poll(() => panel.evaluate(() => window.state.currentData?.fen)).toBe(fen);
    await expect.poll(arrowsMatchSquares).toBe(true);
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
    expect(worker).toBeTruthy();
    await chess.reload();
    await expect(chess.locator('.chessbot-hint-btn')).toBeAttached({ timeout: 15000 });
  } catch (error) {
    const worker = context.serviceWorkers()[0];
    if (worker)
      console.log(
        '[fixture diagnostics]',
        await worker.evaluate(async () => {
          const tabs = await globalThis.chrome.tabs.query({});
          const diagnostics = [];
          for (const tab of tabs)
            if (
              tab.url?.startsWith('https://www.chess.com/') ||
              tab.url?.startsWith('https://lichess.org/')
            ) {
              try {
                diagnostics.push(
                  await globalThis.chrome.tabs.sendMessage(tab.id, { type: 'get_logs' }),
                );
              } catch (error) {
                diagnostics.push(String(error));
              }
            }
          return diagnostics;
        }),
      );
    throw error;
  } finally {
    await context.close();
  }
});
