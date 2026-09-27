// Server-level integration test. Boots the real backend (Express + ws
// server + stockfishBridge) on an ephemeral port via child_process and
// drives it with a real WS client. The Stockfish binary is replaced
// with tests/fixtures/fake-stockfish.mjs so the test is hermetic.
//
// Purpose: regression net for the upcoming server.js modularization
// split (P2.F). Each major frame type is smoked end-to-end so the
// extractions don't silently break the protocol.
//
// Linux-only — the fake binary is a Node.js script with a shebang,
// which Windows runners can't execute the same way without a wrapper.
// The unit-level coverage in stockfishBridge.test.js remains
// cross-platform.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PROTOCOL_VERSION } from '@chessbot/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const fakeStockfish =
  process.env.TEST_STOCKFISH_PATH || resolve(repoRoot, 'tests/fixtures/fake-stockfish.mjs');

// `it.skipIf` lets us bail out cleanly on Windows runners without
// reporting a false failure.
const isWindows = process.platform === 'win32' && !process.env.TEST_STOCKFISH_PATH;
const itLinux = isWindows ? it.skip : it;

/**
 * Wait for the server to log "Listening" and resolve with the chosen port.
 */
function waitForListening(child) {
  return new Promise((resolveP, rejectP) => {
    const timeout = setTimeout(() => {
      rejectP(new Error('server did not start within 10s'));
    }, 10_000);
    const onData = (buf) => {
      const text = buf.toString();
      const m = text.match(/Listening on http:\/\/[^:]+:(\d+)/i);
      if (m) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolveP(Number(m[1]));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

/**
 * Wraps a WebSocket so the test can pull frames in arrival order without
 * racing the dispatcher: a single 'message' listener is attached at
 * open time, parsed frames are buffered, and `next(pred)` either drains
 * an already-arrived match or waits for the next matching frame.
 *
 * Without this, the test would have a window between `ws.off` (after
 * matching one frame) and the next `ws.on` where fast server replies
 * could land in no listener and be dropped.
 */
function openClient(port, client = 'extension', sessionId = randomUUID()) {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    /** @type {object[]} */
    const buffer = [];
    /** @type {Array<{ pred: (m: object) => boolean, resolve: (m: object) => void, timer: NodeJS.Timeout }>} */
    const waiters = [];

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          client,
          sessionId,
          protocolVersion: PROTOCOL_VERSION,
          site: 'fixture',
        }),
      );
      resolveP({
        ws,
        sessionId,
        buffer,
        next(pred = () => true, timeoutMs = 2000) {
          // Drain anything already buffered.
          for (let i = 0; i < buffer.length; i++) {
            if (pred(buffer[i])) {
              const msg = buffer[i];
              buffer.splice(i, 1);
              return Promise.resolve(msg);
            }
          }
          // Otherwise queue a waiter.
          return new Promise((rp, rejP) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === rp);
              if (idx >= 0) waiters.splice(idx, 1);
              rejP(new Error(`timed out waiting for frame after ${timeoutMs}ms`));
            }, timeoutMs);
            waiters.push({ pred, resolve: rp, timer });
          });
        },
        close() {
          for (const w of waiters) clearTimeout(w.timer);
          waiters.length = 0;
          ws.close();
        },
      });
    });

    ws.on('error', rejectP);
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      // First waiter that matches wins; everything else buffers.
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].pred(msg)) {
          clearTimeout(waiters[i].timer);
          const w = waiters.splice(i, 1)[0];
          w.resolve(msg);
          return;
        }
      }
      buffer.push(msg);
    });
  });
}

