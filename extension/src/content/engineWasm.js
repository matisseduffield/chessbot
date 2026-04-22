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

/**
 * Initialise the wasm engine. Idempotent.
 * @param {string} workerUrl - URL of the stockfish.js worker script (which in turn loads stockfish.wasm).
 * @returns {Promise<void>}
 */
export function initWasmEngine(workerUrl) {
  if (_ready) return _ready;
  _ready = new Promise((resolve, reject) => {
    try {
      _worker = new Worker(workerUrl);
    } catch (err) {
      reject(err);
      return;
    }
    let booted = false;
    const onMsg = (ev) => {
      const line = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (!booted && line.includes('uciok')) {
        booted = true;
        _worker.removeEventListener('message', onMsg);
        resolve();
      }
    };
    _worker.addEventListener('message', onMsg);
    _worker.postMessage('uci');
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
  if (_pending) {
    _worker.postMessage('stop');
  }
  return new Promise((resolve) => {
    const lines = {};
    const onMsg = (ev) => {
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
        _worker.removeEventListener('message', onMsg);
        _pending = null;
        const parts = line.split(/\s+/);
        const bestmove = parts[1] && parts[1] !== '(none)' ? parts[1] : null;
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
    _pending = onMsg;
    _worker.postMessage(`setoption name MultiPV value ${req.multiPV || 1}`);
    _worker.postMessage(`position fen ${req.fen}`);
    if (req.movetime) {
      _worker.postMessage(`go movetime ${req.movetime}`);
    } else {
      _worker.postMessage(`go depth ${req.depth || 18}`);
    }
  });
}

/** Terminate the worker (e.g. when user toggles WASM off). */
export function shutdownWasmEngine() {
  if (_worker) {
    try {
      _worker.postMessage('quit');
    } catch {}
    _worker.terminate();
    _worker = null;
  }
  _ready = null;
  _pending = null;
}
