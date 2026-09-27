// WASM engine fallback (plan §4.6) — runs Stockfish in-browser when the
// native backend is unreachable. This module is intentionally lightweight:
// callers provide the wasm URL, and the module exposes a minimal `evaluate`
// API that mirrors the shape of the server's `bestmove` frames.
//
// The wasm binary is NOT checked into the repo (see docs/wasm-fallback.md);
// users drop it at a known path and the popup toggle enables this path.

/** @typedef {{ fen: string, depth?: number, movetime?: number, multiPV?: number }} EvalReq */
/** @typedef {{ bestmove: string | null, ponder: string | null, lines: Array<{ move: string, score?: number, mate?: number, pv?: string[] }> }} EvalRes */

let _worker = null;
let _ready = null;
let _pending = null;
let _workerUrl = null;
let _bootReject = null;
let _bootTimer = null;
let _booted = false;

/**
 * Initialise the wasm engine. Idempotent.
 * @param {string} workerUrl - URL of the stockfish.js worker script (which in turn loads stockfish.wasm).
 * @returns {Promise<void>}
 */
export function initWasmEngine(workerUrl) {
  if (_ready) return _ready;
  _workerUrl = workerUrl;
  _ready = new Promise((resolve, reject) => {
    _bootReject = reject;
    try {
      _worker = new Worker(workerUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const worker = _worker;
    _bootTimer = setTimeout(() => {
      if (_worker === worker) shutdownWasmEngine(new Error('Browser engine startup timed out'));
    }, 10000);
    worker.addEventListener('error', () => {
      if (_worker === worker) shutdownWasmEngine(new Error('Browser engine failed to load or run'));
    });
    let booted = false;
    const onMsg = (ev) => {
      if (_worker !== worker) return;
      const line = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (!booted && line.includes('uciok')) {
        booted = true;
        _booted = true;
        clearTimeout(_bootTimer);
        _bootReject = null;
        _worker.removeEventListener('message', onMsg);
        resolve();
      }
    };
    _worker.addEventListener('message', onMsg);
    _worker.postMessage('uci');
  });
  const attempt = _ready;
  attempt.catch(() => {
    if (_ready === attempt) _ready = null;
  });
  return _ready;
}

/**
 * Run a single evaluation. Resolves with the shape server.js emits.
 * Only one in-flight eval is supported; new calls cancel the previous.
 * @param {EvalReq} req
 * @returns {Promise<EvalRes>}
 */
export function evaluateWasm(req) {
  if (!_worker) return Promise.reject(new Error('wasm engine not initialised'));
  if (!_booted) return _ready.then(() => evaluateWasm(req));
  if (_pending) {
    // UCI does not label results with a request ID. A late bestmove from a
    // stopped search must not be consumed by the new position's listener.
    const url = _workerUrl;
    shutdownWasmEngine();
    return initWasmEngine(url).then(() => evaluateWasm(req));
  }
  return new Promise((resolve, reject) => {
    const worker = _worker;
    const lines = {};
    const onMsg = (ev) => {
      if (_worker !== worker) return;
      const line = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (line.startsWith('info ') && line.includes(' pv ')) {
        const mp = /multipv (\d+)/.exec(line);
        const mpIdx = mp ? Number(mp[1]) : 1;
        const sc = /score cp (-?\d+)/.exec(line);
        const mt = /score mate (-?\d+)/.exec(line);
        const pv = line.split(' pv ')[1]?.split(' ') ?? [];
        lines[mpIdx] = {
          move: pv[0],
          pv,
          ...(sc ? { score: Number(sc[1]) } : {}),
          ...(mt ? { mate: Number(mt[1]) } : {}),
        };
      } else if (line.startsWith('bestmove')) {
        clearTimeout(_pending?.timer);
        _worker.removeEventListener('message', onMsg);
        _pending = null;
        const parts = line.split(/\s+/);
        const bestmove = parts[1] && !['(none)', '0000'].includes(parts[1]) ? parts[1] : null;
        const pIdx = parts.indexOf('ponder');
        const ponder = pIdx > 0 && parts[pIdx + 1] ? parts[pIdx + 1] : null;
        const ordered = Object.keys(lines)
          .map(Number)
          .sort((a, b) => a - b)
          .map((k) => lines[k]);
        resolve({ bestmove, ponder, lines: ordered });
      }
    };
    _worker.addEventListener('message', onMsg);
    const timer = setTimeout(
      () => {
        if (_worker === worker) shutdownWasmEngine(new Error('Browser engine analysis timed out'));
      },
      req.movetime ? req.movetime + 10000 : 120000,
    );
    _pending = { onMsg, reject, timer };
    _worker.postMessage(`setoption name MultiPV value ${req.multiPV || 1}`);
    _worker.postMessage(req.fen === 'startpos' ? 'position startpos' : `position fen ${req.fen}`);
    if (req.movetime) {
      _worker.postMessage(`go movetime ${req.movetime}`);
    } else {
      _worker.postMessage(`go depth ${req.depth || 18}`);
    }
  });
}

/** Terminate the worker (e.g. when user toggles WASM off). */
export function shutdownWasmEngine(
  error = new DOMException('Analysis superseded or stopped', 'AbortError'),
) {
  clearTimeout(_bootTimer);
  _bootReject?.(error);
  _bootReject = null;
  if (_pending) {
    clearTimeout(_pending.timer);
    _worker?.removeEventListener('message', _pending.onMsg);
    _pending.reject(error);
  }
  if (_worker) {
    try {
      _worker.postMessage('quit');
    } catch {}
    _worker.terminate();
    _worker = null;
  }
  _ready = null;
  _booted = false;
  _pending = null;
}
