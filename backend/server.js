const { WebSocketServer } = require("ws");
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
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
const { validateInbound } = require("./src/ws/validateMessage");
const { computeSafeMovetime } = require("./src/engine/clockCap");
const { parseClockText } = require("@chessbot/shared");
const serverLogger = require("./src/logger");
const { pickSearchLimits } = require("./src/engine/searchLimits");
const { createPinAuth } = require("./src/auth/pin");
const { FileCache } = require("./src/server/fileCache");
const { registerHttpRoutes } = require("./src/server/httpRoutes");
const { createEvalPipeline } = require("./src/server/evalPipeline");

// ── Server log buffer ────────────────────────────────────
serverLogger.install();

// ── File scanner ─────────────────────────────────────────
// Background-refreshed snapshot of engines/books/syzygy directories.
// See backend/src/server/fileCache.js for the implementation.
const _fileCache = new FileCache({
  engineDir: config.engineDir,
  booksDir: config.booksDir,
  syzygyDir: config.syzygyDir,
});

/**
 * Caller-friendly: returns the latest cached snapshot synchronously.
 * The cache is refreshed by a background poller (started in main()),
 * so no request handler ever blocks the event loop on a fs walk.
 */
function getCachedFiles() {
  return _fileCache.get();
}

// ── Evaluation cache ─────────────────────────────────────
const _evalCache = new EvalCache({ ttlMs: 5 * 60 * 1000, max: 500 });

// Persist across restarts (plan §4.5). File lives in user-writable app data.
const _evalCachePath = path.join(
  process.env.CHESSBOT_DATA_DIR || path.join(os.homedir(), '.chessbot'),
  'eval-cache.json',
);
try {
  const loaded = _evalCache.loadFromDisk(_evalCachePath);
  if (loaded > 0) console.log(`[server] loaded ${loaded} eval cache entries from ${_evalCachePath}`);
} catch (err) {
  console.warn("[server] failed to load eval cache:", err.message);
}

function getCachedEval(fen, variant, depth, multiPV) {
  return _evalCache.get(fen, variant, depth, multiPV);
}

/**
 * Like getCachedEval but accepts any cached entry at depth >= the
 * requested depth (same fen/variant/multiPV). Lets a deep prior search
 * answer a shallower request without another engine round-trip — the
 * common case when the user toggles the depth slider down.
 * Returns { result, depth } on hit, null on miss.
 */
function getCachedEvalAtLeast(fen, variant, depth, multiPV) {
  return _evalCache.getAtLeast(fen, variant, depth, multiPV);
}

function setCachedEval(fen, variant, depth, multiPV, result) {
  _evalCache.set(fen, variant, depth, multiPV, result);
}

// Periodically purge expired cache entries to prevent memory buildup
setInterval(() => _evalCache.purgeExpired(), 60_000);

