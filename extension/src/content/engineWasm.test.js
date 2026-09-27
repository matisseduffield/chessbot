import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initWasmEngine, evaluateWasm, shutdownWasmEngine } from './engineWasm.js';

class FakeWorker {
  constructor() {
    this.listeners = new Set();
    this.sent = [];
    FakeWorker.last = this;
  }
  addEventListener(ev, fn) {
    if (ev !== 'message') return;
    this.listeners.add(fn);
  }
  removeEventListener(_ev, fn) {
    this.listeners.delete(fn);
  }
  postMessage(msg) {
    this.sent.push(msg);
    if (msg === 'uci') queueMicrotask(() => this._emit('uciok'));
  }
  terminate() {}
  _emit(line) {
    for (const fn of [...this.listeners]) fn({ data: line });
  }
}

describe('engineWasm', () => {
  beforeEach(() => {
    shutdownWasmEngine();
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => {
    shutdownWasmEngine();
    vi.unstubAllGlobals();
  });

  it('boots on uciok and runs an evaluation', async () => {
    const ready = initWasmEngine('stockfish.worker.js');
    await ready;
    const p = evaluateWasm({ fen: 'startpos', depth: 5 });
    FakeWorker.last._emit('info depth 5 multipv 1 score cp 34 pv e2e4 e7e5 g1f3');
    FakeWorker.last._emit('bestmove e2e4 ponder e7e5');
    const res = await p;
    expect(res.bestmove).toBe('e2e4');
    expect(res.ponder).toBe('e7e5');
    expect(res.lines[0].score).toBe(34);
    expect(res.lines[0].pv[0]).toBe('e2e4');
  });

  it('rejects evaluateWasm before init', async () => {
    await expect(evaluateWasm({ fen: 'x' })).rejects.toThrow();
  });

  it('does not resolve a new position with the cancelled search bestmove', async () => {
    await initWasmEngine('stockfish.worker.js');
    const first = evaluateWasm({ fen: 'startpos', depth: 5 });
    const firstResult = first.catch((err) => err);
    const oldWorker = FakeWorker.last;
    let secondSettled = false;
    const second = evaluateWasm({ fen: 'startpos', depth: 8 });
    second.then(() => {
      secondSettled = true;
    });
    oldWorker._emit('bestmove a2a3');
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    // A fresh worker or a drained old search may now analyse the latest request.
    await Promise.resolve();
    await Promise.resolve();
    FakeWorker.last._emit('bestmove e2e4');
    expect((await second).bestmove).toBe('e2e4');
    expect((await firstResult).name).toBe('AbortError');
  });

  it('settles an interrupted search on shutdown', async () => {
    await initWasmEngine('stockfish.worker.js');
    const search = evaluateWasm({ fen: 'startpos' }).catch((err) => err);
    shutdownWasmEngine();
    expect((await search).name).toBe('AbortError');
  });

  it('can retry when the worker constructor fails', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('load failed');
        }
      },
    );
    await expect(initWasmEngine('broken.js')).rejects.toThrow('load failed');
    vi.stubGlobal('Worker', FakeWorker);
    await initWasmEngine('working.js');
    const search = evaluateWasm({ fen: 'startpos' });
    FakeWorker.last._emit('bestmove 0000');
    expect((await search).bestmove).toBeNull();
  });
});
