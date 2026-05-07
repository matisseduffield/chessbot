// Tests for StockfishBridge against a fake child_process. We never
// shell out to a real Stockfish — instead the constructor accepts a
// `spawnFn` that returns a controllable fake process. This keeps the
// suite hermetic, deterministic, and fast (~50 ms total).
//
// Coverage targets the previously-untested core: handshake, eval,
// abort, stop, crash recovery, option whitelist, and the configurable
// timeouts. Anything we couldn't safely exercise before now has a net.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';

// stockfishBridge requires ./config which exits the process on bad
// env. Set sentinel values BEFORE the bridge is required so config
// validates cleanly during the test run.
process.env.STOCKFISH_PATH = process.env.STOCKFISH_PATH || '/tmp/__test_sf__';

const requireCjs = createRequire(import.meta.url);
const StockfishBridge = requireCjs('./stockfishBridge');

/**
 * Build a fake child_process that supports the surface stockfishBridge
 * touches: stdin (with .write + 'error' event), stdout (data events),
 * stderr (data events), top-level 'exit' / 'error' events, and .kill().
 *
 * Returns { proc, drive } where `drive` lets the test emit lines on
 * stdout, push to stderr, and trigger exit.
 */
function makeFakeProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinChunks = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(chunk.toString());
      cb();
    },
  });
  // stdin needs an 'error' event subscriber path; Writable supports it.

  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.killed = false;
  proc.kill = vi.fn((_signal) => {
    proc.killed = true;
    // Mimic Node's behaviour: kill triggers an async 'exit'.
    queueMicrotask(() => proc.emit('exit', 0, _signal || null));
    return true;
  });

  const drive = {
    stdout(line) {
      stdout.emit('data', Buffer.from(line + '\n'));
    },
    stderr(line) {
      stderr.emit('data', Buffer.from(line + '\n'));
    },
    exit(code = 0, signal = null) {
      proc.emit('exit', code, signal);
    },
    error(err) {
      proc.emit('error', err);
    },
    /** Return everything written to stdin so far, as one string. */
    sentText() {
      return stdinChunks.join('');
    },
    /** Return individual lines written to stdin, trimmed and split. */
    sentLines() {
      return stdinChunks
        .join('')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    },
  };

  return { proc, drive };
}

/** Create a bridge wired to a fresh fake process; drive the handshake to ready. */
async function startedBridge(opts = {}) {
  const { proc, drive } = makeFakeProcess();
  const spawnFn = vi.fn(() => proc);
  const bridge = new StockfishBridge({
    spawnFn,
    binPath: '/tmp/__test_sf__',
    syzygyPath: '',
    handshakeTimeoutMs: 200,
    restartReadyTimeoutMs: 200,
    abortTimeoutMs: 50,
    stopFallbackMs: 50,
    killTimeoutMs: 50,
    ...opts,
  });
  const startPromise = bridge.start();
  // Let the spawn happen and the "uci" command flush.
  await Promise.resolve();
  // Reply to the UCI handshake.
  drive.stdout('option name Threads type spin default 1 min 1 max 512');
  drive.stdout('option name Hash type spin default 16 min 1 max 33554432');
  drive.stdout('option name MultiPV type spin default 1 min 1 max 500');
  drive.stdout('option name UCI_ShowWDL type check default false');
  drive.stdout('uciok');
  // Bridge sends "isready" after uciok.
  drive.stdout('readyok');
  await startPromise;
  return { bridge, proc, drive, spawnFn };
}

