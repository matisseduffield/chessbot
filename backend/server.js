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
const {
  validateFen,
  injectThreeCheckCounters,
  toEpd,
  parseFen,
} = require("@chessbot/shared");
const { EvalCache } = require("./src/engine/evalCache");
const { LichessBook } = require("./src/book/lichess");
const { PROTOCOL_VERSION } = require("@chessbot/shared");
const { safeSend, broadcast: wsBroadcast } = require("./src/ws/send");
const { createRateLimiter } = require("./src/ws/rateLimit");
const serverLogger = require("./src/logger");
const { pickSearchLimits } = require("./src/engine/searchLimits");

// ── Server log buffer ────────────────────────────────────
serverLogger.install();

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

// ── Cached file listing (avoids repeated fs walks on every WS request) ──
const _fileCache = { engines: null, books: null, syzygy: null, ts: 0 };
const FILE_CACHE_TTL = 10_000; // 10 seconds

function getCachedFiles() {
  const now = Date.now();
  if (_fileCache.ts && now - _fileCache.ts < FILE_CACHE_TTL) return _fileCache;
  _fileCache.engines = listEngines();
  _fileCache.books = listBooks();
  _fileCache.syzygy = listSyzygyDirs();
  _fileCache.ts = now;
  return _fileCache;
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

// ── Evaluation cache ─────────────────────────────────────
const _evalCache = new EvalCache({ ttlMs: 5 * 60 * 1000, max: 500 });

function getCachedEval(fen, variant, depth, multiPV) {
  return _evalCache.get(fen, variant, depth, multiPV);
}

function setCachedEval(fen, variant, depth, multiPV, result) {
  _evalCache.set(fen, variant, depth, multiPV, result);
}

// Periodically purge expired cache entries to prevent memory buildup
setInterval(() => _evalCache.purgeExpired(), 60_000);

async function main() {
  // ── 0. Load ECO opening database ──────────────────────
  eco.loadEco(path.join(__dirname, "eco"));

  // ── Variant definitions ────────────────────────────────
  // category: "standard" | "popular" | "chess" | "regional" | "shogi" | "mini" | "other"
  const f = (label, uci, cat) => ({ label, engine: "fairy", uciVariant: uci, uci960: false, category: cat });
  const VARIANTS = {
    // Standard engines
    chess:            { label: "Standard",           engine: "stockfish", uciVariant: null,  uci960: false, category: "standard" },
    chess960:         { label: "Chess960",            engine: "stockfish", uciVariant: null,  uci960: true,  category: "standard" },
    // Popular lichess/chess.com variants
    atomic:           f("Atomic",                    "atomic",           "popular"),
    crazyhouse:       f("Crazyhouse",                "crazyhouse",       "popular"),
    kingofthehill:    f("King of the Hill",          "kingofthehill",    "popular"),
    "3check":         f("Three-check",               "3check",           "popular"),
    antichess:        f("Antichess",                 "antichess",        "popular"),
    horde:            f("Horde",                     "horde",            "popular"),
    racingkings:      f("Racing Kings",              "racingkings",      "popular"),
    // Chess variants
    "5check":         f("Five-check",                "5check",           "chess"),
    almost:           f("Almost Chess",              "almost",           "chess"),
    amazon:           f("Amazon Chess",              "amazon",           "chess"),
    armageddon:       f("Armageddon",               "armageddon",       "chess"),
    bughouse:         f("Bughouse",                  "bughouse",         "chess"),
    chessgi:          f("Chessgi",                   "chessgi",          "chess"),
    chigorin:         f("Chigorin",                  "chigorin",         "chess"),
    codrus:           f("Codrus",                    "codrus",           "chess"),
    coregal:          f("Coregal",                   "coregal",          "chess"),
    extinction:       f("Extinction",                "extinction",       "chess"),
    fischerandom:     f("Fischer Random",            "fischerandom",     "chess"),
    giveaway:         f("Giveaway",                  "giveaway",         "chess"),
    grasshopper:      f("Grasshopper Chess",         "grasshopper",      "chess"),
    hoppelpoppel:     f("Hoppel-Poppel",             "hoppelpoppel",     "chess"),
    kinglet:          f("Kinglet",                   "kinglet",          "chess"),
    knightmate:       f("Knightmate",                "knightmate",       "chess"),
    koedem:           f("Koedem",                    "koedem",           "chess"),
    loop:             f("Loop Chess",                "loop",             "chess"),
    losers:           f("Losers",                    "losers",           "chess"),
    newzealand:       f("New Zealand",               "newzealand",       "chess"),
    nightrider:       f("Nightrider Chess",          "nightrider",       "chess"),
    nocastle:         f("No Castling",               "nocastle",         "chess"),
    nocheckatomic:    f("Atomic (No Check)",         "nocheckatomic",    "chess"),
    placement:        f("Placement Chess",           "placement",        "chess"),
    pocketknight:     f("Pocket Knight",             "pocketknight",     "chess"),
    seirawan:         f("Seirawan (S-Chess)",        "seirawan",         "chess"),
    shouse:           f("S-House",                   "shouse",           "chess"),
    suicide:          f("Suicide Chess",             "suicide",          "chess"),
    threekings:       f("Three Kings",               "threekings",       "chess"),
    // Regional / historical
    "ai-wok":         f("Ai-Wok",                    "ai-wok",           "regional"),
    asean:            f("ASEAN Chess",               "asean",            "regional"),
    cambodian:        f("Cambodian Chess",           "cambodian",        "regional"),
    chaturanga:       f("Chaturanga",                "chaturanga",       "regional"),
    karouk:           f("Kar Ouk",                   "karouk",           "regional"),
    makpong:          f("Makpong",                   "makpong",          "regional"),
    makruk:           f("Makruk",                    "makruk",           "regional"),
    shatar:           f("Shatar",                    "shatar",           "regional"),
    shatranj:         f("Shatranj",                  "shatranj",         "regional"),
    sittuyin:         f("Sittuyin",                  "sittuyin",         "regional"),
    // Shogi variants
    dobutsu:          f("Dobutsu Shogi",             "dobutsu",          "shogi"),
    euroshogi:        f("EuroShogi",                 "euroshogi",        "shogi"),
    gorogoro:         f("Goro Goro Shogi",           "gorogoro",         "shogi"),
    judkins:          f("Judkins Shogi",             "judkins",          "shogi"),
    kyotoshogi:       f("Kyoto Shogi",               "kyotoshogi",       "shogi"),
    minishogi:        f("Minishogi",                 "minishogi",        "shogi"),
    torishogi:        f("Tori Shogi",                "torishogi",        "shogi"),
    // Mini games
    gardner:          f("Gardner's Minichess",       "gardner",          "mini"),
    losalamos:        f("Los Alamos Chess",          "losalamos",        "mini"),
    micro:            f("Micro Chess",               "micro",            "mini"),
    mini:             f("Mini Chess",                "mini",             "mini"),
    minixiangqi:      f("Mini Xiangqi",              "minixiangqi",      "mini"),
    // Other games
    ataxx:            f("Ataxx",                     "ataxx",            "other"),
    breakthrough:     f("Breakthrough",              "breakthrough",     "other"),
    clobber:          f("Clobber",                   "clobber",          "other"),
  };
  let currentVariant = "chess"; // active variant key
  let currentEngineType = "stockfish"; // "stockfish" | "fairy"
  const originalStockfishPath = config.stockfishPath; // preserve for switching back

  // Global variant generation — incremented on each variant switch to invalidate all pending evals
  let globalVariantGen = 0;

  // Global evaluation mutex — ensures only one eval accesses the engine at a time.
  // Per-client queues still exist for ordering, but this prevents cross-client interleave.
  let globalEvalLock = Promise.resolve();
  function acquireEvalLock() {
    let release;
    const prev = globalEvalLock;
    globalEvalLock = new Promise(r => { release = r; });
    return prev.then(() => release);
  }

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
  const lichessBook = new LichessBook({ maxConcurrent: 2, timeoutMs: 5000 });

  /** Query Lichess opening explorer for a FEN.
   *  Returns best UCI move string or null. */
  function lichessLookup(fen) {
    return lichessBook.lookup(fen);
  }

  // ── 3. Start HTTP + WebSocket server ────────────────────

  /** Switch to a different variant, auto-switching engine if needed.
   *  Returns { switched: bool, error?: string } */
  let engineSwitchLock = false; // prevents concurrent engine swaps
  let engineSwitchPromise = null; // resolves when current switch completes

  async function switchVariant(variantKey) {
    const def = VARIANTS[variantKey];
    if (!def) return { switched: false, error: `Unknown variant: ${variantKey}` };

    // Invalidate all pending evals from all clients before switching
    globalVariantGen++;

    // Set variant immediately so concurrent switch_engine messages see the new variant
    const previousVariant = currentVariant;
    currentVariant = variantKey;

    // Acquire lock to prevent concurrent engine operations
    engineSwitchLock = true;
    let resolveSwitchPromise;
    engineSwitchPromise = new Promise(r => { resolveSwitchPromise = r; });

    try {
      // Abort any pending evaluation before switching
      await engine.abort();

      const needEngine = def.engine; // "stockfish" | "fairy"
      const needSwitch = needEngine !== currentEngineType;

      if (needSwitch) {
        const newPath = needEngine === "fairy"
          ? config.fairyStockfishPath
          : originalStockfishPath;
        if (!fs.existsSync(newPath)) {
          currentVariant = previousVariant; // rollback
          return { switched: false, error: `Engine binary not found: ${newPath}` };
        }
        console.log(`[server] variant ${variantKey} requires ${needEngine} engine — switching`);
        // Preserve user settings (Threads, Hash, MultiPV, etc.) across engine switch
        const savedSettings = engine.getSettings();
        engine.stop();
        const oldPath = config.stockfishPath;
        config.stockfishPath = newPath;
        engine = new StockfishBridge();
        try {
          await engine.start();
        } catch (err) {
          // Rollback
          currentVariant = previousVariant;
          config.stockfishPath = oldPath;
          engine = new StockfishBridge();
          await engine.start();
          return { switched: false, error: `Failed to start ${needEngine}: ${err.message}` };
        }
        // Re-apply preserved settings to new engine
        for (const [k, v] of Object.entries(savedSettings)) {
          if (k !== "UCI_Variant" && k !== "UCI_Chess960" && k !== "SyzygyPath") {
            engine.setOption(k, v);
          }
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

      // Syzygy tablebases only apply to standard chess
      const isStandard = variantKey === "chess" || variantKey === "chess960";
      if (!isStandard) {
        engine.setOption("SyzygyPath", "");
        console.log("[server] Syzygy disabled for variant game");
      } else if (config.syzygyPath) {
        engine.setOption("SyzygyPath", config.syzygyPath);
        console.log(`[server] Syzygy restored: ${config.syzygyPath}`);
      }

      console.log(`[server] variant set to: ${def.label} (engine: ${currentEngineType})`);
      return { switched: true };
    } finally {
      engineSwitchLock = false;
      resolveSwitchPromise();
      engineSwitchPromise = null;
    }
  }

  /** Convert UCI PV lines to SAN and add ECO classification. */
  function enrichLines(lines, fen) {
    // Skip SAN conversion for non-standard variants (chess.js doesn't support them)
    if (currentVariant !== "chess" && currentVariant !== "chess960") {
      return lines.map((line) => ({ ...line, san: line.pv || [], eco: null }));
    }
    try {
      return lines.map((line) => {
        const g = new Chess(fen);
        const san = [];
        let firstEpd = null;
        for (const uci of line.pv) {
          try {
            const m = g.move(uci);
            if (m) {
              san.push(m.san);
              if (san.length === 1) firstEpd = toEpd(g.fen());
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
      return eco.lookup(toEpd(fen));
    } catch { return null; }
  }

  const app = express();

  // ── CORS / Private Network Access ──────────────────────
  // Chrome requires a preflight response with Access-Control-Allow-Private-Network
  // before allowing WebSocket connections from HTTPS pages to localhost.
  const ALLOWED_ORIGINS = new Set([
    `http://localhost:${config.port}`,
    "https://www.chess.com",
    "https://lichess.org",
    "https://playstrategy.org",
    "https://chesstempo.com",
  ]);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    next();
  });

  // ── Health endpoint ────────────────────────────────────
  // Liveness + light diagnostics for CI, uptime probes, and the panel
  // self-test button. Always returns 200 so network layers can distinguish
  // "backend down" from "engine not ready"; inspect the body for details.
  const startedAt = Date.now();
  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      uptimeMs: Date.now() - startedAt,
      version: require("./package.json").version,
      engine: {
        ready: !!(engine && engine.ready),
        type: currentEngineType,
        variant: currentVariant,
      },
      book: {
        ecoOpenings: eco.size ? eco.size() : 0,
        lichessEnabled: !!(lichessBook && lichessBook.enabled),
        offlineBook: book.enabled ? path.basename(book.bookPath) : null,
      },
      clients: wss ? wss.clients.size : 0,
    });
  });

  // ── Self-check: run a short canned evaluation ─────────────
  // Returns depth reached + time elapsed so ops can verify the engine
  // pipeline end-to-end. Refuses while another search is active so we
  // don't poison the user's current analysis. Plan §10.
  let selfcheckBusy = false;
  app.get("/selfcheck", async (_req, res) => {
    if (!engine || !engine.ready) {
      return res.status(503).json({ status: "engine_not_ready" });
    }
    if (selfcheckBusy) {
      return res.status(503).json({ status: "busy" });
    }
    selfcheckBusy = true;
    const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const t0 = Date.now();
    try {
      const result = await engine.evaluate(startFen, 8, { movetime: 1500 });
      res.json({
        status: "ok",
        elapsedMs: Date.now() - t0,
        depthReached: result.depth || 0,
        bestMove: result.bestmove || result.bestMove || null,
        score: result.score ?? null,
        engineType: currentEngineType,
      });
    } catch (err) {
      res.status(500).json({ status: "error", error: String(err && err.message || err) });
    } finally {
      selfcheckBusy = false;
    }
  });

  app.use(express.static(path.join(__dirname, "panel")));
  const server = http.createServer(app);

  // Handle PNA preflight at the raw HTTP level (before ws upgrade intercepts)
  server.on("upgrade", (req, socket, head) => {
    // Log all upgrade attempts for debugging
    console.log(`[server] WS upgrade from origin=${req.headers.origin || "none"} ip=${req.socket.remoteAddress}`);
  });

  const wss = new WebSocketServer({
    server,
    // Accept connections from any origin
    verifyClient: (info) => {
      console.log(`[server] WS verifyClient origin=${info.origin || "none"} secure=${info.secure}`);
      return true;
    },
  });

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
    return wsBroadcast(wss, senderWs, message);
  }

  // safeSend is imported from src/ws/send; it no-ops on closed sockets
  // and stringifies objects on the fly.

  wss.on("connection", (ws, req) => {
    const remote = req.socket.remoteAddress;
    console.log(`[server] client connected (${remote})`);

    // Protocol hello: lets the panel/extension detect version mismatches
    // (see improvement-plan §7.4). Best-effort; older clients ignore it.
    safeSend(ws, {
      type: "server_hello",
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: require("./package.json").version,
      engine: { name: "stockfish" },
    });

    // Per-connection rate limit (improvement-plan §11). See
    // backend/src/ws/rateLimit.js for the algorithm + tests.
    const rateLimiter = createRateLimiter({ max: 300, windowMs: 10_000 });

    // Send current depth setting so newly-connected clients sync immediately
    if (config.defaultDepth !== undefined) {
      safeSend(ws, { type: "set_depth", value: config.defaultDepth });
    }
    // Send current search limits
    if (config.searchMovetime || config.searchNodes) {
      safeSend(ws, { type: "set_search_limits", movetime: config.searchMovetime, nodes: config.searchNodes });
    }

    // Per-client generation counter — prevents cross-client eval interference
    let evalGeneration = 0;
    let evaluationQueue = Promise.resolve();

    ws.on("message", async (data) => {
      const gate = rateLimiter.hit();
      if (!gate.ok) {
        if (gate.firstHit) {
          safeSend(ws, {
            type: "error",
            code: "rate_limited",
            message: "Too many messages (max 300 per 10s).",
          });
        }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        console.warn("[server] received non-JSON message, ignoring");
        return;
      }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
        safeSend(ws, { type: "error", code: "bad_frame", message: "Frames must be JSON objects with a string `type`." });
        return;
      }

      if (msg.type === "fen" && typeof msg.fen === "string") {
        let fen = msg.fen.trim();
        // Basic FEN validation (relaxed for variants like crazyhouse which append [] to board)
        const validation = validateFen(fen);
        if (!validation.valid) {
          console.warn(`[server] invalid FEN rejected (${validation.reason}): ${fen}`);
          safeSend(ws, { type: "error", code: "invalid_fen", message: "Invalid FEN" });
          return;
        }

        // Safety net: ensure 3check FEN has check counters
        // fairy-stockfish misparses standard FEN (reads halfmove as counter → 1+1)
        if (msg.variant === "3check" || currentVariant === "3check") {
          const injected = injectThreeCheckCounters(fen);
          if (injected !== fen) {
            fen = injected;
            console.log(`[server] injected default 3check counters into FEN`);
          }
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

        const { depth, options: searchOptions } = pickSearchLimits(msg, config);
        const gen = ++evalGeneration;
        const variantGen = globalVariantGen; // snapshot for staleness check
        const evalVariant = currentVariant; // snapshot variant for this eval (prevents stale reads)
        console.log(`[server] ← FEN (gen ${gen}): ${fen} [variant: ${evalVariant}]`);

        // Queue the evaluation so requests are processed one at a time.
        // acquireEvalLock() serializes access to the shared engine across all clients.
        evaluationQueue = evaluationQueue
          .then(async () => {
            // If client disconnected, bail — prevents stale queue handlers
            // from racing with a new client's evaluations on the shared engine.
            if (ws.readyState !== ws.OPEN) return;

            // Abort any in-progress evaluation now that we own the queue slot
            await engine.abort();

            // If an engine/variant switch is in progress, wait for it
            if (engineSwitchPromise) {
              console.log(`[server] eval gen ${gen} waiting for engine switch to complete...`);
              await engineSwitchPromise;
            }

            // If a newer FEN arrived or variant switched since we queued, skip this one
            if (gen !== evalGeneration || variantGen !== globalVariantGen) {
              console.log(`[server] skipping stale eval gen ${gen} (current: ${evalGeneration}, variantGen: ${variantGen}→${globalVariantGen})`);
              return;
            }

            // Look up ECO for current position (standard chess only)
            const isStandard = evalVariant === "chess" || evalVariant === "chess960";
            const posEco = isStandard ? getEco(fen) : null;

            // Try opening book first (standard chess only, skip for deep positions)
            const moveNumber = parseFen(fen)?.fullmove ?? 1;
            if (isStandard && moveNumber <= 15) {
              const bookMove = await book.lookup(fen);
              if (bookMove) {
                if (gen !== evalGeneration) return;
                console.log(`[server] → bestmove (book): ${bookMove}`);
                const bookMsg = {
                  type: "bestmove",
                  bestmove: bookMove,
                  source: "book",
                  fen,
                  variant: evalVariant,
                  eco: posEco ? posEco.name : null,
                  ecoCode: posEco ? posEco.code : null,
                };
                safeSend(ws, bookMsg);
                broadcast(ws, bookMsg);
                return;
              }

              // Try Lichess opening explorer as fallback
              const lichessMove = await lichessLookup(fen);
              if (lichessMove) {
                if (gen !== evalGeneration) return;
                console.log(`[server] → bestmove (lichess): ${lichessMove}`);
                const lichessMsg = {
                  type: "bestmove",
                  bestmove: lichessMove,
                  source: "lichess",
                  fen,
                  variant: evalVariant,
                  eco: posEco ? posEco.name : null,
                  ecoCode: posEco ? posEco.code : null,
                };
                safeSend(ws, lichessMsg);
                broadcast(ws, lichessMsg);
                return;
              }
            }

            // Fall back to Stockfish — check eval cache first (skip for infinite analysis)
            const multiPV = Number(engine.getSettings().MultiPV) || 1;
            if (depth > 0) {
              const cached = getCachedEval(fen, evalVariant, depth, multiPV);
              if (cached) {
                console.log(`[server] → bestmove (cache): ${cached.bestmove}`);
                const cacheMsg = {
                  type: "bestmove",
                  bestmove: cached.bestmove,
                  lines: cached.lines,
                  source: "engine",
                  fen,
                  variant: evalVariant,
                  eco: posEco ? posEco.name : null,
                  ecoCode: posEco ? posEco.code : null,
                  tablebase: cached.tablebase,
                  cached: true,
                };
                safeSend(ws, cacheMsg);
                broadcast(ws, cacheMsg);
                return;
              }
            }

            // Acquire global lock to prevent cross-client interleave
            const releaseEval = await acquireEvalLock();
            try {
              if (gen !== evalGeneration || ws.readyState !== ws.OPEN) return;

              // Send engine progress updates to panel
              let _lastProgressDepth = 0;
              searchOptions.onInfo = (info) => {
                if (gen !== evalGeneration || ws.readyState !== ws.OPEN) return;
                const d = info.depth || 0;
                // For infinite analysis, send full intermediate results
                if (depth === 0) {
                  const enrichedLines = enrichLines(info.lines || [], fen);
                  const infoMsg = {
                    type: "bestmove",
                    bestmove: info.bestmove,
                    lines: enrichedLines,
                    source: "engine",
                    depth: d,
                    fen,
                    variant: evalVariant,
                    eco: posEco ? posEco.name : null,
                    ecoCode: posEco ? posEco.code : null,
                    streaming: true,
                  };
                  safeSend(ws, infoMsg);
                  broadcast(ws, infoMsg);
                } else if (d > _lastProgressDepth) {
                  // For fixed-depth analysis, send lightweight progress
                  _lastProgressDepth = d;
                  const first = (info.lines && info.lines[0]) || {};
                  const progressMsg = {
                    type: "eval_progress",
                    depth: d,
                    targetDepth: depth,
                    nodes: first.nodes || null,
                    nps: first.nps || null,
                    fen,
                  };
                  safeSend(ws, progressMsg);
                  broadcast(ws, progressMsg);
                }
              };

              // For infinite analysis (depth=0), stream intermediate results.
              // Only set infinite if there's no movetime/nodes limit.
              if (depth === 0 && !searchOptions.movetime && !searchOptions.nodes) {
                searchOptions.infinite = true;
              }
              const result = await engine.evaluate(fen, depth, searchOptions);
              // Check again after eval finishes — a newer FEN may have arrived
              if (gen !== evalGeneration) {
                console.log(`[server] discarding stale result gen ${gen}`);
                return;
              }
              const enrichedLines = enrichLines(result.lines || [], fen);
              console.log(`[server] → bestmove (engine): ${result.bestmove}`);

              // Endgame tablebase classification
              let tbResult = null;
              if (config.syzygyPath && isStandard) {
                const pieceCount = fen.split(" ")[0].replace(/[^a-zA-Z]/g, "").length;
                if (pieceCount <= 7 && result.lines && result.lines[0]) {
                  const line = result.lines[0];
                  const score = line.score;
                  const mate = line.mate;
                  if (mate !== undefined && mate !== null) {
                    tbResult = mate > 0 ? "win" : "loss";
                  } else if (score !== undefined && score !== null) {
                    if (Math.abs(score) >= 9000) tbResult = score > 0 ? "win" : "loss";
                    else if (Math.abs(score) <= 5) tbResult = "draw";
                    else tbResult = score > 0 ? "win" : "loss";
                  }
                }
              }

              const engineMsg = {
                type: "bestmove",
                bestmove: result.bestmove,
                ponder: result.ponder || null,
                lines: enrichedLines,
                source: "engine",
                fen,
                variant: evalVariant,
                eco: posEco ? posEco.name : null,
                ecoCode: posEco ? posEco.code : null,
                tablebase: tbResult,
              };
              // Cache the result for future lookups (skip infinite analysis)
              if (depth > 0 && result.bestmove) {
                setCachedEval(fen, evalVariant, depth, multiPV, {
                  bestmove: result.bestmove,
                  ponder: result.ponder || null,
                  lines: enrichedLines,
                  tablebase: tbResult,
                });
              }
              safeSend(ws, engineMsg);
              broadcast(ws, engineMsg);
            } finally {
              releaseEval();
            }
          })
          .catch((err) => {
            console.error("[server] evaluation error:", err.message);
            safeSend(ws, { type: "error", code: "engine_error", message: err.message });
          });
      }

      // ── Engine settings ────────────────────────────────
      if (msg.type === "set_option" && msg.name && msg.value !== undefined) {
        console.log(`[server] ← set_option: ${msg.name} = ${msg.value}`);
        if (msg.name === "depth") {
          const d = Number(msg.value);
          // Depth 0 = infinite analysis, otherwise clamp 1–50
          config.defaultDepth = d === 0 ? 0 : Math.min(50, Math.max(1, d || 15));
        } else {
          engine.setOption(msg.name, msg.value);
        }
        // Clear eval cache when settings that affect results change
        if (["depth", "MultiPV", "Skill Level"].includes(msg.name)) {
          _evalCache.clear();
          console.log(`[server] eval cache cleared (${msg.name} changed)`);
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
      // ── Game info relay (player names, clocks) ────────
      if (msg.type === "game_info") {
        broadcast(ws, msg);
      }

      if (msg.type === "broadcast" && msg.payload) {
        // Store search limits server-side so they're authoritative
        if (msg.payload.type === "set_search_limits") {
          const mt = Number(msg.payload.movetime);
          const nd = Number(msg.payload.nodes);
          config.searchMovetime = (mt > 0 && isFinite(mt)) ? mt : null;
          config.searchNodes = (nd > 0 && isFinite(nd)) ? nd : null;
          console.log(`[server] search limits: movetime=${config.searchMovetime} nodes=${config.searchNodes}`);
        }
        broadcast(ws, msg.payload);
      }

      // ── Lichess opening explorer toggle ────────────────
      if (msg.type === "set_lichess_book") {
        lichessBook.setEnabled(!!msg.value);
        console.log(`[server] Lichess opening book: ${lichessBook.enabled ? "enabled" : "disabled"}`);
      }

      if (msg.type === "get_settings") {
        safeSend(ws, {
          type: "settings",
          settings: engine.getSettings(),
          defaultDepth: config.defaultDepth,
          activeEngine: path.basename(config.stockfishPath),
          activeBook: book.enabled ? path.basename(book.bookPath) : null,
          activeSyzygy: config.syzygyPath || null,
          lichessBook: lichessBook.enabled,
          engines: getCachedFiles().engines.map((e) => e.name),
          books: getCachedFiles().books.map((b) => b.name),
          syzygy: getCachedFiles().syzygy.map((s) => s.name),
          variant: currentVariant,
          variants: Object.entries(VARIANTS).map(([key, v]) => ({ key, label: v.label })),
        });
      }

      // ── Switch variant ─────────────────────────────────
      // ── Server logs ────────────────────────────────────
      if (msg.type === "get_server_logs") {
        const header = [
          "=== SERVER DIAGNOSTIC INFO ===",
          `Timestamp: ${new Date().toISOString()}`,
          `Engine: ${path.basename(config.stockfishPath)} (${currentEngineType})`,
          `Variant: ${currentVariant} (${VARIANTS[currentVariant]?.label || "unknown"})`,
          `Book: ${book.enabled ? path.basename(book.bookPath) : "disabled"}`,
          `Syzygy: ${config.syzygyPath || "disabled"}`,
          `Clients: ${wss.clients.size}`,
          `Engine ready: ${engine.ready || false}`,
          `Settings: ${JSON.stringify(engine.getSettings())}`,
          "=== SERVER LOGS ===",
        ].join("\n");
        safeSend(ws, { type: "server_logs", logs: header + "\n" + serverLogger.getBuffer().join("\n") });
      }

      if (msg.type === "switch_variant" && msg.variant) {
        console.log(`[server] ← switch_variant: ${msg.variant}`);
        const result = await switchVariant(msg.variant);
        if (result.switched) {
          evalGeneration++;
          const variantMsg = { type: "variant_switched", variant: currentVariant, label: VARIANTS[currentVariant].label, activeEngine: path.basename(config.stockfishPath) };
          safeSend(ws, variantMsg);
          broadcast(ws, variantMsg);
        } else {
          safeSend(ws, { type: "error", code: "variant_unsupported", message: result.error });
        }
      }

      // ── File listing ───────────────────────────────────
      if (msg.type === "list_files") {
        const cached = getCachedFiles();
        const engines = cached.engines.map((e) => e.name);
        const books = cached.books.map((b) => b.name);
        const syzygy = cached.syzygy.map((s) => s.name);
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
        if (engineSwitchLock) {
          console.log(`[server] ignoring switch_engine to ${msg.name} — engine switch in progress`);
          safeSend(ws, { type: "engine_switched", name: path.basename(config.stockfishPath) });
          return;
        }
        const found = getCachedFiles().engines.find((e) => e.name === msg.name);
        if (!found) {
          safeSend(ws, { type: "error", code: "resource_missing", message: `Engine not found: ${msg.name}` });
          return;
        }
        // Guard: if the active variant requires a specific engine type, block incompatible switches
        const requiredType = VARIANTS[currentVariant]?.engine || "stockfish";
        const requestedType = found.name.toLowerCase().includes("fairy") ? "fairy" : "stockfish";
        if (requiredType !== requestedType) {
          console.log(`[server] ignoring switch_engine to ${found.name} — variant ${currentVariant} requires ${requiredType} engine`);
          safeSend(ws, { type: "engine_switched", name: path.basename(config.stockfishPath) });
          return;
        }
        // Skip if the requested engine is already active (avoid unnecessary restart)
        if (path.resolve(found.path) === path.resolve(config.stockfishPath)) {
          console.log(`[server] switch_engine: ${found.name} already active — skipping`);
          safeSend(ws, { type: "engine_switched", name: found.name });
          return;
        }
        console.log(`[server] switching engine to: ${found.name}`);
        const prevPath = config.stockfishPath;
        const prevType = currentEngineType;
        engineSwitchLock = true;
        try {
          // Preserve user settings across engine switch
          const savedSettings = engine.getSettings();
          engine.stop();
          config.stockfishPath = found.path;
          engine = new StockfishBridge();
          await engine.start();
          // Re-apply preserved settings to new engine
          for (const [k, v] of Object.entries(savedSettings)) {
            if (k !== "UCI_Variant" && k !== "UCI_Chess960" && k !== "SyzygyPath") {
              engine.setOption(k, v);
            }
          }
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
          // Rollback: restore previous engine
          config.stockfishPath = prevPath;
          currentEngineType = prevType;
          try {
            engine = new StockfishBridge();
            await engine.start();
            console.log("[server] rolled back to previous engine successfully");
          } catch (rollbackErr) {
            console.error("[server] CRITICAL: rollback also failed:", rollbackErr.message);
          }
          safeSend(ws, { type: "error", code: "switch_failed", message: `Failed to start ${msg.name}: ${err.message}` });
        } finally {
          engineSwitchLock = false;
        }
      }

      // ── Switch opening book (supports multiple books) ──
      if (msg.type === "switch_book" && msg.name !== undefined) {
        try {
          await book.close();
          // Accept single name (string) or array of names
          const names = Array.isArray(msg.name) ? msg.name : [msg.name];
          const validNames = names.filter(n => n && n !== "");
          if (validNames.length === 0) {
            // Disable book
            book = new OpeningBook([]);
            config.openingBookPath = "";
            console.log("[server] opening book disabled");
            safeSend(ws, { type: "book_switched", name: null });
          } else {
            const allBooks = getCachedFiles().books;
            const paths = [];
            const resolvedNames = [];
            for (const name of validNames) {
              const found = allBooks.find((b) => b.name === name);
              if (found) {
                paths.push(found.path);
                resolvedNames.push(found.name);
              }
            }
            if (paths.length === 0) {
              safeSend(ws, { type: "error", code: "resource_missing", message: `No valid books found` });
              return;
            }
            config.openingBookPath = paths[0];
            book = new OpeningBook(paths);
            await book.init();
            console.log(`[server] switched book to: ${resolvedNames.join(", ")}`);
            safeSend(ws, { type: "book_switched", name: resolvedNames.length === 1 ? resolvedNames[0] : resolvedNames });
          }
        } catch (err) {
          console.error(`[server] failed to switch book: ${err.message}`);
          safeSend(ws, { type: "error", code: "switch_failed", message: err.message });
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
          const found = getCachedFiles().syzygy.find((s) => s.name === msg.name);
          if (!found) {
            safeSend(ws, { type: "error", code: "resource_missing", message: `Syzygy dir not found: ${msg.name}` });
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
      rateLimiter.stop();
      evalGeneration++; // discard any in-flight evals for this client
    });

    ws.on("error", (err) => {
      console.error(`[server] WebSocket error (${remote}):`, err.message);
    });
  });

  // ── 4. Graceful shutdown ───────────────────────────────
  function shutdown() {
    console.log("\n[server] shutting down…");
    engine.stop();
    book.close();
    wss.close(() => process.exit(0));
    // Force exit after 5s if graceful close hangs
    setTimeout(() => {
      console.error("[server] shutdown timeout — forcing exit");
      process.exit(1);
    }, 5000).unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
