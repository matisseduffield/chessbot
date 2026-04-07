const { WebSocketServer } = require("ws");
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Chess } = require("chess.js");
const StockfishBridge = require("./stockfishBridge");
const OpeningBook = require("./openingBook");
const eco = require("./eco");
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
  // ── 0. Load ECO opening database ──────────────────────
  eco.loadEco(path.join(__dirname, "eco"));

  // ── Variant definitions ────────────────────────────────
  const VARIANTS = {
    chess:        { label: "Standard",        engine: "stockfish", uciVariant: null,           uci960: false },
    chess960:     { label: "Chess960",         engine: "stockfish", uciVariant: null,           uci960: true  },
    atomic:       { label: "Atomic",           engine: "fairy",     uciVariant: "atomic",       uci960: false },
    crazyhouse:   { label: "Crazyhouse",       engine: "fairy",     uciVariant: "crazyhouse",   uci960: false },
    kingofthehill:{ label: "King of the Hill", engine: "fairy",     uciVariant: "kingofthehill", uci960: false },
    "3check":     { label: "Three-check",      engine: "fairy",     uciVariant: "3check",       uci960: false },
    antichess:    { label: "Antichess",        engine: "fairy",     uciVariant: "antichess",    uci960: false },
    horde:        { label: "Horde",            engine: "fairy",     uciVariant: "horde",        uci960: false },
    racingkings:  { label: "Racing Kings",     engine: "fairy",     uciVariant: "racingkings",  uci960: false },
  };
  let currentVariant = "chess"; // active variant key
  let currentEngineType = "stockfish"; // "stockfish" | "fairy"
  const originalStockfishPath = config.stockfishPath; // preserve for switching back

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

  // ── 3. Start HTTP + WebSocket server ────────────────────

  /** Switch to a different variant, auto-switching engine if needed.
   *  Returns { switched: bool, error?: string } */
  async function switchVariant(variantKey) {
    const def = VARIANTS[variantKey];
    if (!def) return { switched: false, error: `Unknown variant: ${variantKey}` };

    // Abort any pending evaluation before switching
    await engine.abort();

    const needEngine = def.engine; // "stockfish" | "fairy"
    const needSwitch = needEngine !== currentEngineType;

    if (needSwitch) {
      const newPath = needEngine === "fairy"
        ? config.fairyStockfishPath
        : originalStockfishPath;
      if (!fs.existsSync(newPath)) {
        return { switched: false, error: `Engine binary not found: ${newPath}` };
      }
      console.log(`[server] variant ${variantKey} requires ${needEngine} engine — switching`);
      engine.stop();
      const oldPath = config.stockfishPath;
      config.stockfishPath = newPath;
      engine = new StockfishBridge();
      try {
        await engine.start();
      } catch (err) {
        // Rollback
        config.stockfishPath = oldPath;
        engine = new StockfishBridge();
        await engine.start();
        return { switched: false, error: `Failed to start ${needEngine}: ${err.message}` };
      }
      currentEngineType = needEngine;
    }

    // Set UCI options for the variant
    if (def.uciVariant) {
      engine.setOption("UCI_Variant", def.uciVariant);
    } else if (currentEngineType === "fairy") {
      // Reset to standard chess on fairy-stockfish
      engine.setOption("UCI_Variant", "chess");
    }
    engine.setOption("UCI_Chess960", def.uci960 ? "true" : "false");

    // Clear hash since transposition table is variant-specific
    engine.clearHash();

    currentVariant = variantKey;
    console.log(`[server] variant set to: ${def.label} (engine: ${currentEngineType})`);
    return { switched: true };
  }

  /** Convert UCI PV lines to SAN and add ECO classification. */
  function enrichLines(lines, fen) {
    // Skip SAN conversion for non-standard variants (chess.js doesn't support them)
    if (currentVariant !== "chess" && currentVariant !== "chess960") {
      return lines.map((line) => ({ ...line, san: line.pv || [], eco: null }));
    }
    try {
      const game = new Chess(fen);
      return lines.map((line) => {
        const g = new Chess(fen);
        const san = [];
        let firstEpd = null;
        for (const uci of line.pv) {
          try {
            const m = g.move(uci);
            if (m) {
              san.push(m.san);
              if (san.length === 1) firstEpd = g.fen().split(" ").slice(0, 4).join(" ");
            } else break;
          } catch { break; }
        }
        const opening = firstEpd ? eco.lookup(firstEpd) : null;
        return { ...line, san, eco: opening ? opening.name : null };
      });
    } catch {
      return lines;
    }
  }

  /** Look up ECO for the current FEN position. */
  function getEco(fen) {
    try {
      const epd = fen.split(" ").slice(0, 4).join(" ");
      return eco.lookup(epd);
    } catch { return null; }
  }

  const app = express();
  app.use(express.static(path.join(__dirname, "panel")));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[server] port ${config.port} is already in use. Kill the other process or set PORT env var.`);
    } else {
      console.error("[server] HTTP server error:", err.message);
    }
    engine.stop();
    book.close();
    process.exit(1);
  });

  server.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port} (HTTP + WS)`);
  });

  /** Broadcast a message to all OTHER connected clients (for panel sync). */
  function broadcast(senderWs, message) {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    for (const client of wss.clients) {
      if (client !== senderWs && client.readyState === 1 /* OPEN */) {
        client.send(data);
      }
    }
  }

  /** Safe send — catches errors from connections that close mid-send. */
  function safeSend(ws, data) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(typeof data === "string" ? data : JSON.stringify(data));
    } catch { /* connection already closing */ }
  }

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
        // Basic FEN validation (relaxed for variants like crazyhouse which append [] to board)
        const fenParts = fen.split(" ");
        const boardPart = fenParts[0].replace(/\[.*?\]/, ""); // strip crazyhouse pocket
        if (fenParts.length < 2 || boardPart.split("/").length !== 8) {
          console.warn(`[server] invalid FEN rejected: ${fen}`);
          safeSend(ws, { type: "error", message: "Invalid FEN" });
          return;
        }

        // If content script detected a variant, auto-switch
        if (msg.variant && VARIANTS[msg.variant] && msg.variant !== currentVariant) {
          console.log(`[server] content script detected variant: ${msg.variant}`);
          const result = await switchVariant(msg.variant);
          if (result.switched) {
            evalGeneration++;
            // Notify all clients of the variant change
            const variantMsg = { type: "variant_switched", variant: msg.variant, label: VARIANTS[msg.variant].label };
            safeSend(ws, variantMsg);
            broadcast(ws, variantMsg);
          }
        }

        const depth = Number(msg.depth) || config.defaultDepth;
        const searchOptions = {};
        if (msg.movetime) searchOptions.movetime = Number(msg.movetime);
        if (msg.nodes) searchOptions.nodes = Number(msg.nodes);
        const gen = ++evalGeneration;
        console.log(`[server] ← FEN (gen ${gen}): ${fen} [variant: ${currentVariant}]`);

        // Abort any in-progress evaluation so Stockfish responds immediately
        const abortDone = engine.abort();

        // Queue the evaluation so requests are processed one at a time
        evaluationQueue = evaluationQueue
          .then(() => abortDone) // wait for abort to fully complete
          .then(async () => {
            // If client disconnected, bail — prevents stale queue handlers
            // from racing with a new client's evaluations on the shared engine.
            if (ws.readyState !== ws.OPEN) return;

            // If a newer FEN arrived since we queued, skip this one
            if (gen !== evalGeneration) {
              console.log(`[server] skipping stale eval gen ${gen} (current: ${evalGeneration})`);
              return;
            }

            // Look up ECO for current position (standard chess only)
            const isStandard = currentVariant === "chess" || currentVariant === "chess960";
            const posEco = isStandard ? getEco(fen) : null;

            // Try opening book first (standard chess only)
            if (isStandard) {
              const bookMove = await book.lookup(fen);
              if (bookMove) {
                if (gen !== evalGeneration) return;
                console.log(`[server] → bestmove (book): ${bookMove}`);
                const bookMsg = {
                  type: "bestmove",
                  bestmove: bookMove,
                  source: "book",
                  fen,
                  variant: currentVariant,
                  eco: posEco ? posEco.name : null,
                  ecoCode: posEco ? posEco.code : null,
                };
                safeSend(ws, bookMsg);
                broadcast(ws, bookMsg);
                return;
              }
            }

            // Fall back to Stockfish
            const result = await engine.evaluate(fen, depth, searchOptions);
            // Check again after eval finishes — a newer FEN may have arrived
            if (gen !== evalGeneration) {
              console.log(`[server] discarding stale result gen ${gen}`);
              return;
            }
            const enrichedLines = enrichLines(result.lines || [], fen);
            console.log(`[server] → bestmove (engine): ${result.bestmove}`);
            const engineMsg = {
              type: "bestmove",
              bestmove: result.bestmove,
              lines: enrichedLines,
              source: "engine",
              fen,
              variant: currentVariant,
              eco: posEco ? posEco.name : null,
              ecoCode: posEco ? posEco.code : null,
            };
            safeSend(ws, engineMsg);
            broadcast(ws, engineMsg);
          })
          .catch((err) => {
            console.error("[server] evaluation error:", err.message);
            safeSend(ws, { type: "error", message: err.message });
          });
      }

      // ── Engine settings ────────────────────────────────
      if (msg.type === "set_option" && msg.name && msg.value !== undefined) {
        console.log(`[server] ← set_option: ${msg.name} = ${msg.value}`);
        if (msg.name === "depth") {
          config.defaultDepth = Number(msg.value) || 15;
        } else {
          engine.setOption(msg.name, msg.value);
        }
        safeSend(ws, { type: "option_set", name: msg.name, value: msg.value });
      }

      // ── Clear hash ─────────────────────────────────────
      if (msg.type === "clear_hash") {
        console.log("[server] ← clear_hash");
        engine.clearHash();
        safeSend(ws, { type: "hash_cleared" });
      }

      // ── Broadcast — relay a message from panel to all other clients ──
      if (msg.type === "broadcast" && msg.payload) {
        broadcast(ws, msg.payload);
      }

      if (msg.type === "get_settings") {
        safeSend(ws, {
          type: "settings",
          settings: engine.getSettings(),
          defaultDepth: config.defaultDepth,
          activeEngine: path.basename(config.stockfishPath),
          activeBook: book.enabled ? path.basename(book.bookPath) : null,
          activeSyzygy: config.syzygyPath || null,
          engines: listEngines().map((e) => e.name),
          books: listBooks().map((b) => b.name),
          syzygy: listSyzygyDirs().map((s) => s.name),
          variant: currentVariant,
          variants: Object.entries(VARIANTS).map(([key, v]) => ({ key, label: v.label })),
        });
      }

      // ── Switch variant ─────────────────────────────────
      if (msg.type === "switch_variant" && msg.variant) {
        console.log(`[server] ← switch_variant: ${msg.variant}`);
        const result = await switchVariant(msg.variant);
        if (result.switched) {
          evalGeneration++;
          const variantMsg = { type: "variant_switched", variant: currentVariant, label: VARIANTS[currentVariant].label };
          safeSend(ws, variantMsg);
          broadcast(ws, variantMsg);
        } else {
          safeSend(ws, { type: "error", message: result.error });
        }
      }

      // ── File listing ───────────────────────────────────
      if (msg.type === "list_files") {
        const engines = listEngines().map((e) => e.name);
        const books = listBooks().map((b) => b.name);
        const syzygy = listSyzygyDirs().map((s) => s.name);
        safeSend(ws, {
          type: "files",
          engines,
          books,
          syzygy,
          activeEngine: path.basename(config.stockfishPath),
          activeBook: book.enabled ? path.basename(book.bookPath) : null,
          activeSyzygy: config.syzygyPath ? path.basename(config.syzygyPath) : null,
        });
      }

      // ── Switch engine ──────────────────────────────────
      if (msg.type === "switch_engine" && msg.name) {
        const found = listEngines().find((e) => e.name === msg.name);
        if (!found) {
          safeSend(ws, { type: "error", message: `Engine not found: ${msg.name}` });
          return;
        }
        console.log(`[server] switching engine to: ${found.name}`);
        try {
          engine.stop();
          config.stockfishPath = found.path;
          engine = new StockfishBridge();
          await engine.start();
          // Detect engine type from binary name
          currentEngineType = found.name.toLowerCase().includes("fairy") ? "fairy" : "stockfish";
          // Re-apply variant UCI options if using fairy engine
          if (currentEngineType === "fairy" && VARIANTS[currentVariant] && VARIANTS[currentVariant].uciVariant) {
            engine.setOption("UCI_Variant", VARIANTS[currentVariant].uciVariant);
          }
          evalGeneration++;
          safeSend(ws, { type: "engine_switched", name: found.name });
        } catch (err) {
          console.error(`[server] failed to switch engine: ${err.message}`);
          safeSend(ws, { type: "error", message: `Failed to start ${msg.name}: ${err.message}` });
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
            safeSend(ws, { type: "book_switched", name: null });
          } else {
            const found = listBooks().find((b) => b.name === msg.name);
            if (!found) {
              safeSend(ws, { type: "error", message: `Book not found: ${msg.name}` });
              return;
            }
            config.openingBookPath = found.path;
            book = new OpeningBook(found.path);
            await book.init();
            console.log(`[server] switched book to: ${found.name}`);
            safeSend(ws, { type: "book_switched", name: found.name });
          }
        } catch (err) {
          console.error(`[server] failed to switch book: ${err.message}`);
          safeSend(ws, { type: "error", message: err.message });
        }
      }

      // ── Switch Syzygy tablebases ───────────────────────
      if (msg.type === "switch_syzygy" && msg.name !== undefined) {
        if (msg.name === "" || msg.name === null) {
          config.syzygyPath = "";
          engine.setOption("SyzygyPath", "");
          console.log("[server] Syzygy tablebases disabled");
          safeSend(ws, { type: "syzygy_switched", name: null });
        } else {
          const found = listSyzygyDirs().find((s) => s.name === msg.name);
          if (!found) {
            safeSend(ws, { type: "error", message: `Syzygy dir not found: ${msg.name}` });
            return;
          }
          config.syzygyPath = found.path;
          engine.setOption("SyzygyPath", found.path);
          console.log(`[server] switched Syzygy to: ${found.path}`);
          safeSend(ws, { type: "syzygy_switched", name: found.name });
        }
      }
    });

    ws.on("close", () => {
      console.log(`[server] client disconnected (${remote})`);
      evalGeneration++; // discard any in-flight evals for this client
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
