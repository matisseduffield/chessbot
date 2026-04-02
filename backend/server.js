const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const StockfishBridge = require("./stockfishBridge");
const OpeningBook = require("./openingBook");
const config = require("./config");

// ── File scanner helpers ─────────────────────────────────

/** Recursively find files matching extensions in a directory */
function scanFiles(dir, extensions) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        results.push({ name: entry.name, path: full });
      }
    }
  };
  walk(dir);
  return results;
}

function listEngines() {
  return scanFiles(config.engineDir, [".exe"]);
}

function listBooks() {
  return scanFiles(config.booksDir, [".bin"]);
}

function listSyzygyDirs() {
  // Return directories that contain .rtbw or .rtbz files
  const results = [];
  if (!fs.existsSync(config.syzygyDir)) return results;
  // Check root
  const rootFiles = fs.readdirSync(config.syzygyDir);
  const hasTB = rootFiles.some((f) => f.endsWith(".rtbw") || f.endsWith(".rtbz"));
  if (hasTB) results.push({ name: path.basename(config.syzygyDir), path: config.syzygyDir });
  // Check subdirs
  for (const entry of fs.readdirSync(config.syzygyDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const subPath = path.join(config.syzygyDir, entry.name);
      const subFiles = fs.readdirSync(subPath);
      const subHasTB = subFiles.some((f) => f.endsWith(".rtbw") || f.endsWith(".rtbz"));
      if (subHasTB) results.push({ name: entry.name, path: subPath });
    }
  }
  return results;
}
async function main() {
  // ── 1. Start the Stockfish engine ──────────────────────
  let engine = new StockfishBridge();
  try {
    await engine.start();
  } catch (err) {
    console.error("[server] could not start Stockfish – exiting.", err.message);
    process.exit(1);
  }

  // ── 2. Load opening book (optional) ───────────────────
  let book = new OpeningBook(config.openingBookPath);
  await book.init();

  // ── 3. Start WebSocket server ──────────────────────────
  const wss = new WebSocketServer({ port: config.port });

  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[server] port ${config.port} is already in use. Kill the other process or set PORT env var.`);
    } else {
      console.error("[server] WebSocket server error:", err.message);
    }
    engine.stop();
    book.close();
    process.exit(1);
  });

  console.log(`[server] WebSocket server listening on ws://localhost:${config.port}`);

  wss.on("connection", (ws, req) => {
    const remote = req.socket.remoteAddress;
    console.log(`[server] client connected (${remote})`);

    // Per-client generation counter — prevents cross-client eval interference
    let evalGeneration = 0;
    let evaluationQueue = Promise.resolve();

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        console.warn("[server] received non-JSON message, ignoring");
        return;
      }

      if (msg.type === "fen" && typeof msg.fen === "string") {
        const fen = msg.fen.trim();
        const depth = Number(msg.depth) || config.defaultDepth;
        const gen = ++evalGeneration;
        console.log(`[server] ← FEN (gen ${gen}): ${fen}`);

        // Abort any in-progress evaluation so Stockfish responds immediately
        const abortDone = engine.abort();

        // Queue the evaluation so requests are processed one at a time
        evaluationQueue = evaluationQueue
          .then(() => abortDone) // wait for abort to fully complete
          .then(async () => {
            // If a newer FEN arrived since we queued, skip this one
            if (gen !== evalGeneration) {
              console.log(`[server] skipping stale eval gen ${gen} (current: ${evalGeneration})`);
              return;
            }

            // Try opening book first
            const bookMove = await book.lookup(fen);
            if (bookMove) {
              if (gen !== evalGeneration) return;
              console.log(`[server] → bestmove (book): ${bookMove}`);
              if (ws.readyState === ws.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "bestmove",
                    bestmove: bookMove,
                    source: "book",
                    fen,
                  })
                );
              }
              return;
            }

            // Fall back to Stockfish
            const result = await engine.evaluate(fen, depth);
            // Check again after eval finishes — a newer FEN may have arrived
            if (gen !== evalGeneration) {
              console.log(`[server] discarding stale result gen ${gen}`);
              return;
            }
            console.log(`[server] → bestmove (engine): ${result.bestmove}`);
            if (ws.readyState === ws.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "bestmove",
                  bestmove: result.bestmove,
                  lines: result.lines,
                  source: "engine",
                  fen,
                })
              );
            }
          })
          .catch((err) => {
            console.error("[server] evaluation error:", err.message);
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "error", message: err.message }));
            }
          });
      }

      // ── Engine settings ────────────────────────────────
      if (msg.type === "set_option" && msg.name && msg.value !== undefined) {
        console.log(`[server] ← set_option: ${msg.name} = ${msg.value}`);
        engine.setOption(msg.name, msg.value);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "option_set", name: msg.name, value: msg.value }));
        }
      }

      if (msg.type === "get_settings") {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: "settings",
            settings: engine.getSettings(),
            activeEngine: path.basename(config.stockfishPath),
            activeBook: book.enabled ? path.basename(book.bookPath) : null,
            activeSyzygy: config.syzygyPath || null,
          }));
        }
      }

      // ── File listing ───────────────────────────────────
      if (msg.type === "list_files") {
        const engines = listEngines().map((e) => e.name);
        const books = listBooks().map((b) => b.name);
        const syzygy = listSyzygyDirs().map((s) => s.name);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: "files",
            engines,
            books,
            syzygy,
            activeEngine: path.basename(config.stockfishPath),
            activeBook: book.enabled ? path.basename(book.bookPath) : null,
            activeSyzygy: config.syzygyPath ? path.basename(config.syzygyPath) : null,
          }));
        }
      }

      // ── Switch engine ──────────────────────────────────
      if (msg.type === "switch_engine" && msg.name) {
        const found = listEngines().find((e) => e.name === msg.name);
        if (!found) {
          ws.send(JSON.stringify({ type: "error", message: `Engine not found: ${msg.name}` }));
          return;
        }
        console.log(`[server] switching engine to: ${found.name}`);
        try {
          engine.stop();
          config.stockfishPath = found.path;
          engine = new StockfishBridge();
          await engine.start();
          // Re-apply existing settings
          evalGeneration++;
          ws.send(JSON.stringify({ type: "engine_switched", name: found.name }));
        } catch (err) {
          console.error(`[server] failed to switch engine: ${err.message}`);
          ws.send(JSON.stringify({ type: "error", message: `Failed to start ${msg.name}: ${err.message}` }));
        }
      }

      // ── Switch opening book ────────────────────────────
      if (msg.type === "switch_book" && msg.name !== undefined) {
        try {
          await book.close();
          if (msg.name === "" || msg.name === null) {
            // Disable book
            book = new OpeningBook("");
            config.openingBookPath = "";
            console.log("[server] opening book disabled");
            ws.send(JSON.stringify({ type: "book_switched", name: null }));
          } else {
            const found = listBooks().find((b) => b.name === msg.name);
            if (!found) {
              ws.send(JSON.stringify({ type: "error", message: `Book not found: ${msg.name}` }));
              return;
            }
            config.openingBookPath = found.path;
            book = new OpeningBook(found.path);
            await book.init();
            console.log(`[server] switched book to: ${found.name}`);
            ws.send(JSON.stringify({ type: "book_switched", name: found.name }));
          }
        } catch (err) {
          console.error(`[server] failed to switch book: ${err.message}`);
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
      }

      // ── Switch Syzygy tablebases ───────────────────────
      if (msg.type === "switch_syzygy" && msg.name !== undefined) {
        if (msg.name === "" || msg.name === null) {
          config.syzygyPath = "";
          engine.setOption("SyzygyPath", "");
          console.log("[server] Syzygy tablebases disabled");
          ws.send(JSON.stringify({ type: "syzygy_switched", name: null }));
        } else {
          const found = listSyzygyDirs().find((s) => s.name === msg.name);
          if (!found) {
            ws.send(JSON.stringify({ type: "error", message: `Syzygy dir not found: ${msg.name}` }));
            return;
          }
          config.syzygyPath = found.path;
          engine.setOption("SyzygyPath", found.path);
          console.log(`[server] switched Syzygy to: ${found.path}`);
          ws.send(JSON.stringify({ type: "syzygy_switched", name: found.name }));
        }
      }
    });

    ws.on("close", () => {
      console.log(`[server] client disconnected (${remote})`);
    });
  });

  // ── 4. Graceful shutdown ───────────────────────────────
  function shutdown() {
    console.log("\n[server] shutting down…");
    engine.stop();
    book.close();
    wss.close(() => process.exit(0));
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
