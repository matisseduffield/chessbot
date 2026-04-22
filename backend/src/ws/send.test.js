import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require2 = createRequire(import.meta.url);
const { safeSend, broadcast } = require2('./send.js');

function fakeWs(state = 1) {
  const ws = {
    readyState: state,
    sent: [],
    send(payload) {
      if (ws._throw) throw new Error('closed');
      ws.sent.push(payload);
    },
  };
  return ws;
}

describe('safeSend', () => {
  it('sends stringified JSON for objects', () => {
    const ws = fakeWs();
    expect(safeSend(ws, { type: 'hi' })).toBe(true);
    expect(ws.sent).toEqual(['{"type":"hi"}']);
  });
  it('passes strings through untouched', () => {
    const ws = fakeWs();
    safeSend(ws, 'raw');
    expect(ws.sent).toEqual(['raw']);
  });
  it('returns false for closed socket', () => {
    const ws = fakeWs(3);
    expect(safeSend(ws, { a: 1 })).toBe(false);
    expect(ws.sent).toEqual([]);
  });
  it('swallows send errors', () => {
    const ws = fakeWs();
    ws._throw = true;
    expect(safeSend(ws, {})).toBe(false);
  });
  it('returns false for null ws', () => {
    expect(safeSend(null, {})).toBe(false);
  });
});

describe('broadcast', () => {
  it('sends to all clients except sender', () => {
    const a = fakeWs(),
      b = fakeWs(),
      c = fakeWs();
    const wss = { clients: new Set([a, b, c]) };
    const n = broadcast(wss, a, { t: 1 });
    expect(n).toBe(2);
    expect(a.sent).toEqual([]);
    expect(b.sent[0]).toContain('"t":1');
  });
  it('skips closed peers', () => {
    const a = fakeWs(),
      b = fakeWs(3);
    const wss = { clients: new Set([a, b]) };
    expect(broadcast(wss, null, { t: 1 })).toBe(1);
  });
  it('handles missing wss', () => {
    expect(broadcast(null, null, {})).toBe(0);
  });
});
