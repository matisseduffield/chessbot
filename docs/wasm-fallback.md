# WASM engine fallback

When the native backend is unreachable (service down, firewall, etc.) the
extension can fall back to a Stockfish build running as a Web Worker inside
the browser. This is **experimental** and slower than the native engine,
but removes the backend dependency entirely.

## Setup

1. Download a prebuilt `stockfish.js` + `stockfish.wasm` pair — for example
   from <https://github.com/nmrugg/stockfish.js/releases>.
2. Copy both files into `extension/public/wasm/` (create the folder if
   missing). They will be bundled by Vite into `extension/dist/wasm/`.
3. In the extension popup, enable **"Use in-browser engine (experimental)"**.

The binary is **not** committed to this repository because of size and
licensing considerations; each user supplies their own.

## API

`extension/src/content/engineWasm.js` exposes:

- `initWasmEngine(workerUrl)` — boot the worker, resolves on `uciok`.
- `evaluateWasm({ fen, depth, movetime, multiPV })` — single evaluation,
  returns `{ bestmove, ponder, lines }` matching the server's `bestmove` frame.
- `shutdownWasmEngine()` — terminate the worker.

## Limitations

- No opening books / Syzygy / Lichess masters integration.
- Single-threaded (workers cannot spawn threads on most sites).
- No ponder mode in fallback path.
