'use strict';
// @ts-check

const { forModule } = require('../lib/logger');

const WS_OPEN = 1;
const log = forModule('ws.send');

// Anything above this many bytes of WS send-buffer suggests a stalled or
// slow client. We log once per send when we cross the threshold so the
// operator notices before the socket dies silently.
const BACKPRESSURE_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * Minimal subset of the `ws` WebSocket surface we rely on. Keeping the
 * type narrow means these helpers can be unit-tested with fakes.
 * @typedef {{
 *   readyState: number,
 *   bufferedAmount?: number,
 *   send: (data: string | Buffer) => void,
 * }} WSLike
 */

/**
 * Pull a stable hint of "what was being sent" out of the payload so the
 * log line is useful without forcing every caller to thread a context
 * string. We only inspect already-parsed objects; raw strings/buffers
 * fall back to `<raw>`.
 * @param {unknown} data
 * @returns {string}
 */
function describePayload(data) {
  if (data && typeof data === 'object' && 'type' in /** @type {object} */ (data)) {
    const t = /** @type {{type?: unknown}} */ (data).type;
    if (typeof t === 'string') return t;
  }
  return typeof data === 'string' ? '<raw>' : '<unknown>';
}

/**
 * @param {WSLike | null | undefined} ws
 * @param {unknown} data
 * @returns {boolean} true if the send was attempted without throwing.
 */
function safeSend(ws, data) {
  if (!ws || ws.readyState !== WS_OPEN) return false;
  try {
    ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > BACKPRESSURE_BYTES) {
      log.warn(
        { type: describePayload(data), bufferedBytes: ws.bufferedAmount },
        'ws backpressure: client send buffer growing',
      );
    }
    return true;
  } catch (err) {
    log.warn(
      { type: describePayload(data), err: err instanceof Error ? err.message : String(err) },
      'ws send threw, frame dropped',
    );
    return false;
  }
}

/**
 * @param {{ clients?: Iterable<WSLike> } | null | undefined} wss
 * @param {WSLike | null | undefined} senderWs
 * @param {unknown} data
 * @returns {number} how many peers received the message.
 */
function broadcast(wss, senderWs, data) {
  if (!wss || !wss.clients) return 0;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  let sent = 0;
  for (const client of wss.clients) {
    if (client === senderWs) continue;
    if (safeSend(client, payload)) sent++;
  }
  return sent;
}

module.exports = { safeSend, broadcast, WS_OPEN };
