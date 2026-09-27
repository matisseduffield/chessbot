import { it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const { createEvalPipeline } = createRequire(import.meta.url)('./evalPipeline');
const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
function fixture() {
  let book = { enabled: true, lookup: vi.fn().mockResolvedValue('e2e4') };
  const result = { bestmove: 'd2d4', lines: [{ depth: 7, pv: ['d2d4'], score: 20 }] };
  const engine = {
    getSettings: () => ({ MultiPV: 1 }),
    evaluate: vi.fn().mockResolvedValue(result),
  };
  const deps = {
    config: { stockfishPath: 'fixture' },
    getBook: () => book,
    lichessLookup: vi.fn(),
    enrichLines: (lines) => lines,
    acquireEvalLock: async () => () => {},
    getCachedEval: vi.fn(),
    getCachedEvalAtLeast: vi.fn(),
    setCachedEval: vi.fn(),
    getEngine: () => engine,
    broadcast: vi.fn(),
    safeSend: vi.fn(),
    getEco: () => null,
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  };
  const ctx = {
    ws: { OPEN: 1, readyState: 1 },
    fen,
    depth: 15,
    searchOptions: {},
    evalVariant: 'chess',
    gen: 1,
    variantGen: 1,
    getEvalGeneration: () => 1,
    getGlobalVariantGen: () => 1,
  };
  return {
    deps,
    ctx,
    engine,
    result,
    run: createEvalPipeline(deps),
    replace: (next) => {
      book = next;
    },
  };
}
it('uses the currently selected book, then the engine after the book is disabled', async () => {
  const f = fixture();
  await f.run(f.ctx);
  expect(f.deps.safeSend.mock.lastCall[1].bestmove).toBe('e2e4');
  f.replace({ enabled: true, lookup: async () => 'g1f3' });
  await f.run(f.ctx);
  expect(f.deps.safeSend.mock.lastCall[1].bestmove).toBe('g1f3');
  f.replace({ enabled: false, lookup: async () => null });
  await f.run(f.ctx);
  expect(f.deps.safeSend.mock.lastCall[1].source).toBe('engine');
});
it('bypasses books in training and stores only achieved depth', async () => {
  const f = fixture();
  f.ctx.searchOptions.training = true;
  await f.run(f.ctx);
  expect(f.engine.evaluate).toHaveBeenCalledOnce();
  expect(f.deps.lichessLookup).not.toHaveBeenCalled();
  expect(f.deps.safeSend.mock.lastCall[1].depth).toBe(7);
  expect(f.deps.setCachedEval.mock.lastCall[2]).toBe(7);
});
it('does not invent depth or fail on a terminal position without a move', async () => {
  const f = fixture();
  f.ctx.searchOptions.training = true;
  f.result.bestmove = null;
  f.result.lines = [];
  await f.run(f.ctx);
  expect(f.deps.safeSend.mock.lastCall[1]).toMatchObject({
    type: 'bestmove',
    depth: 0,
    bestmove: null,
  });
  expect(f.deps.setCachedEval).not.toHaveBeenCalled();
});

it('does not call an ordinary endgame evaluation a proven tablebase result', async () => {
  const f = fixture();
  f.ctx.fen = '7k/8/6K1/8/8/8/4P3/8 w - - 0 1';
  f.ctx.searchOptions.training = true;
  f.deps.config.syzygyPath = '/some/tables';
  await f.run(f.ctx);
  expect(f.deps.safeSend.mock.lastCall[1].tablebase).toBeNull();
});
