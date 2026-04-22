import { describe, it, expect, beforeEach } from 'vitest';
import { initWasmEngine, evaluateWasm, shutdownWasmEngine } from './engineWasm.js';

class FakeWorker {
  constructor() {
    this.listeners = new Set();
    this.sent = [];
    FakeWorker.last = this;
  }
  addEventListener(_ev, fn) {
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
    globalThis.Worker = FakeWorker;
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
});
