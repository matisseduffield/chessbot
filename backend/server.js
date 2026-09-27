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
const { safeSend: rawSend, broadcast: wsBroadcast } = require("./src/ws/send");
const { createRateLimiter } = require("./src/ws/rateLimit");
const { validateInbound } = require("./src/ws/validateMessage");
const { computeSafeMovetime } = require("./src/engine/clockCap");
const { parseClockText } = require("@chessbot/shared");
const serverLogger = require("./src/logger");
const { pickSearchLimits } = require("./src/engine/searchLimits");
const { classifyVariant, chooseFairyBinary } = require("./src/engine/engineSelect");
const { createPinAuth } = require("./src/auth/pin");
const { FileCache } = require("./src/server/fileCache");
const { registerHttpRoutes } = require("./src/server/httpRoutes");
const { createEvalPipeline } = require("./src/server/evalPipeline");
const { EngineScheduler } = require("./src/engine/scheduler");
const { SessionHub } = require("./src/server/sessionHub");
const { TrainingStore } = require("./src/analysis/trainingStore");
const { trainingFeedback } = require("./src/analysis/trainingFeedback");
function safeSend(ws, message) {
  return rawSend(ws, { ...message, sessionId: message.sessionId ?? ws.context?.sessionId ?? ws.sessionId,
    requestId: message.requestId ?? ws.context?.requestId });
}

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
    shogun:           f("Shogun Chess",              "shogun",           "chess"),
    torpedo:          f("Torpedo Chess",             "torpedo",          "chess"),
    // Large-board variants
    capablanca:       f("Capablanca Chess",          "capablanca",       "large"),
    capahouse:        f("Capablanca House",          "capahouse",        "large"),
    gothic:           f("Gothic Chess",              "gothic",           "large"),
    janus:            f("Janus Chess",               "janus",            "large"),
    modern:           f("Modern Chess",              "modern",           "large"),
    embassy:          f("Embassy Chess",             "embassy",          "large"),
    chancellor:       f("Chancellor Chess",          "chancellor",       "large"),
    courier:          f("Courier Chess",             "courier",          "large"),
    grand:            f("Grand Chess",               "grand",            "large"),
    grandhouse:       f("Grandhouse",                "grandhouse",       "large"),
    shako:            f("Shako",                     "shako",            "large"),
    tencubed:         f("Ten-Cubed Chess",           "tencubed",         "large"),
    opulent:          f("Opulent Chess",             "opulent",          "large"),
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
    xiangqi:          f("Xiangqi (Chinese Chess)",   "xiangqi",          "regional"),
    manchu:           f("Manchu",                    "manchu",           "regional"),
    janggi:           f("Janggi (Korean Chess)",     "janggi",           "regional"),
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
    jesonmor:         f("Jeson Mor",                 "jesonmor",         "other"),
  };
  let currentVariant = "chess"; // active variant key
  let currentEngineType = "stockfish"; // "stockfish" | "fairy"
  const originalStockfishPath = config.stockfishPath; // preserve for switching back

  // Full variant list reported by the active Fairy-Stockfish build (from its
  // UCI_Variant combo). Populated by a startup probe and refreshed whenever
  // fairy starts. Lets us surface *every* built-in the engine supports —
  // including variants.ini entries — not just the curated VARIANTS map.
  let fairyVariants = [];

  // Friendly labels + categories for any built-in the engine reports that
  // isn't in the curated VARIANTS map above (e.g. custom variants.ini
  // entries). Anything not listed here gets an auto-prettified label under
  // the "more" category, so nothing the engine supports is ever hidden.
  const EXTRA_VARIANT_META = {};

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

  const scheduler = new EngineScheduler(() => engine.abort());
  // The scheduler owns the engine for the entire dispatch, including switches.
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

  async function switchVariant(variantKey) {
    const def = variantDef(variantKey);
    if (!def) return { switched: false, error: `Unknown variant: ${variantKey}` };

    if (variantKey === currentVariant && engine.ready) return { switched: true };
    // Invalidate all pending evals from all clients before switching
    globalVariantGen++;

    // Set variant immediately so concurrent switch_engine messages see the new variant
    const previousVariant = currentVariant;
    currentVariant = variantKey;

    // Acquire lock to prevent concurrent engine operations
    engineSwitchLock = true;

    try {
      // Abort any pending evaluation before switching
      await engine.abort();

      const needEngine = def.engine; // "stockfish" | "fairy"
      // Auto-pick the right Fairy-Stockfish build for this variant: 8x8
      // variants (duck, atomic, ...) run on the standard build, large-board
      // variants (xiangqi, capablanca, ...) on the largeboard build. The
      // largeboard build segfaults on some 8x8 variants (e.g. duck), so this
      // routes each variant to a build that can actually play it — when both
      // binaries are present. Returns null = no preference (keep current).
      let desiredFairyPath = null;
      if (needEngine === "fairy") {
        const cls = classifyVariant(variantKey, (k) => !!VARIANTS[k]);
        desiredFairyPath = chooseFairyBinary(getCachedFiles().engines, cls);
      }
      const switchingType = needEngine !== currentEngineType;
      const switchingBinary =
        needEngine === "fairy" &&
        !!desiredFairyPath &&
        path.resolve(desiredFairyPath) !== path.resolve(config.stockfishPath);
      const needSwitch = switchingType || switchingBinary;

      if (needSwitch) {
        const newPath = needEngine === "fairy"
          ? (desiredFairyPath || config.fairyStockfishPath)
          : originalStockfishPath;
        if (switchingBinary && !switchingType) {
          console.log(`[server] auto-selecting fairy build for ${variantKey}: ${path.basename(newPath)}`);
        }
        if (!fs.existsSync(newPath)) {
          currentVariant = previousVariant; // rollback
          return { switched: false, error: `Engine binary not found: ${newPath}` };
        }
        console.log(`[server] variant ${variantKey} requires ${needEngine} engine — switching`);
        // Preserve user settings (Threads, Hash, MultiPV, etc.) across engine switch
        const savedSettings = engine.getSettings();
        await engine.stop();
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
    getEngine: () => ({ ready: engine.ready, evaluate: (...args) => scheduler.submit({
      key:'selfcheck', priority:3, run: async cancelled => {
        await activateSession(panelDefaults);
        const result=await engine.evaluate(...args);
        if(cancelled()) throw new Error('Self-check interrupted by live analysis');
        return result;
      } }) }),
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

  server.on("error", async (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[server] port ${config.port} is already in use. Kill the other process or set PORT env var.`);
    } else {
      console.error("[server] HTTP server error:", err.message);
    }
    await engine.stop();
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

  /** Relay a message only within its originating board session. */
  function broadcast(senderWs, message) {
    return hub.relay(senderWs, message);
  }

  /** (Re-)attach event hooks whenever the engine instance is replaced. */
  function bindEngineHandlers() {
    engine.onRestarted = () =>
      wsBroadcast(wss, null, { type: "engine_restarted", message: "Engine auto-restarted — retry analysis" });
  }
  bindEngineHandlers();

  // safeSend is imported from src/ws/send; it no-ops on closed sockets
  // and stringifies objects on the fly.

  // The scheduler serializes resource changes and evaluation. Getters read the
  // currently activated session resources at evaluation time.
  const runFen = createEvalPipeline({
    config,
    getBook: () => book,
    lichessLookup,
    enrichLines,
    getCachedEval,
    getCachedEvalAtLeast,
    setCachedEval,
    getEngine: () => engine,
    broadcast,
    safeSend,
    getEco,
  });

  const baseConfig = { ...config };
  const baseOptions = engine.getSettings();
  const basePreferences = {};
  let baseBookPaths = book.bookPaths.slice(), baseLichess = lichessBook.enabled;
  const hub = new SessionHub(rawSend, () => ({ config: { ...baseConfig }, options: { ...baseOptions },
    preferences:{...basePreferences}, variant: 'chess', enginePath: null, book: new OpeningBook(baseBookPaths), lichess: baseLichess, training: false, generation: 0 }));
  const panelDefaults = { id: 'defaults', ...hub.makeState() };
  const trainingStore = new TrainingStore(path.join(path.dirname(_evalCachePath), 'training-history.json'));
  async function publishTraining() {
    await trainingStore.save();
    for(const client of hub.clients) {
      rawSend(client,{type:'training_stats_update',sessionId:client.sessionId,...trainingStore.stats(client.sessionId)});
      if(client.role==='panel') rawSend(client,{type:'training_history',attempts:trainingStore.history()});
    }
  }

  async function activateSession(session) {
    const physicalPath = config.stockfishPath;
    Object.assign(config, session.config);
    config.stockfishPath = physicalPath;
    const switched = await switchVariant(session.variant);
    if (!switched.switched) throw new Error(switched.error);
    if (session.enginePath && session.enginePath !== config.stockfishPath) {
      const previousPath = config.stockfishPath;
      await engine.stop();
      config.stockfishPath = session.enginePath;
      engine = new StockfishBridge();
      try { await engine.start(); }
      catch (error) {
        config.stockfishPath = previousPath; engine = new StockfishBridge(); await engine.start();
        throw error;
      }
      bindEngineHandlers();
    }
    if (!session.bookInitialized) { await session.book.init(); session.bookInitialized = true; }
    book = session.book;
    lichessBook.setEnabled(session.lichess);
    for (const [key, value] of Object.entries(session.options)) {
      if (key === 'UCI_Variant' || key === 'UCI_Chess960' || key === 'SyzygyPath') continue;
      if (String(engine.getSettings()[key]) !== String(value)) engine.setOption(key, value);
    }
    const def = variantDef(session.variant);
    if (def?.uciVariant && engine.getSettings().UCI_Variant!==def.uciVariant) engine.setOption('UCI_Variant', def.uciVariant);
    if(String(engine.getSettings().UCI_Chess960)!==String(!!def?.uci960)) engine.setOption('UCI_Chess960', !!def?.uci960);
    const tablePath=['chess','chess960'].includes(session.variant) ? config.syzygyPath || '<empty>' : '<empty>';
    if(engine.getSettings().SyzygyPath!==tablePath) engine.setOption('SyzygyPath',tablePath);
  }
  function saveSession(session, seedDefaults=false) {
    session.config = { ...config }; session.options = engine.getSettings();
    session.variant = currentVariant; session.enginePath = config.stockfishPath;
    session.book = book; session.lichess = lichessBook.enabled;
    if(seedDefaults) {
      Object.assign(baseConfig,session.config);Object.assign(baseOptions,session.options);
      Object.assign(basePreferences,session.preferences);baseBookPaths=book.bookPaths.slice();baseLichess=session.lichess;
    }
  }

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

    // Send settings only after hello identifies the owning board session.

    // Per-client generation counter — prevents cross-client eval interference
    let evalGeneration = 0;

    // Latest game_info received — used for clock-aware movetime caps (§8.3).
    let lastGameInfo = null;

    async function handleMessage(data) {
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

      msg = gateResult.msg;
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
        if (msg.variant && variantDef(msg.variant) && msg.variant !== currentVariant) {
          console.log(`[server] content script detected variant: ${msg.variant}`);
          const result = await switchVariant(msg.variant);
          if (!result.switched) {
            safeSend(ws,{type:'error',code:'variant_unsupported',message:result.error}); return;
          }
          if (result.switched) {
            evalGeneration++;
            // Notify all clients of the variant change
            const variantMsg = { type: "variant_switched", variant: msg.variant, label: variantDef(msg.variant).label };
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

        // Temporary training settings are restored before the scheduler releases ownership.
        const savedPV = engine.getSettings().MultiPV;
        if (msg.training && !searchOptions.movetime) searchOptions.movetime = 1500;
        if (msg.multipv) engine.setOption('MultiPV', Math.max(Number(savedPV) || 1, msg.multipv));
        searchOptions.training = !!msg.training;
        if (ws.sessionId !== hub.focused && !searchOptions.movetime) searchOptions.movetime = 1500;
        ws.analysisConfig = { options: engine.getSettings(), variant: evalVariant, enginePath: config.stockfishPath };
        try {
          await runFen({ ws, fen, depth, searchOptions, evalVariant, gen, variantGen,
            getEvalGeneration: () => ws.isCancelled?.() ? -1 : evalGeneration,
            getGlobalVariantGen: () => globalVariantGen });
        } finally { engine.setOption('MultiPV', savedPV); }

      }

      // ── Engine settings ────────────────────────────────
      if (msg.type === "set_option" && msg.name && msg.value !== undefined) {
        console.log(`[server] ← set_option: ${msg.name} = ${msg.value}`);
        const ranges = {depth:[0,50], MultiPV:[1,8], Threads:[1,128], Hash:[1,65536], 'Skill Level':[0,20], UCI_Elo:[100,4000], SyzygyProbeDepth:[1,100], SyzygyProbeLimit:[0,7]};
        const range = ranges[msg.name];
        if (range && (!Number.isInteger(Number(msg.value)) || Number(msg.value)<range[0] || Number(msg.value)>range[1])) {
          safeSend(ws,{type:'error',code:'invalid_option',message:`${msg.name} must be between ${range[0]} and ${range[1]}`}); return;
        }
        if (msg.name === "depth") {
          const d = Number(msg.value);
          // Depth 0 = infinite analysis, otherwise clamp 1–50
          config.defaultDepth = d === 0 ? 0 : Math.min(50, Math.max(1, d || 15));
        } else {
          engine.setOption(msg.name, msg.value);
          if (String(engine.getSettings()[msg.name]) !== String(msg.value)) {
            safeSend(ws, { type: 'error', code: 'unsupported_option', message: `Option not applied: ${msg.name}` }); return;
          }
        }
        // Clear eval cache when settings that affect results change
        if (["depth", "MultiPV", "Skill Level", "UCI_Elo", "UCI_LimitStrength"].includes(msg.name)) {
          _evalCache.clear();
          console.log(`[server] eval cache cleared (${msg.name} changed)`);
        }
        safeSend(ws, { type: "option_set", name: msg.name, value: msg.value });
        // Notify the owning board only after the option has actually been applied.
        // Otherwise changing MultiPV leaves the previous single-line answer on screen.
        if (msg.name === 'MultiPV') broadcast(ws, { type: 'option_set', name: msg.name, value: msg.value });
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
        if(typeof msg.payload.type === 'string' && msg.payload.type.startsWith('set_')) {
          ws.sessionState.preferences ||= {};
          ws.sessionState.preferences[msg.payload.type] = msg.payload;
        }
        broadcast(ws, msg.payload);
      }

      // ── Lichess opening explorer toggle ────────────────
      if (msg.type === "set_lichess_book") {
        lichessBook.setEnabled(!!(msg.value ?? msg.enabled));
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
          liveEngineStream: !!config.liveEngineStream,
          preferences: ws.sessionState?.preferences || {},
          searchMovetime: config.searchMovetime, searchNodes: config.searchNodes,
          defaultDepth: config.defaultDepth,
          activeEngine: path.basename(config.stockfishPath),
          activeBook: book.enabled ? book.bookPaths.map(p => path.basename(p)) : [],
          activeSyzygy: config.syzygyPath || null,
          lichessBook: lichessBook.enabled,
          engines: getCachedFiles().engines.map((e) => e.name),
          books: getCachedFiles().books.map((b) => b.name),
          syzygy: getCachedFiles().syzygy.map((s) => s.name),
          variant: currentVariant,
          variants: buildVariantList(),
        });
        safeSend(ws,{type:'training_stats_update',...trainingStore.stats(ws.sessionState.id)});
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
          const variantMsg = { type: "variant_switched", variant: currentVariant, label: variantDef(currentVariant).label, activeEngine: path.basename(config.stockfishPath) };
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
          activeBook: book.enabled ? book.bookPaths.map(p => path.basename(p)) : [],
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
        const requiredType = variantDef(currentVariant)?.engine || "stockfish";
        const requestedType = found.name.toLowerCase().includes("fairy") ? "fairy" : "stockfish";
        if (requiredType !== requestedType) {
          console.log(`[server] ignoring switch_engine to ${found.name} — variant ${currentVariant} requires ${requiredType} engine`);
          safeSend(ws, { type: "error", code: "incompatible_engine", message: "Engine is incompatible with the selected variant" });
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
          await engine.stop();
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
          const previousBook = book;
          // Accept single name (string) or array of names
          const names = Array.isArray(msg.name) ? msg.name : [msg.name];
          const validNames = names.filter(n => n && n !== "");
          if (validNames.length === 0) {
            // Disable book
            book = new OpeningBook([]);
            await previousBook.close();
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
            if (paths.length !== validNames.length) {
              safeSend(ws, { type: "error", code: "resource_missing", message: `No valid books found` });
              return;
            }
            const replacement = new OpeningBook(paths);
            await replacement.init();
            if (replacement.books.length !== paths.length) { await replacement.close(); throw new Error('A selected book could not be opened'); }
            config.openingBookPath = paths[0];
            book = replacement;
            await previousBook.close();
            console.log(`[server] switched book to: ${resolvedNames.join(", ")}`);
            safeSend(ws, { type: "book_switched", name: resolvedNames.length === 1 ? resolvedNames[0] : resolvedNames });
          }
        } catch (err) {
          console.error(`[server] failed to switch book: ${err.message}`);
          safeSend(ws, { type: "error", code: "switch_failed", message: err.message });
        }
      }

      if (['set_live_engine_stream','set_lichess_book','broadcast'].includes(msg.type)) {
        safeSend(ws, { type: 'setting_applied', command: msg.type, payload: msg.payload, value: msg.value });
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
    }

    ws.on('message', async data => {
      let raw; try { raw = JSON.parse(data); } catch { return; }
      const parsed = validateInbound(raw);
      if (!parsed.ok) { safeSend(ws,{type:'error',code:parsed.code,message:parsed.message,requestId:raw?.requestId}); return; }
      const msg = parsed.msg;
      if (msg.type === 'hello') {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          safeSend(ws,{type:'error',code:'protocol_mismatch',message:'Update the backend and reload the extension.'}); return;
        }
        hub.register(ws,msg);
        if(ws.role==='extension') {
          const state=hub.state(ws);
          rawSend(ws,{type:'set_depth',value:state.config.defaultDepth});
          rawSend(ws,{type:'set_search_limits',movetime:state.config.searchMovetime,nodes:state.config.searchNodes});
          for(const pref of Object.values(state.preferences || {})) rawSend(ws,pref);
        }
        rawSend(ws,{type:'training_stats_update',sessionId:ws.sessionId,...trainingStore.stats(ws.sessionId)});
        if(ws.role==='panel') rawSend(ws,{type:'training_history',attempts:trainingStore.history()});
        return;
      }
      if (!ws.role) { safeSend(ws,{type:'error',code:'protocol_mismatch',message:'Reload the updated extension and dashboard.'}); return; }
      if (msg.type === 'focus_session') { if(ws.role==='extension' && hub.focused !== ws.sessionId) { scheduler.cancelAnalysis(hub.focused); hub.focus(ws.sessionId); } return; }
      if (msg.type === 'subscribe_session') { hub.subscribe(ws,msg.sessionId,msg.followFocus !== false); return; }
      const session = (ws.role==='panel' && msg.sessionId ? hub.sessions.get(msg.sessionId) : hub.state(ws)) || (ws.role==='panel' ? panelDefaults : null);
      if (!session) return;
      if (msg.type === 'game_info') { lastGameInfo=msg; session.gameInfo=msg; hub.relay(ws,{...msg,sessionId:session.id}); return; }
      if (msg.type === 'broadcast' && msg.payload.type === 'training_stats_update') return;
      if (msg.type === 'get_training_history') { rawSend(ws,{type:'training_history',attempts:trainingStore.history()}); return; }
      if (ws.role==='panel' && ['delete_training_attempt','clear_training_history'].includes(msg.type)) {
        if(msg.type==='clear_training_history') trainingStore.clear(); else trainingStore.delete(msg.id);
        await publishTraining(); return;
      }
      if(msg.type==='broadcast' && msg.payload.type==='reset_training_stats') {
        trainingStore.reset(session.id); await publishTraining();
      }
      if(msg.type==='training_attempt' && ws.role==='extension') {
        if(!validateFen(msg.attempt.before).valid || !validateFen(msg.attempt.after).valid) return;
        if(!trainingStore.add(session.id,msg.attempt)) return;
        await publishTraining();
        const snapshot={...session,config:{...session.config},options:{...(ws.analysisConfig?.options || session.options)},
          variant:msg.attempt.variant,enginePath:ws.analysisConfig?.enginePath || session.enginePath};
        scheduler.submit({key:`review:${msg.attempt.id}`,sessionId:session.id,priority:3,
          run:async cancelled=>{
            try { await activateSession(snapshot); trainingStore.update(msg.attempt.id,await trainingFeedback(engine,msg.attempt,cancelled)); }
            catch(error) {trainingStore.update(msg.attempt.id,{status:'unavailable',reason:error.message});}
            await publishTraining();
          }}).then(async outcome=>{
            if(outcome?.cancelled) {trainingStore.update(msg.attempt.id,{status:'unavailable',reason:'Review cancelled before analysis'});await publishTraining();}
          }).catch(error=>console.warn('[training]',error.message));
        return;
      }
      if (msg.type === 'cancel_search') { scheduler.cancelAnalysis(session.id); return; }
      if (msg.type === 'fen') {
        session.training = !!msg.training;
        session.preferences ||= {};
        session.preferences.set_training_mode={type:'set_training_mode',value:session.training};
        session.revealedFen = null;
      }
      if (msg.type === 'broadcast' && msg.payload.type === 'set_training_mode') {
        session.training = !!msg.payload.value; session.revealedFen = null;
      }
      if (msg.type === 'broadcast' && msg.payload.type === 'training_reveal') {
        if(msg.payload.fen === session.lastResult?.fen) {
          session.revealedFen = msg.payload.fen;
          hub.relay(ws,session.lastResult);
        }
        return;
      }
      const isFen = msg.type === 'fen';
      const sessionId = session.id;
      try {
        const outcome = await scheduler.submit({ key: isFen ? `fen:${sessionId}` : Symbol('control'), sessionId,
          priority: isFen ? (sessionId===hub.focused ? 1 : 2) : (['get_settings','list_files','get_server_logs'].includes(msg.type) ? 1 : 0), replace:isFen,
          run: async cancelled => {
            if(ws.readyState!==ws.OPEN) return;
            ws.context={requestId:msg.requestId,sessionId}; ws.sessionState=session; ws.isCancelled=cancelled;
            await activateSession(session);
            if(cancelled()) return;
            try { await handleMessage(JSON.stringify(msg)); }
            finally {
              saveSession(session,ws.role==='panel' && ['set_option','broadcast','set_live_engine_stream','set_lichess_book','switch_book','switch_syzygy'].includes(msg.type));
              if(cancelled() && isFen) safeSend(ws,{type:'analysis_cancelled',requestId:msg.requestId});
            }
          } });
        if (outcome?.cancelled && isFen) rawSend(ws,{type:'analysis_cancelled',sessionId,requestId:msg.requestId});
      } catch(error) {
        safeSend(ws,{type:'error',code:'engine_error',message:error.message,requestId:msg.requestId});
      }
    });

    ws.on("close", () => {
      console.log(`[server] client disconnected (${remote})`);
      rateLimiter.stop();
      if(ws.role==='extension') scheduler.cancel(ws.sessionId);
      hub.remove(ws);
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
    await scheduler.close();
    await trainingStore.save();
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
    await Promise.all([...new Set([book,panelDefaults.book,...[...hub.sessions.values()].map(s=>s.book)])].map(b=>b.close()));
    wss.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
