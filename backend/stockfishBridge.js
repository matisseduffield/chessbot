const { spawn } = require("child_process");
const fs = require("fs");
const config = require("./config");

class StockfishBridge {
  constructor() {
    this.process = null;
    this.ready = false;
    this._processGen = 0; // incremented on each spawn to discard stale exit events
    this._restartPromise = null; // set while engine is restarting
    this._stopped = false; // set by stop() to prevent _restart() from reviving
    this._stopping = false; // set when stop() is called to suppress exit error
    this._pendingResolve = null;
    this._pendingReject = null;
    this._handleLine = this._defaultLineHandler.bind(this);
    this._supportedOptions = new Set(); // populated during UCI handshake
    this._settings = {
      Threads: 1,
      Hash: 16,
      MultiPV: 1,
      "Skill Level": 20,
      UCI_ShowWDL: true,
    };
  }

  /** Spawn Stockfish and wait for the initial UCI handshake. */
  start() {
    this._stopped = false;
    const gen = ++this._processGen;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      console.log(`[stockfish] spawning: ${config.stockfishPath}`);
      this.process = spawn(config.stockfishPath);

      // Catch EPIPE / broken pipe on stdin to prevent crashing Node
      this.process.stdin.on("error", (err) => {
        console.error("[stockfish] stdin error:", err.message);
      });

      this.process.on("error", (err) => {
        console.error("[stockfish] failed to start:", err.message);
        settle(reject, err);
      });

      this.process.on("exit", (code, signal) => {
        // Discard exit events from old processes (race with _restart)
        if (gen !== this._processGen) return;
        if (this._stopping) {
          this._stopping = false;
          return; // Expected exit from stop()
        }
        console.error(`[stockfish] process exited unexpectedly (code=${code}, signal=${signal})`);
        this.ready = false;
        this.process = null;
        // Clear any in-flight timers to prevent them firing on a dead process
        clearTimeout(this._evalTimeout);
        clearTimeout(this._stopFallback);
        clearTimeout(this._abortTimeout);
        // If we were still in the handshake, reject the start() promise
        settle(reject, new Error(`Engine exited during startup (code=${code})`));
        // Force-resolve any pending evaluation so the queue doesn't deadlock
        if (this._pendingResolve) {
          const res = this._pendingResolve;
          this._pendingResolve = null;
          this._pendingReject = null;
          this._pendingPV = null;
          res({ bestmove: null, lines: [] });
        }
        if (this._abortResolve) {
          this._abortResolve();
          this._abortResolve = null;
        }
        // Auto-restart the engine so subsequent evaluations work
        if (!this._stopped) this._restart();
      });

      this.process.stderr.on("data", (data) => {
        console.error("[stockfish][stderr]", data.toString().trim());
      });

      let buffer = "";

      this.process.stdout.on("data", (chunk) => {
        // Discard stdout from old processes
        if (gen !== this._processGen) return;
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop();

        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          this._handleLine(line);
        }
      });

      // Handshake timeout: if engine never responds, reject after 15s
      const handshakeTimeout = setTimeout(() => {
        if (!settled) {
          console.error("[stockfish] UCI handshake timeout (15s) — killing engine");
          try { if (this.process) this.process.kill("SIGKILL"); } catch {}
          settle(reject, new Error("UCI handshake timeout"));
        }
      }, 15_000);

      // Kick off UCI handshake
      this._send("uci");

