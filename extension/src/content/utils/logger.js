/**
 * Tagged console logger for the content script.
 *
 * Wraps `console.log/warn/error` with a `[chessbot]` prefix so grepping
 * the devtools console remains trivial, and offers a `debug` level that
 * can be toggled at runtime via `setDebug(true)`. All other methods
 * are always-on and match the prior behaviour of scattered
 * `console.log("[chessbot] ...")` calls throughout content.js.
 */

let debugEnabled = false;

export function setDebug(on) {
  debugEnabled = !!on;
}

export function isDebug() {
  return debugEnabled;
}

export function log(...args) {
  console.log('[chessbot]', ...args);
}

export function warn(...args) {
  console.warn('[chessbot]', ...args);
}

export function error(...args) {
  console.error('[chessbot]', ...args);
}

export function debug(...args) {
  if (!debugEnabled) return;
  console.log('[chessbot:debug]', ...args);
}

export default { log, warn, error, debug, setDebug, isDebug };
