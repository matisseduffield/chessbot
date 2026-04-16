// Background service worker — relays WebSocket connections for content scripts.
// Chrome blocks ws://localhost from HTTPS content scripts (Private Network Access).
// The service worker has unrestricted network access, so it acts as a proxy.

const WS_URL = "ws://localhost:8080";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chessbot-ws") return;

  let ws = null;

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    port.postMessage({ _type: "ws_error" });
    port.postMessage({ _type: "ws_close" });
    return;
  }

  ws.onopen = () => {
    try { port.postMessage({ _type: "ws_open" }); } catch {}
  };

  ws.onmessage = (e) => {
    try { port.postMessage({ _type: "ws_msg", data: e.data }); } catch {}
  };

  ws.onclose = () => {
    try { port.postMessage({ _type: "ws_close" }); } catch {}
  };

  ws.onerror = () => {
    try { port.postMessage({ _type: "ws_error" }); } catch {}
  };

  port.onMessage.addListener((msg) => {
    if (msg._type === "ws_send" && ws && ws.readyState === 1) {
      ws.send(msg.data);
    }
  });

  port.onDisconnect.addListener(() => {
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
      ws = null;
    }
  });
});