      // Wait for "uciok"
      this._supportedOptions = new Set();
      const onLine = this._handleLine;
      this._handleLine = (line) => {
        console.log(`[stockfish] ${line}`);
        // Collect supported option names during handshake
        const optMatch = line.match(/^option name (.+?) type /);
        if (optMatch) this._supportedOptions.add(optMatch[1]);
        if (line === "uciok") {
          this.ready = true;
          this._handleLine = onLine; // restore

          // Configure Syzygy tablebases if the path exists
          if (config.syzygyPath && fs.existsSync(config.syzygyPath)) {
            this._send(`setoption name SyzygyPath value ${config.syzygyPath}`);
            console.log(`[stockfish] Syzygy tablebases: ${config.syzygyPath}`);
          } else {
            console.log("[stockfish] Syzygy tablebases: not configured");
          }

          this._send("isready");
          // Wait for "readyok" before resolving
          this._handleLine = (l) => {
            console.log(`[stockfish] ${l}`);
            if (l === "readyok") {
              clearTimeout(handshakeTimeout);
              this._handleLine = this._defaultLineHandler.bind(this);
              // Enable WDL by default (only if engine supports it)
              if (this._supportedOptions.has("UCI_ShowWDL")) {
                this._send("setoption name UCI_ShowWDL value true");
              }
              console.log("[stockfish] engine ready");
              settle(resolve);
            }
          };
        }
      };
    });
  }

  /** Send a FEN to Stockfish and return evaluation results.
   *  options: { depth, movetime, nodes } — at least one should be set.
   *  Returns { bestmove, lines: [{ move, score, mate, pv }] } */
  async evaluate(fen, depth = 15, options = {}) {
    // If engine is restarting, wait for it before proceeding
    if (this._restartPromise) {
      console.log("[stockfish] waiting for engine restart before evaluating...");
      await this._restartPromise;
    }
    return new Promise((resolve, reject) => {
      if (!this.ready) return reject(new Error("Engine not ready"));

      // Reject any previously pending evaluation to prevent promise leaks
      if (this._pendingResolve) {
        const oldReject = this._pendingReject;
        this._pendingResolve = null;
        this._pendingReject = null;
        this._pendingPV = null;
        if (oldReject) oldReject(new Error("Superseded by new evaluation"));
      }

      const hasTimeOrNodeLimit = !!(options.movetime || options.nodes);
      const isInfinite = (options.infinite || depth === 0) && !hasTimeOrNodeLimit;
      const goParams = [];
      if (isInfinite) {
        goParams.push("infinite");
      } else {
        if (options.movetime) goParams.push(`movetime ${options.movetime}`);
        else if (options.nodes) goParams.push(`nodes ${options.nodes}`);
        // Always send depth when set — Stockfish respects whichever
        // limit (depth OR time/nodes) is reached first.
        if (depth) goParams.push(`depth ${depth}`);
        // If no limit specified at all, use depth as fallback
        if (!goParams.length) goParams.push(`depth 15`);
      }

      console.log(`[stockfish] evaluating: ${fen} (${goParams.join(" ")})`);

      const multiPV = Number(this._settings.MultiPV) || 1;
      const pvLines = {}; // multipv index → latest info at highest depth

      this._pendingResolve = resolve;
      this._pendingReject = reject;
      this._pendingPV = pvLines;
      this._pendingMultiPV = multiPV;
      this._pendingTargetDepth = depth;
      this._isInfinite = isInfinite;
      this._onInfoCallback = options.onInfo || null;

      // Safety-net timeout: scale with depth (min 20s, +3s per depth above 15, max 180s)
      // Skip for infinite analysis (engine runs until explicitly stopped)
      clearTimeout(this._evalTimeout);
      if (!isInfinite) {
        const timeoutMs = Math.min(180_000, Math.max(20_000, 20_000 + (depth - 15) * 3_000));
        this._evalTimeout = setTimeout(() => {
        if (this._pendingResolve) {
          console.warn(`[stockfish] evaluation timeout (${timeoutMs}ms) — forcing stop`);
          this._send("stop");
          // If stop doesn't produce bestmove within 2s, force-resolve and restart
          this._stopFallback = setTimeout(() => {
            if (this._pendingResolve) {
              console.error("[stockfish] engine unresponsive — force-resolving eval and restarting");
              const res = this._pendingResolve;
              this._pendingResolve = null;
              this._pendingPV = null;
              res({ bestmove: null, lines: [] });
              // Restart the engine so subsequent evals work
              this._restart();
            }
          }, 2000);
        }
      }, timeoutMs);
      }

      this._send(`position fen ${fen}`);
      this._send(`go ${goParams.join(" ")}`);
    });
  }

  /** Abort the current evaluation. Stockfish will emit bestmove immediately.
   *  Returns a promise that resolves once the bestmove response is consumed. */
  abort() {
    // Clear stale abort timeout from a previous abort call
    clearTimeout(this._abortTimeout);
    // Resolve any previously pending abort promise to prevent queue deadlock.
    if (this._abortResolve) {
      this._abortResolve();
      this._abortResolve = null;
    }
    if (!this._pendingResolve) return Promise.resolve();
    console.log("[stockfish] aborting current evaluation");
    this._send("stop");
    // Return a promise that resolves when the bestmove line arrives,
    // with a safety timeout in case the engine is already idle
    // (stop sent to an idle engine produces no bestmove output).
    return new Promise((resolve) => {
      this._abortResolve = resolve;
      this._abortTimeout = setTimeout(() => {
        if (this._abortResolve === resolve) {
          console.log("[stockfish] abort timeout — engine likely idle, unblocking queue");
          this._abortResolve = null;
          this._pendingResolve = null;
          this._pendingPV = null;
          resolve();
        }
      }, 3000);
    });
  }

  /** Set a UCI option (e.g. Threads, Hash, MultiPV, Skill Level). */
  setOption(name, value) {
    if (!this.ready) return;
    // Whitelist of safe UCI options
    const allowed = [
      "Threads", "Hash", "MultiPV", "Skill Level",
      "UCI_Chess960", "UCI_ShowWDL", "SyzygyPath",
      "SyzygyProbeDepth", "Syzygy50MoveRule", "SyzygyProbeLimit",
      "UCI_Variant",
    ];
    if (!allowed.includes(name)) {
      console.warn(`[stockfish] option "${name}" not in whitelist, ignoring`);
      return;
    }
    // Skip options not supported by the current engine
    if (this._supportedOptions.size > 0 && !this._supportedOptions.has(name)) {
      console.log(`[stockfish] option "${name}" not supported by this engine, skipping`);
      return;
    }
    // Sanitize value to prevent UCI command injection via newlines
    const safeValue = String(value).replace(/[\r\n]/g, "");
    this._send(`setoption name ${name} value ${safeValue}`);
    this._settings[name] = safeValue;
    console.log(`[stockfish] option ${name} = ${safeValue}`);
  }

  /** Get current settings (for syncing to UI). */
  getSettings() {
    return { ...this._settings };
  }

  /** Clear the transposition table. */
  clearHash() {
    if (!this.ready) return;
    this._send("setoption name Clear Hash");
    this._send("isready");
    console.log("[stockfish] hash cleared");
  }

  /** Stop the engine process. */
  stop() {
    this._stopped = true; // prevent _restart() from reviving
    // Clear any in-flight timers to prevent them firing on a dead process
    clearTimeout(this._evalTimeout);
    clearTimeout(this._stopFallback);
    clearTimeout(this._abortTimeout);
    if (this._pendingResolve) {
      const res = this._pendingResolve;
      this._pendingResolve = null;
      this._pendingReject = null;
      this._pendingPV = null;
      res({ bestmove: null, lines: [] });
    }
    if (this._abortResolve) {
      this._abortResolve();
      this._abortResolve = null;
    }
    if (this.process) {
      this._stopping = true;
      const proc = this.process;
      this._send("quit");
      this.process = null;
      this.ready = false;
      // Force-kill fallback if quit doesn't work within 2s
      setTimeout(() => {
        try { if (!proc.killed) proc.kill("SIGKILL"); } catch {}
      }, 2000);
      console.log("[stockfish] stopped");
    }
  }

  /** Kill and restart the engine after it becomes unresponsive. */
  _restart() {
    if (this._stopped) return Promise.resolve(); // stop() was called, don't revive
    if (this._restartPromise) return this._restartPromise;
    this._restartPromise = (async () => {
      console.log("[stockfish] restarting engine...");
      if (this.process) {
        try { this.process.kill("SIGKILL"); } catch {}
        this.process = null;
      }
      this.ready = false;
      try {
        await this.start();
        // Re-apply saved settings after start() (which already completed UCI handshake)
        for (const [name, value] of Object.entries(this._settings)) {
          this._send(`setoption name ${name} value ${value}`);
        }
        // Wait for engine to acknowledge all options before declaring ready
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("isready timeout during restart"));
          }, 10_000);
          this._send("isready");
          const prev = this._handleLine;
          this._handleLine = (line) => {
            if (line === "readyok") {
              clearTimeout(timeout);
              this._handleLine = prev;
              resolve();
            } else {
              prev(line);
            }
          };
        });
        console.log("[stockfish] engine restarted successfully");
      } catch (err) {
        console.error("[stockfish] failed to restart:", err.message);
      } finally {
        this._restartPromise = null;
      }
    })();
    return this._restartPromise;
  }

  // ── internals ──────────────────────────────────────────

  _send(cmd) {
    if (!this.process) return;
    console.log(`[stockfish] >>> ${cmd}`);
    try {
      this.process.stdin.write(cmd + "\n");
    } catch (err) {
      console.error("[stockfish] stdin write error:", err.message);
    }
  }

  _defaultLineHandler(line) {
    // Collect info lines with multipv data
    if (line.startsWith("info") && line.includes(" pv ")) {
      // Only log at key depth milestones to reduce noise
      const _depthMatch = line.match(/\bdepth (\d+)/);
      const _d = _depthMatch ? parseInt(_depthMatch[1], 10) : 0;
      if (_d <= 2 || _d >= (this._pendingTargetDepth || 15) - 1) {
        const _cpMatch = line.match(/\bscore cp (-?\d+)/);
        const _mateMatch = line.match(/\bscore mate (-?\d+)/);
        const _nodesMatch = line.match(/\bnodes (\d+)/);
        const score = _mateMatch ? `M${_mateMatch[1]}` : (_cpMatch ? `cp ${_cpMatch[1]}` : "?");
        const nodes = _nodesMatch ? _nodesMatch[1] : "?";
        console.log(`[stockfish] depth ${_d}, ${score}, nodes ${nodes}`);
      }

      // Parse: info depth D ... multipv N score cp X ... pv MOVE1 MOVE2 ...
      // or:   info depth D ... multipv N score mate M ... pv MOVE1 ...
      const depthMatch = line.match(/\bdepth (\d+)/);
      const pvIdxMatch = line.match(/\bmultipv (\d+)/);
      const cpMatch = line.match(/\bscore cp (-?\d+)/);
      const mateMatch = line.match(/\bscore mate (-?\d+)/);
      const pvMatch = line.match(/\bpv (.+)/);

      if (depthMatch && pvMatch) {
        const d = parseInt(depthMatch[1], 10);
        const idx = pvIdxMatch ? parseInt(pvIdxMatch[1], 10) : 1;
        const pv = pvMatch[1].trim().split(/\s+/);
        const entry = { move: pv[0], pv, depth: d };

        if (cpMatch) entry.score = parseInt(cpMatch[1], 10);
        if (mateMatch) entry.mate = parseInt(mateMatch[1], 10);

        // Parse nodes and nps for confidence metrics
        const nodesMatch = line.match(/\bnodes (\d+)/);
        const npsMatch = line.match(/\bnps (\d+)/);
        const timeMatch = line.match(/\btime (\d+)/);
        if (nodesMatch) entry.nodes = parseInt(nodesMatch[1], 10);
        if (npsMatch) entry.nps = parseInt(npsMatch[1], 10);
        if (timeMatch) entry.timeMs = parseInt(timeMatch[1], 10);

        // Parse WDL if present: "wdl 553 367 80"
        const wdlMatch = line.match(/\bwdl (\d+) (\d+) (\d+)/);
        if (wdlMatch) {
          entry.wdl = {
            win: parseInt(wdlMatch[1], 10),
            draw: parseInt(wdlMatch[2], 10),
            loss: parseInt(wdlMatch[3], 10),
          };
        }

        // Keep latest (highest depth) per multipv index
        if (this._pendingPV) {
          const prev = this._pendingPV[idx];
          if (!prev || d >= prev.depth) {
            this._pendingPV[idx] = entry;
          }
          // Emit intermediate results when all PVs updated at this depth
          if (this._onInfoCallback) {
            const mpv = this._pendingMultiPV || 1;
            const filledCount = Object.keys(this._pendingPV).length;
            if (filledCount >= mpv) {
              const lines = Object.keys(this._pendingPV).map(Number).sort((a, b) => a - b).map(i => this._pendingPV[i]);
              this._onInfoCallback({ bestmove: lines[0].move, lines, depth: d });
            }
          }
        }
      }
    } else if (line.startsWith("info")) {
      console.log(`[stockfish] ${line}`);
    }

    // The bestmove line resolves the pending promise
    if (line.startsWith("bestmove")) {
      console.log(`[stockfish] ${line}`);
      clearTimeout(this._evalTimeout);
      clearTimeout(this._stopFallback);
      clearTimeout(this._abortTimeout);
      const bestmove = line.split(" ")[1];

      // Build lines array from collected PV data
      const lines = [];
      if (this._pendingPV) {
        const indices = Object.keys(this._pendingPV).map(Number).sort((a, b) => a - b);
        for (const idx of indices) {
          lines.push(this._pendingPV[idx]);
        }
      }

      if (this._pendingResolve) {
        this._pendingResolve({ bestmove, lines });
        this._pendingResolve = null;
        this._pendingPV = null;
      }
      // If we were aborting, signal that the abort is complete
      if (this._abortResolve) {
        this._abortResolve();
        this._abortResolve = null;
      }
    }
  }
}

module.exports = StockfishBridge;
