const { spawn } = require("child_process");
const fs = require("fs");
const config = require("./config");

class StockfishBridge {
  constructor() {
    this.process = null;
    this.ready = false;
    this._restartPromise = null; // set while engine is restarting
    this._pendingResolve = null;
    this._handleLine = this._defaultLineHandler.bind(this);
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
    return new Promise((resolve, reject) => {
      console.log(`[stockfish] spawning: ${config.stockfishPath}`);
      this.process = spawn(config.stockfishPath);

      this.process.on("error", (err) => {
        console.error("[stockfish] failed to start:", err.message);
        reject(err);
      });

      this.process.on("exit", (code, signal) => {
        console.error(`[stockfish] process exited unexpectedly (code=${code}, signal=${signal})`);
        this.ready = false;
        // Force-resolve any pending evaluation so the queue doesn't deadlock
        if (this._pendingResolve) {
          const res = this._pendingResolve;
          this._pendingResolve = null;
          this._pendingPV = null;
          res({ bestmove: null, lines: [] });
        }
        if (this._abortResolve) {
          this._abortResolve();
          this._abortResolve = null;
        }
      });

      this.process.stderr.on("data", (data) => {
        console.error("[stockfish][stderr]", data.toString().trim());
      });

      let buffer = "";

      this.process.stdout.on("data", (chunk) => {
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

      // Kick off UCI handshake
      this._send("uci");

      // Wait for "uciok"
      const onLine = this._handleLine.bind(this);
      this._handleLine = (line) => {
        console.log(`[stockfish] ${line}`);
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
              this._handleLine = this._defaultLineHandler.bind(this);
              // Enable WDL by default
              this._send("setoption name UCI_ShowWDL value true");
              console.log("[stockfish] engine ready");
              resolve();
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

      const goParams = [];
      if (options.movetime) goParams.push(`movetime ${options.movetime}`);
      else if (options.nodes) goParams.push(`nodes ${options.nodes}`);
      if (depth) goParams.push(`depth ${depth}`);
      // If no limit specified at all, use depth as fallback
      if (!goParams.length) goParams.push(`depth 15`);

      console.log(`[stockfish] evaluating: ${fen} (${goParams.join(" ")})`);

      const multiPV = Number(this._settings.MultiPV) || 1;
      const pvLines = {}; // multipv index → latest info at highest depth

      this._pendingResolve = resolve;
      this._pendingPV = pvLines;
      this._pendingMultiPV = multiPV;
      this._pendingTargetDepth = depth;

      // Safety-net timeout: if Stockfish doesn't respond within 20s, force resolve
      clearTimeout(this._evalTimeout);
      this._evalTimeout = setTimeout(() => {
        if (this._pendingResolve) {
          console.warn("[stockfish] evaluation timeout — forcing stop");
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
      }, 20_000);

      this._send(`position fen ${fen}`);
      this._send(`go ${goParams.join(" ")}`);
    });
  }

  /** Abort the current evaluation. Stockfish will emit bestmove immediately.
   *  Returns a promise that resolves once the bestmove response is consumed. */
  abort() {
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
      }, 500);
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
    this._send(`setoption name ${name} value ${value}`);
    this._settings[name] = value;
    console.log(`[stockfish] option ${name} = ${value}`);
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
    if (this.process) {
      this._send("quit");
      this.process = null;
      this.ready = false;
      console.log("[stockfish] stopped");
    }
  }

  /** Kill and restart the engine after it becomes unresponsive. */
  _restart() {
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
        // Re-apply saved settings
        for (const [name, value] of Object.entries(this._settings)) {
          this._send(`setoption name ${name} value ${value}`);
        }
        this._send("isready");
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
    this.process.stdin.write(cmd + "\n");
  }

  _defaultLineHandler(line) {
    // Collect info lines with multipv data
    if (line.startsWith("info") && line.includes(" pv ")) {
      console.log(`[stockfish] ${line}`);

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
