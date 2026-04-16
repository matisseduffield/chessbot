// Background service worker — relays WebSocket connections for content scripts.
// Chrome blocks ws://localhost from HTTPS content scripts (Private Network Access).
// The service worker has unrestricted network access, so it acts as a proxy.

const WS_URL = "ws://localhost:8080";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chessbot-ws") return;

  let ws = null;
  let alive = true; // port still connected
  let reconnectTimer = null;
  let backoff = 1000;

  function connect() {
    if (!alive) return;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      backoff = 1000; // reset on success
      try { port.postMessage({ _type: "ws_open" }); } catch {}
    };

    ws.onmessage = (e) => {
      try { port.postMessage({ _type: "ws_msg", data: e.data }); } catch {}
    };

    ws.onclose = () => {
      try { port.postMessage({ _type: "ws_close" }); } catch {}
      scheduleReconnect();
    };

    ws.onerror = () => {
      try { port.postMessage({ _type: "ws_error" }); } catch {}
    };
  }

  function scheduleReconnect() {
    if (!alive || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 1.5, 10000);
  }

  port.onMessage.addListener((msg) => {
    if (msg._type === "ws_send" && ws && ws.readyState === 1) {
      ws.send(msg.data);
    }
  });

  port.onDisconnect.addListener(() => {
    alive = false;
    clearTimeout(reconnectTimer);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
      ws = null;
    }
  });

  connect();
});