describe.skipIf(isWindows)('server integration', () => {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  /** @type {number} */
  let port = 0;

  beforeAll(async () => {
    child = spawn('node', [resolve(repoRoot, 'backend/server.js')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: '0', // ephemeral
        STOCKFISH_PATH: fakeStockfish,
        BIND_HOST: '127.0.0.1',
        // Skip LOG_LEVEL override — pino-pretty is async-buffered and
        // can swallow our own logs during test boot. We rely on the
        // explicit console.log "[server] listening" line, which is
        // not gated by LOG_LEVEL.
        NODE_ENV: 'test',
        CHESSBOT_DATA_DIR: mkdtempSync(resolve(tmpdir(), 'chessbot-integration-')),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    port = await waitForListening(child);
  }, 15_000);

  afterAll(async () => {
    if (!child) return;
    child.kill('SIGINT');
    // Wait briefly for graceful shutdown; force-kill if it hangs.
    await new Promise((r) => {
      const t = setTimeout(() => {
        child?.kill('SIGKILL');
        r();
      }, 2000);
      child?.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  });

  itLinux('serves /healthz with engine.ready=true', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.engine?.ready).toBe(true);
  });

  itLinux('greets new WS clients with server_hello', async () => {
    const c = await openClient(port);
    try {
      const hello = await c.next((m) => m.type === 'server_hello');
      expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(typeof hello.serverVersion).toBe('string');
    } finally {
      c.close();
    }
  });

  itLinux('rejects valid JSON missing the type field with code=invalid_frame', async () => {
    const c = await openClient(port);
    try {
      await c.next((m) => m.type === 'server_hello');
      // The server silently drops un-parseable input (not JSON), but
      // emits bad_frame for JSON that isn't an object-with-string-type.
      c.ws.send(JSON.stringify({ foo: 'bar' }));
      const err = await c.next((m) => m.type === 'error');
      expect(err.code).toBe('invalid_frame');
    } finally {
      c.close();
    }
  });

  itLinux('rejects unknown message types via Zod gate', async () => {
    const c = await openClient(port);
    try {
      await c.next((m) => m.type === 'server_hello');
      c.ws.send(JSON.stringify({ type: 'definitely_not_a_real_type' }));
      const err = await c.next((m) => m.type === 'error');
      expect(err.code).toBe('unknown_type');
    } finally {
      c.close();
    }
  });

  itLinux('rejects an invalid FEN', async () => {
    const c = await openClient(port);
    try {
      await c.next((m) => m.type === 'server_hello');
      c.ws.send(JSON.stringify({ type: 'fen', fen: 'totally-not-a-fen', depth: 5 }));
      const err = await c.next((m) => m.type === 'error');
      expect(err.code).toBe('invalid_fen');
    } finally {
      c.close();
    }
  });

  itLinux('drives a full bestmove cycle on the start position', async () => {
    const c = await openClient(port);
    try {
      await c.next((m) => m.type === 'server_hello');
      const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      c.ws.send(JSON.stringify({ type: 'fen', fen: startFen, depth: 3 }));
      const reply = await c.next((m) => m.type === 'bestmove', 5000);
      expect(typeof reply.bestmove).toBe('string');
      expect(reply.bestmove.length).toBeGreaterThanOrEqual(4);
      expect(reply.fen).toBe(startFen);
      // Source can be 'book' on the start position; engine path uses
      // our fake which always returns e2e4. Either is acceptable.
      expect(['engine', 'book', 'lichess']).toContain(reply.source);
    } finally {
      c.close();
    }
  });

  itLinux(
    'isolates two boards, correlates replies, and hides training answers in the panel',
    async () => {
      const a = await openClient(port),
        b = await openClient(port),
        panel = await openClient(port, 'panel');
      const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      try {
        panel.ws.send(
          JSON.stringify({ type: 'subscribe_session', sessionId: a.sessionId, followFocus: false }),
        );
        await panel.next((m) => m.type === 'sessions' && m.selectedSessionId === a.sessionId);
        a.ws.send(
          JSON.stringify({
            type: 'fen',
            fen,
            depth: 3,
            training: true,
            multipv: 3,
            requestId: 'train-a',
          }),
        );
        a.ws.send(JSON.stringify({ type: 'game_info', white: { clock: '2:00' } }));
        const move = await a.next((m) => m.type === 'bestmove' && !m.streaming);
        expect(move.requestId).toBe('train-a');
        expect(move.sessionId).toBe(a.sessionId);
        const hidden = await panel.next((m) => m.type === 'bestmove' && !m.streaming);
        expect(hidden.trainingHidden).toBe(true);
        expect(hidden.bestmove).toBeNull();
        expect(hidden.lines[0].pv).toBeUndefined();
        b.ws.send(JSON.stringify({ type: 'fen', fen, depth: 3, requestId: 'normal-b' }));
        await b.next((m) => m.type === 'bestmove' && m.requestId === 'normal-b');
        expect(a.buffer.some((m) => m.requestId === 'normal-b')).toBe(false);
        expect(panel.buffer.some((m) => m.requestId === 'normal-b')).toBe(false);
        a.ws.send(JSON.stringify({ type: 'get_settings', requestId: 'check-pv' }));
        const settings = await a.next((m) => m.type === 'settings' && m.requestId === 'check-pv');
        expect(Number(settings.settings.MultiPV)).toBe(1);
      } finally {
        a.close();
        b.close();
        panel.close();
      }
    },
  );

  itLinux(
    'acknowledges real controls and rejects invalid settings without applying them',
    async () => {
      const a = await openClient(port);
      try {
        for (const frame of [
          { type: 'set_live_engine_stream', value: true },
          { type: 'set_lichess_book', value: false },
        ]) {
          a.ws.send(JSON.stringify(frame));
          await a.next((m) => m.type === 'setting_applied' && m.command === frame.type);
        }
        a.ws.send(JSON.stringify({ type: 'set_option', name: 'depth', value: 0 }));
        await a.next((m) => m.type === 'option_set');
        a.ws.send(JSON.stringify({ type: 'set_option', name: 'Threads', value: -1 }));
        expect((await a.next((m) => m.type === 'error')).code).toBe('invalid_option');
        a.ws.send(JSON.stringify({ type: 'get_settings' }));
        const settings = await a.next((m) => m.type === 'settings');
        expect(settings.defaultDepth).toBe(0);
        expect(settings.liveEngineStream).toBe(true);
        expect(Number(settings.settings.Threads)).toBeGreaterThan(0);
      } finally {
        a.close();
      }
    },
  );

  itLinux(
    'persists a training attempt, supplies post-move feedback and clears history independently',
    async () => {
      const a = await openClient(port),
        panel = await openClient(port, 'panel');
      try {
        const id = randomUUID();
        a.ws.send(
          JSON.stringify({
            type: 'training_attempt',
            attempt: {
              id,
              before: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
              after: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
              variant: 'chess',
              site: 'fixture',
              player: 'w',
              recommendation: 'e2e4',
              playedMove: 'e2e4',
              correct: true,
              assisted: false,
              timestamp: Date.now(),
            },
          }),
        );
        const history = await panel.next(
          (m) =>
            m.type === 'training_history' &&
            m.attempts.some((a) => a.id === id && a.feedback.status === 'ready'),
          8000,
        );
        expect(history.attempts.find((a) => a.id === id).feedback.lossCp).toBeGreaterThanOrEqual(0);
        panel.ws.send(JSON.stringify({ type: 'clear_training_history' }));
        await panel.next((m) => m.type === 'training_history' && !m.attempts.length);
        a.ws.send(JSON.stringify({ type: 'get_training_history' }));
        expect((await a.next((m) => m.type === 'training_history')).attempts).toEqual([]);
        const stats = await a.next((m) => m.type === 'training_stats_update' && m.total === 1);
        expect(stats.unassisted).toBe(1);
      } finally {
        a.close();
        panel.close();
      }
    },
  );
});
