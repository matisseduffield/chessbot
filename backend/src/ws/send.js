'use strict';
// @ts-check

const WS_OPEN = 1;

/**
 * Minimal subset of the `ws` WebSocket surface we rely on. Keeping the
 * type narrow means these helpers can be unit-tested with fakes.
 * @typedef {{ readyState: number, send: (data: string | Buffer) => void }} WSLike
 */

/**
 * @param {WSLike | null | undefined} ws
 * @param {unknown} data
 * @returns {boolean} true if the send was attempted without throwing.
 */
function safeSend(ws, data) {
  if (!ws || ws.readyState !== WS_OPEN) return false;
  try {
    ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    return true;
  } catch {
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