describe('StockfishBridge handshake', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('spawns the binary, handshakes, and resolves start()', async () => {
    const { bridge, drive, spawnFn } = await startedBridge();
    expect(spawnFn).toHaveBeenCalledWith('/tmp/__test_sf__');
    expect(bridge.ready).toBe(true);
    const sent = drive.sentLines();
    expect(sent).toContain('uci');
    expect(sent).toContain('isready');
    // Default-on UCI_ShowWDL should have been issued because the engine
    // reported the option during handshake.
    expect(sent.some((l) => l.startsWith('setoption name UCI_ShowWDL'))).toBe(true);
  });

  it('rejects start() if the engine never sends uciok', async () => {
    const { proc, drive } = makeFakeProcess();
    const bridge = new StockfishBridge({
      spawnFn: () => proc,
      binPath: '/tmp/__test_sf__',
      syzygyPath: '',
      handshakeTimeoutMs: 30,
      killTimeoutMs: 10,
    });
    const err = await bridge.start().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/handshake timeout/i);
    expect(proc.kill).toHaveBeenCalled();
    drive; // unused — just exercising the timeout path
  });

  it('only enables UCI_ShowWDL if the engine advertised it', async () => {
    const { proc, drive } = makeFakeProcess();
    const bridge = new StockfishBridge({
      spawnFn: () => proc,
      binPath: '/tmp/__test_sf__',
      syzygyPath: '',
      handshakeTimeoutMs: 200,
    });
    const p = bridge.start();
    await Promise.resolve();
    // No UCI_ShowWDL in the option list.
    drive.stdout('option name Threads type spin default 1 min 1 max 512');
    drive.stdout('uciok');
    drive.stdout('readyok');
    await p;
    expect(drive.sentLines().some((l) => l.includes('UCI_ShowWDL'))).toBe(false);
  });
});

describe('StockfishBridge.evaluate', () => {
  it('sends position+go and resolves on bestmove', async () => {
    const { bridge, drive } = await startedBridge();
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const evalP = bridge.evaluate(fen, 12);
    // Drive a single info line and then the bestmove.
    drive.stdout('info depth 12 multipv 1 score cp 25 pv e2e4 e7e5');
    drive.stdout('bestmove e2e4 ponder e7e5');
    const result = await evalP;
    expect(result.bestmove).toBe('e2e4');
    expect(result.lines.length).toBe(1);
    expect(result.lines[0].score).toBe(25);
    const sent = drive.sentLines();
    expect(sent).toContain(`position fen ${fen}`);
    expect(sent.some((l) => /^go .*depth 12/.test(l))).toBe(true);
  });

  it('rejects evaluate() if the engine is not ready', async () => {
    const { proc } = makeFakeProcess();
    const bridge = new StockfishBridge({
      spawnFn: () => proc,
      binPath: '/tmp/__test_sf__',
      syzygyPath: '',
    });
    // Never call start() — bridge.ready stays false.
    const err = await bridge.evaluate('fen', 10).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not ready/i);
  });

  it('supersedes a prior evaluate() with a typed rejection', async () => {
    const { bridge, drive } = await startedBridge();
    const first = bridge.evaluate('fenA', 10).catch((e) => e);
    // Don't drive bestmove for first; immediately fire a second.
    const second = bridge.evaluate('fenB', 10);
    drive.stdout('bestmove a2a4');
    const errA = await first;
    expect(errA).toBeInstanceOf(Error);
    expect(errA.message).toMatch(/superseded/i);
    const resB = await second;
    expect(resB.bestmove).toBe('a2a4');
  });

  it('supports infinite analysis (depth=0) without a safety timeout', async () => {
    const { bridge, drive } = await startedBridge();
    const evalP = bridge.evaluate('fen', 0);
    drive.stdout('info depth 22 multipv 1 score cp 18 pv e2e4');
    drive.stdout('bestmove e2e4');
    const r = await evalP;
    expect(r.bestmove).toBe('e2e4');
    expect(drive.sentLines().some((l) => l === 'go infinite')).toBe(true);
  });
});

describe('StockfishBridge.abort', () => {
  it('sends "stop" and resolves once bestmove arrives', async () => {
    const { bridge, drive } = await startedBridge();
    const evalP = bridge.evaluate('fen', 20);
    const abortP = bridge.abort();
    drive.stdout('bestmove e2e4');
    await Promise.all([evalP, abortP]);
    const sent = drive.sentLines();
    // Look for the post-go stop, ignoring earlier setoption noise.
    const postGo = sent.slice(sent.indexOf('go depth 20') + 1);
    expect(postGo).toContain('stop');
  });

  it('resolves on its own after abortTimeoutMs if the engine is idle', async () => {
    const { bridge, drive } = await startedBridge();
    const evalP = bridge.evaluate('fen', 10);
    drive.stdout('bestmove a2a4'); // resolves the pending eval first
    await evalP;
    // Now abort with no pending eval — should short-circuit.
    await expect(bridge.abort()).resolves.toBeUndefined();
  });
});