async function main() {
  // ── 0. Load ECO opening database ──────────────────────
  eco.loadEco(path.join(__dirname, "eco"));

  // ── 0a. Warm the file cache and start background refresher ──
  // First scan is awaited so the first request after startup never sees
  // an empty cache. After that the poller refreshes off the request path.
  await _fileCache.refresh();
  const stopFileCachePoller = _fileCache.start();

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
    duck:             f("Duck Chess",                "duck",             "popular"),
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

  // Full variant list reported by the active Fairy-Stockfish build (from its
  // UCI_Variant combo). Populated by a startup probe and refreshed whenever
  // fairy starts. Lets us surface *every* built-in the engine supports —
  // including variants.ini entries — not just the curated VARIANTS map.
  let fairyVariants = [];

  // Friendly labels + categories for built-ins beyond the curated VARIANTS
  // map. Anything the engine reports that isn't here gets an auto-prettified
  // label under the "more" category, so nothing is ever hidden.
  const EXTRA_VARIANT_META = {
    xiangqi:     { label: "Xiangqi (Chinese Chess)", category: "regional" },
    manchu:      { label: "Manchu",                  category: "regional" },
    janggi:      { label: "Janggi (Korean Chess)",   category: "regional" },
    capablanca:  { label: "Capablanca Chess",        category: "large" },
    capahouse:   { label: "Capablanca House",        category: "large" },
    gothic:      { label: "Gothic Chess",            category: "large" },
    janus:       { label: "Janus Chess",             category: "large" },
    modern:      { label: "Modern Chess",            category: "large" },
    embassy:     { label: "Embassy Chess",           category: "large" },
    chancellor:  { label: "Chancellor Chess",        category: "large" },
    courier:     { label: "Courier Chess",           category: "large" },
    grand:       { label: "Grand Chess",             category: "large" },
    grandhouse:  { label: "Grandhouse",              category: "large" },
    shako:       { label: "Shako",                   category: "large" },
    tencubed:    { label: "Ten-Cubed Chess",         category: "large" },
    opulent:     { label: "Opulent Chess",           category: "large" },
    shogun:      { label: "Shogun Chess",            category: "chess" },
    torpedo:     { label: "Torpedo Chess",           category: "chess" },
    jesonmor:    { label: "Jeson Mor",               category: "other" },
  };

  const prettifyVariant = (key) =>
    String(key).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  /** Look up (or synthesize) a variant definition. Curated VARIANTS win;
   *  otherwise any built-in the active fairy engine reports is routable. */
  function variantDef(variantKey) {
    if (VARIANTS[variantKey]) return VARIANTS[variantKey];
    if (fairyVariants.includes(variantKey)) {
      const meta = EXTRA_VARIANT_META[variantKey];
      return {
        label: meta ? meta.label : prettifyVariant(variantKey),
        engine: "fairy",
        uciVariant: variantKey,
        uci960: false,
        category: meta ? meta.category : "more",
      };
    }
    return null;
  }

  /** Variant list advertised to clients: curated VARIANTS first (nice labels,
   *  categories, auto-detection), then every other engine-reported built-in. */
  function buildVariantList() {
    const out = Object.entries(VARIANTS).map(([key, v]) => ({
      key,
      label: v.label,
      category: v.category,
    }));
    const seen = new Set(Object.keys(VARIANTS));
    for (const key of fairyVariants) {
      if (seen.has(key)) continue;
      seen.add(key);
      const meta = EXTRA_VARIANT_META[key];
      out.push({
        key,
        label: meta ? meta.label : prettifyVariant(key),
        category: meta ? meta.category : "more",
      });
    }
    return out;
  }

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
    if (!fs.existsSync(config.stockfishPath)) {
      throw new Error(
        `Stockfish binary not found at:\n    ${config.stockfishPath}\n\n` +
          `The engine binary is not bundled with this repo and must be downloaded separately.\n` +
          `  1. Download Stockfish from https://stockfishchess.org/download/\n` +
          `  2. Place the .exe at the path above (default: engine/stockfish/), OR\n` +
          `  3. Set STOCKFISH_PATH in backend/.env to point at your binary.\n` +
          `See README "Add engine binaries" for details.`,
      );
    }
    await engine.start();
  } catch (err) {
    console.error("[server] could not start Stockfish – exiting.\n" + err.message);
    process.exit(1);
  }

  // Probe Fairy-Stockfish once for its full built-in variant list so the
  // panel can expose everything the engine supports without waiting for the
  // user to switch into a variant first. Fire-and-forget + graceful: if the
  // fairy binary isn't installed, fairyVariants stays empty and the curated
  // list is used. A short-lived process is spawned and quit immediately.
  async function probeFairyVariants() {
    if (!config.fairyStockfishPath || !fs.existsSync(config.fairyStockfishPath)) return [];
    const probe = new StockfishBridge({
      binPath: config.fairyStockfishPath,
      handshakeTimeoutMs: 8000,
    });
    try {
      await probe.start();
      return probe.getSupportedVariants();
    } finally {
      try { probe.stop(); } catch { /* already gone */ }
    }
  }
  probeFairyVariants()
    .then((list) => {
      if (list.length) {
        fairyVariants = list;
        console.log(`[server] Fairy-Stockfish reports ${list.length} built-in variants`);
      }
    })
    .catch((err) => console.warn(`[server] fairy variant probe failed: ${err.message}`));

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
    const def = variantDef(variantKey);
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
          bindEngineHandlers();
        } catch (err) {
          // Rollback
          currentVariant = previousVariant;
          config.stockfishPath = oldPath;
          engine = new StockfishBridge();
          await engine.start();
          bindEngineHandlers();
          return { switched: false, error: `Failed to start ${needEngine}: ${err.message}` };
        }
        // Re-apply preserved settings to new engine
        for (const [k, v] of Object.entries(savedSettings)) {
          if (k !== "UCI_Variant" && k !== "UCI_Chess960" && k !== "SyzygyPath") {
            engine.setOption(k, v);
          }
        }
        currentEngineType = needEngine;
        // Capture the full built-in list the fairy engine just advertised.
        if (needEngine === "fairy") {
          const reported = engine.getSupportedVariants();
          if (reported.length) fairyVariants = reported;
        }
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

  // ── LAN PIN gate ───────────────────────────────────────
  // No-op when BIND_HOST is loopback. When LAN-exposed, every non-loopback
  // request must present a 6-digit PIN (printed once on startup) before any
  // route — including WS upgrade — is reachable.
  const pinAuth = createPinAuth({ enabled: config.bindHost === "0.0.0.0" });
  pinAuth.installHttp(app);

  // ── HTTP routes ──────────────────────────────────────────
  // Origin gate, CORS/PNA preflight, /healthz, /selfcheck, eval-cache
  // endpoints, and the panel static handler all live in
  // src/server/httpRoutes.js. Mutable state is read via getters so the
  // handlers always see the current engine / variant after a switch.
  const startedAt = Date.now();
  registerHttpRoutes(app, {
    startedAt,
    config,
    evalCache: _evalCache,
    evalCachePath: _evalCachePath,
    eco,
    book,
    pkgVersion: require("./package.json").version,
    panelDir: path.join(__dirname, "panel"),
    bookBaseName: (p) => path.basename(p),
    express,
    getEngine: () => engine,
    getCurrentEngineType: () => currentEngineType,
    getCurrentVariant: () => currentVariant,
    getLichessBook: () => lichessBook,
    getWss: () => wss,
  });

  const server = http.createServer(app);

  // Handle PNA preflight at the raw HTTP level (before ws upgrade intercepts)
  server.on("upgrade", (req, socket, head) => {
    console.log(`[server] WS upgrade from origin=${req.headers.origin || "none"} ip=${req.socket.remoteAddress}`);
    if (!pinAuth.wsUpgradeAllowed(req)) {
      console.warn(`[server] rejecting WS upgrade from ${req.socket.remoteAddress}: PIN required`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    }
  });

  const wss = new WebSocketServer({
    server,
    // Accept connections from any origin
    verifyClient: (info) => {
      console.log(`[server] WS verifyClient origin=${info.origin || "none"} secure=${info.secure}`);
      return true;
    },
  });

  // ── WS heartbeat ─────────────────────────────────────────
  // Half-open TCP connections (laptop lid closed, NAT timeout, etc.)
  // can keep a dead client in wss.clients for minutes, leaking memory
  // and pushing broadcast traffic into a dead socket. Send a low-level
  // ping every 30s and reap clients that miss two pings (60s).
  // Browsers auto-respond to ping frames per the WS spec, so the
  // extension/panel need no client-side change.
  const HEARTBEAT_MS = 30_000;
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        console.warn("[server] terminating unresponsive WS client");
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* socket already dying */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));

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

  server.listen(config.port, config.bindHost, () => {
    const host = config.bindHost === "0.0.0.0" ? "0.0.0.0" : "localhost";
    // Read the actual port from the server (matters when PORT=0 is
    // requested so Node picks an ephemeral port — e.g. integration
    // tests). For a fixed port this is identical to config.port.
    const addr = server.address();
    const actualPort = addr && typeof addr === "object" ? addr.port : config.port;
    console.log(`[server] listening on http://${host}:${actualPort} (HTTP + WS)`);
    if (config.bindHost === "0.0.0.0") {
      console.log(
        `[server] LAN mode: dashboard reachable from other devices on this network. ` +
          `Use BIND_HOST=127.0.0.1 to restrict to loopback only.`,
      );
      if (pinAuth.enabled) {
        console.log(
          `[server] pair other devices with: http://<your-lan-ip>:${actualPort}/?pin=${pinAuth.pin}`,
        );
      }
    }
  });

  /** Broadcast a message to all OTHER connected clients (for panel sync). */
  function broadcast(senderWs, message) {
    return wsBroadcast(wss, senderWs, message);
  }

  /** (Re-)attach event hooks whenever the engine instance is replaced. */
  function bindEngineHandlers() {
    engine.onRestarted = () =>
      wsBroadcast(wss, null, { type: "engine_restarted", message: "Engine auto-restarted — retry analysis" });
  }
  bindEngineHandlers();

  // safeSend is imported from src/ws/send; it no-ops on closed sockets
  // and stringifies objects on the fly.

  // Eval pipeline (book → cache → engine cascade). Lives in
  // src/server/evalPipeline.js; the per-connection message handler
  // chains runFen() onto its evaluationQueue so requests serialise.
  // Stable deps are bound here once; mutable state (engine instance,
  // engineSwitchPromise, per-connection generation counters) flows
  // through closure getters.
  const runFen = createEvalPipeline({
    config,
    book,
    lichessLookup,
    enrichLines,
    acquireEvalLock,
    getCachedEval,
    getCachedEvalAtLeast,
    setCachedEval,
    getEngine: () => engine,
    getEngineSwitchPromise: () => engineSwitchPromise,
    broadcast,
    safeSend,
    getEco,
  });

  wss.on("connection", (ws, req) => {
    const remote = req.socket.remoteAddress;
    console.log(`[server] client connected (${remote})`);

    // Heartbeat: mark alive on connect, refresh whenever we receive a
    // pong. The interval above flips this to false before each ping;
    // a missing pong leaves it false and the next tick reaps the socket.
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

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
    // Latest game_info received — used for clock-aware movetime caps (§8.3).
    let lastGameInfo = null;

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

      // Plan §11: zod-validate all inbound frames. Reject unknown types and
      // malformed payloads with a typed error. Known types with extra
      // fields fall through unchanged — validation is a safety net, not
      // a schema rewrite of the legacy protocol.
      const gateResult = validateInbound(msg);
      if (!gateResult.ok) {
        safeSend(ws, { type: "error", code: gateResult.code, message: gateResult.message });
        return;
      }

      // During shutdown, refuse anything that would enqueue engine work
      // — we've already bumped evalGeneration and are tearing down. Cheap
      // utility frames (hello, get_settings) still pass through so the
      // client can render a sensible disconnect state.
      if (shuttingDown && (msg.type === "fen" || msg.type === "switch_variant" || msg.type === "switch_engine")) {
        safeSend(ws, { type: "error", code: "shutting_down", message: "Server is shutting down" });
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

        // §8.3 clock-aware movetime cap — when we have a live game_info with
        // a clock for the side to move, never think longer than the user has.
        try {
          if (lastGameInfo && searchOptions.movetime) {
            const sideToMove = fen.split(" ")[1];
            const clockStr =
              sideToMove === "w"
                ? lastGameInfo.white && lastGameInfo.white.clock
                : sideToMove === "b"
                  ? lastGameInfo.black && lastGameInfo.black.clock
                  : null;
            const remainingMs = parseClockText(clockStr);
            if (remainingMs != null && remainingMs > 0) {
              const safe = computeSafeMovetime(searchOptions.movetime, remainingMs);
              if (safe.capped) {
                console.log(
                  `[server] clock cap: requested=${searchOptions.movetime}ms → ${safe.effectiveMs}ms (remaining=${remainingMs}ms)`,
                );
                searchOptions.movetime = safe.effectiveMs;
              }
            }
          }
        } catch (e) {
          console.warn("[server] clock cap failed:", e.message);
        }

        const gen = ++evalGeneration;
        const variantGen = globalVariantGen; // snapshot for staleness check
        const evalVariant = currentVariant; // snapshot variant for this eval (prevents stale reads)
        console.log(`[server] ← FEN (gen ${gen}): ${fen} [variant: ${evalVariant}]`);

        // Queue the evaluation so requests are processed one at a time.
        // The pipeline body (book → cache → engine cascade) lives in
        // src/server/evalPipeline.js; we chain it onto evaluationQueue
        // so requests serialise on the shared engine.
        evaluationQueue = evaluationQueue
          .then(() =>
            runFen({
              ws,
              fen,
              depth,
              searchOptions,
              evalVariant,
              gen,
              variantGen,
              getEvalGeneration: () => evalGeneration,
              getGlobalVariantGen: () => globalVariantGen,
            }),
          )
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
        if (["depth", "MultiPV", "Skill Level", "UCI_Elo", "UCI_LimitStrength"].includes(msg.name)) {
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
        lastGameInfo = msg;
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

      // ── Live engine streaming toggle ───────────────────
      // Mutates config so evalPipeline picks it up on the next eval.
      if (msg.type === "set_live_engine_stream") {
        config.liveEngineStream = !!msg.value;
        console.log(`[server] live engine streaming: ${config.liveEngineStream ? "enabled" : "disabled"}`);
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
          variants: buildVariantList(),
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
          bindEngineHandlers();
          safeSend(ws, { type: "engine_switched", name: found.name });
        } catch (err) {
          console.error(`[server] failed to switch engine: ${err.message}`);
          // Rollback: restore previous engine
          config.stockfishPath = prevPath;
          currentEngineType = prevType;
          try {
            engine = new StockfishBridge();
            await engine.start();
            bindEngineHandlers();
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
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return; // ignore repeated SIGINTs
    shuttingDown = true;
    console.log("\n[server] shutting down…");
    clearInterval(heartbeat);
    stopFileCachePoller();

    // Tell connected clients we're going away so they can show a
    // "reconnecting" UX instead of a hard close. evalGeneration is
    // per-connection, so we don't bump it here — the `shuttingDown`
    // flag at the message-handler entry point is what stops new
    // engine work from being enqueued.
    for (const client of wss.clients) {
      safeSend(client, { type: "server_shutdown" });
    }

    try {
      const count = _evalCache.saveToDisk(_evalCachePath);
      console.log(`[server] saved ${count} eval cache entries → ${_evalCachePath}`);
    } catch (err) {
      console.error("[server] failed to save eval cache:", err.message);
    }

    // Force exit after 5s no matter what so a stuck `wss.close` or
    // engine doesn't leave the process pinned.
    const forceExit = setTimeout(() => {
      console.error("[server] shutdown timeout — forcing exit");
      process.exit(1);
    }, 5000);
    forceExit.unref();

    try {
      // Wait for the engine PID to actually exit before we let Node
      // exit; otherwise the next start can race a stale stockfish
      // process for the same hash file / port-on-stdin etc.
      await engine.stop();
    } catch (err) {
      console.error("[server] engine stop failed:", err.message);
    }
    book.close();
    wss.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
