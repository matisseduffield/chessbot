'use strict';

const WS_OPEN = 1;

function safeSend(ws, data) {
  if (!ws || ws.readyState !== WS_OPEN) return false;
  try {
    ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

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