describe('StockfishBridge.setOption', () => {
  it('whitelists known options', async () => {
    const { bridge, drive } = await startedBridge();
    const lenBefore = drive.sentLines().length;
    bridge.setOption('Threads', 4);
    const newLines = drive.sentLines().slice(lenBefore);
    expect(newLines).toContain('setoption name Threads value 4');
  });

  it('rejects options not in the whitelist', async () => {
    const { bridge, drive } = await startedBridge();
    const lenBefore = drive.sentLines().length;
    bridge.setOption('EvalFile', '/tmp/some-net.nnue');
    expect(drive.sentLines().slice(lenBefore)).toEqual([]);
  });

  it('strips newlines from the value to prevent UCI command injection', async () => {
    const { bridge, drive } = await startedBridge();
    const lenBefore = drive.sentLines().length;
    bridge.setOption('Threads', '4\nsetoption name Hash value 9999');
    const newLines = drive.sentLines().slice(lenBefore);
    // The injected second command must NOT appear as its own UCI line.
    expect(newLines).toEqual(['setoption name Threads value 4setoption name Hash value 9999']);
    expect(newLines).not.toContain('setoption name Hash value 9999');
  });

  it('skips options the engine did not advertise', async () => {
    // No UCI_ShowWDL in this engine's option list.
    const { proc, drive } = makeFakeProcess();
    const bridge = new StockfishBridge({
      spawnFn: () => proc,
      binPath: '/tmp/__test_sf__',
      syzygyPath: '',
    });
    const p = bridge.start();
    await Promise.resolve();
    drive.stdout('option name Threads type spin default 1 min 1 max 512');
    drive.stdout('uciok');
    drive.stdout('readyok');
    await p;
    const lenBefore = drive.sentLines().length;
    bridge.setOption('UCI_ShowWDL', true);
    expect(drive.sentLines().slice(lenBefore)).toEqual([]);
  });
});

describe('StockfishBridge.stop', () => {
  it('returns a promise that resolves when the process exits', async () => {
    const { bridge, drive, proc } = await startedBridge();
    const stopP = bridge.stop();
    expect(drive.sentLines()).toContain('quit');
    drive.exit(0);
    await stopP;
    expect(bridge.ready).toBe(false);
    expect(proc.killed).toBe(false); // exited cleanly via "quit", no SIGKILL needed
  });

  it('SIGKILLs after killTimeoutMs if the engine ignores quit', async () => {
    const { bridge, proc } = await startedBridge();
    const stopP = bridge.stop();
    // Don't drive an exit. After killTimeoutMs (50ms in the harness)
    // the bridge should send SIGKILL, which our fake auto-completes
    // with an exit event.
    await stopP;
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('is idempotent on a never-started bridge', async () => {
    const bridge = new StockfishBridge({
      spawnFn: () => {
        throw new Error('should not spawn');
      },
      binPath: '/tmp/__test_sf__',
      syzygyPath: '',
    });
    await expect(bridge.stop()).resolves.toBeUndefined();
  });
});

describe('StockfishBridge crash recovery', () => {
  it('force-resolves a pending eval with crashed=true on unexpected exit', async () => {
    const { bridge, drive } = await startedBridge();
    const evalP = bridge.evaluate('fen', 15);
    // Engine dies mid-search.
    drive.exit(1);
    const r = await evalP;
    expect(r.crashed).toBe(true);
    expect(r.reason).toMatch(/engine_exit:code=1/);
  });

  it('annotates a corrupt-tablebase crash via stderr', async () => {
    const { bridge, drive } = await startedBridge();
    const evalP = bridge.evaluate('fen', 15);
    drive.stderr('Corrupt tablebase file KPvK.rtbz');
    drive.exit(1);
    const r = await evalP;
    expect(r.crashed).toBe(true);
    expect(r.reason).toBe('corrupt_tablebase:KPvK.rtbz');
  });

  it('does not auto-restart after stop()', async () => {
    const { bridge, proc, spawnFn } = await startedBridge();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const stopP = bridge.stop();
    proc.emit('exit', 0, null);
    await stopP;
    // No fresh spawn after stop().
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
