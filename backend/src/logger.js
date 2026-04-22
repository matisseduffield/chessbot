/**
 * Server log buffer + console override.
 *
 * The panel's "Show server logs" feature relies on being able to dump
 * the last N lines of what the backend printed. Rather than scatter
 * that concern across server.js, isolate it here. Future migration to
 * pino (plan §7.5) only has to change this file — call sites keep
 * using plain `console.log` / `console.warn` / `console.error`.
 */

const SERVER_LOG_MAX = 1000;
const buffer = [];
const orig = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function push(level, args) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${level}: ${Array.from(args)
    .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ')}`;
  buffer.push(line);
  if (buffer.length > SERVER_LOG_MAX) buffer.shift();
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  console.log = function (...args) {
    push('LOG', args);
    orig.log(...args);
  };
  console.warn = function (...args) {
    push('WARN', args);
    orig.warn(...args);
  };
  console.error = function (...args) {
    push('ERR', args);
    orig.error(...args);
  };
}

function getBuffer() {
  return buffer.slice();
}

function clear() {
  buffer.length = 0;
}

module.exports = { install, getBuffer, clear, SERVER_LOG_MAX };
