#!/usr/bin/env node
// Minimal UCI engine for integration tests. Speaks just enough of the
// protocol to satisfy stockfishBridge's handshake and produce a
// bestmove for `go`/`position`. Doesn't actually search anything —
// always replies with `e2e4`.
//
// Used by backend/server.integration.test.js so we can boot the real
// server (Express + ws + bridge) without depending on a real
// Stockfish binary in the test environment.

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    handleLine(line);
  }
});

process.stdin.on('end', () => process.exit(0));

function send(line) {
  process.stdout.write(line + '\n');
}

function handleLine(line) {
  if (!line) return;
  if (line === 'uci') {
    send('id name FakeStockfish 0');
    send('id author chessbot tests');
    send('option name Threads type spin default 1 min 1 max 512');
    send('option name Hash type spin default 16 min 1 max 33554432');
    send('option name MultiPV type spin default 1 min 1 max 500');
    send('option name UCI_ShowWDL type check default false');
    send('option name UCI_Chess960 type check default false');
    send('uciok');
    return;
  }
  if (line === 'isready') {
    send('readyok');
    return;
  }
  if (line.startsWith('go')) {
    // Emit one streaming-info frame then a bestmove on the next tick
    // so the bridge sees a complete eval cycle.
    setImmediate(() => {
      send('info depth 1 multipv 1 score cp 0 nodes 1 pv e2e4');
      send('bestmove e2e4');
    });
    return;
  }
  if (line === 'stop') {
    send('bestmove e2e4');
    return;
  }
  if (line === 'quit') {
    process.exit(0);
  }
  // Ignore setoption / position / ucinewgame / etc.
}
