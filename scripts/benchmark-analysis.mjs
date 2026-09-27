import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'production';
const require = createRequire(import.meta.url);
const StockfishBridge = require('../backend/stockfishBridge');
const { Chess } = require('chess.js');
const engine = new StockfishBridge();
const cases = [
  ['opening', new Chess().fen()],
  ['middlegame', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['mate in one', '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1'],
];
try {
  await engine.start();
  engine.setOption('Threads', 1);
  engine.setOption('Hash', 16);
  engine.setOption('MultiPV', 3);
  const results = [];
  for (const [name, fen] of cases) {
    engine.setOption('Clear Hash', '');
    const started = performance.now();
    let firstMs = null,
      updates = 0,
      inconsistent = 0;
    const result = await engine.evaluate(fen, 15, {
      movetime: 1000,
      onInfo(info) {
        firstMs ??= performance.now() - started;
        updates++;
        if (
          new Set(info.lines.map((l) => l.depth)).size !== 1 ||
          new Set(info.lines.map((l) => l.move)).size !== info.lines.length
        )
          inconsistent++;
      },
    });
    const elapsedMs = performance.now() - started;
    const chess = new Chess(fen);
    let legal = false;
    try {
      legal = !!chess.move({
        from: result.bestmove.slice(0, 2),
        to: result.bestmove.slice(2, 4),
        promotion: result.bestmove[4],
      });
    } catch {}
    if (!legal || (name === 'mate in one' && !chess.isCheckmate()))
      throw new Error(`Incorrect move for ${name}: ${result.bestmove}`);
    results.push({
      name,
      firstMs: Math.round(firstMs ?? elapsedMs),
      elapsedMs: Math.round(elapsedMs),
      updates,
      inconsistent,
      bestmove: result.bestmove,
      legal,
      depths: result.lines.map((l) => l.depth),
    });
  }
  console.log(
    JSON.stringify(
      { settings: { threads: 1, hashMB: 16, multiPV: 3, depth: 15, movetime: 1000 }, results },
      null,
      2,
    ),
  );
} finally {
  engine.stop();
}
