const { WebSocketServer } = require("ws");
const StockfishBridge = require("./stockfishBridge");
const OpeningBook = require("./openingBook");
const config = require("./config");

async function main() {
  // ── 1. Start the Stockfish engine ──────────────────────
  const engine = new StockfishBridge();
  try {
    await engine.start();
  } catch (err) {
    console.error("[server] could not start Stockfish – exiting.", err.message);
    process.exit(1);
  }

  // ── 2. Load opening book (optional) ───────────────────
  const book = new OpeningBook(config.openingBookPath);
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

  // Generation counter — only the latest evaluation's result is sent
  let evalGeneration = 0;
  let evaluationQueue = Promise.resolve();

  wss.on("connection", (ws, req) => {
    const remote = req.socket.remoteAddress;
    console.log(`[server] client connected (${remote})`);

    ws.on("message", (data) => {
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
          ws.send(JSON.stringify({ type: "settings", settings: engine.getSettings() }));
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
