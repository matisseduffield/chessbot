/* ─────────────────────────────────────────────────────────────
   Chess Analysis Helper — Content Script
   Reads the board from chess.com / lichess.org / playstrategy.org /
   chesstempo.com, sends FEN to the local Stockfish backend,
   and draws best-move arrows.
   ───────────────────────────────────────────────────────────── */

const WS_URL = "ws://localhost:8080";

// Variants that support piece drops (captured pieces placed back on the board)
const DROP_VARIANTS = new Set([
  "crazyhouse", "bughouse", "chessgi", "shouse", "loop", "pocketknight",
  "shogun", "grandhouse", "placement",
]);

// Variants where castling is never legal (don't generate castling rights in FEN)
const NO_CASTLING_VARIANTS = new Set([
  "antichess", "giveaway", "racingkings",
]);

// Variant-specific starting board positions (piece-placement part of FEN)
// Used for new-game detection when the standard starting position doesn't match.
const VARIANT_START_FENS = {
  horde: "rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP",
  racingkings: "8/8/8/8/8/8/krbnNBRK/qrbnNBRQ",
};

// ── State ────────────────────────────────────────────────────
let ws = null;
let lastBoardFen = ""; // piece-placement part only (before first space)
let lastSentFen = "";  // full FEN last sent for analysis
let enabled = true;
let gameOver = false; // true when game has ended (checkmate, resign, draw, abort, etc.)
let observer = null;
let debounceTimer = null;
let pendingEval = false; // true while waiting for a bestmove response
let evalSentAt = 0;     // timestamp when last eval was sent — for client-side timeout
const EVAL_TIMEOUT_BASE_MS = 25000; // base timeout for depth ≤15
/** Dynamic eval timeout: scales with depth (min 25s, +3s per depth above 15, max 180s) */
function getEvalTimeout() {
  if (currentDepth === 0) return Infinity; // infinite analysis — no timeout
  return Math.min(180000, Math.max(EVAL_TIMEOUT_BASE_MS, EVAL_TIMEOUT_BASE_MS + (currentDepth - 15) * 3000));
}
let lastPieceCount = 0;  // to detect animation mid-flight (piece count changes)
let initialReadDone = false; // guard against duplicate initialRead calls
let pendingInitialFen = null; // FEN read before WS was ready, to send on connect
let currentDepth = 15; // analysis depth, updated from popup settings
let isDragging = false; // true while user is dragging a piece
let isDraggingSince = 0; // timestamp when drag started — safety valve for stuck drags
let waitingForOpponent = false; // true after our move, until board changes again
let renderGeneration = 0; // increments on each board change — prevents stale overlays
let documentDragHandlersAttached = false; // document-level handlers added only once
let lastKnownTurn = null; // last successfully detected turn — for alternation fallback
let voiceEnabled = false; // TTS — toggled from popup
let voiceEvalEnabled = false; // announce eval score changes
let voiceOpeningEnabled = false; // announce opening names
let voiceSpeed = 1.1; // TTS speech rate
let lastSpokenMove = ""; // prevent repeating the same announcement
let lastSpokenOpening = ""; // prevent repeating the same opening announcement
let runEngineFor = "me"; // "me" | "opponent" | "both" — which turns to analyze
let displayMode = "both"; // "arrow" | "box" | "both" — how to show best moves
let showOpponentResponse = true; // show predicted opponent reply (red arrow/box)
let searchMovetime = null; // null = disabled, else ms
let searchNodes = null; // null = disabled, else node count
let wsBackoff = 3000; // WebSocket reconnect backoff (ms), resets on connect
let detectedVariant = null; // chess variant detected from URL
let trainingMode = false; // progressive hint mode
let trainingStage = 0; // 0=piece hint, 1=zone hint, 2=full reveal
let trainingBestMove = null; // stored best move for comparison
let trainingCorrect = 0; // number of correct moves
let trainingTotal = 0; // total moves played
let trainingLastFen = ""; // FEN when training hint was shown
let trainingDifficulty = "medium"; // "easy" | "medium" | "hard"
let trainingStreak = 0; // consecutive correct moves
let trainingStrict = false; // only accept top move
let trainingAutoReveal = false; // auto-reveal correct move after user plays
let trainingSound = true; // play sound on correct/wrong
let trainingLines = []; // all PV lines for strict=false checking
let trainingRevealActive = false; // true while auto-reveal arrow is showing

// ── Auto-move / bot mode state ───────────────────────────────
let autoMoveEnabled = false; // toggle from panel or Alt+M
let autoMoveDelayMin = 500;  // minimum delay before executing move (ms)
let autoMoveDelayMax = 2000; // maximum delay before executing move (ms)
let autoMoveHumanize = true; // occasionally pick 2nd/3rd best move
let autoMoveHumanizeChance = 0.1; // probability (0–1) of picking suboptimal move
let autoMoveTimer = null;    // pending auto-move timeout
let autoMoveCooldownUntil = 0; // timestamp — block scheduling until this time
let _skipNextBoardChange = false; // after auto-move, skip the first board change (our own move)
let _autoMoveFailedFen = ""; // board FEN (position only) where auto-move last failed — skip re-scheduling
let bulletMode = false; // bullet mode: zero delay, no humanize, fast search
let variantSwitchUntil = 0; // timestamp — suppress auto-move after variant switch

// ── 3-check state tracking ───────────────────────────────────
let threeCheckRemaining = { w: 3, b: 3 }; // checks each side still needs to GIVE to win

// ── Log buffer ───────────────────────────────────────────────
const LOG_BUFFER_MAX = 500;
const logBuffer = [];
const _origLog = console.log;
const _origWarn = console.warn;
const _origErr = console.error;
function bufferLog(level, args) {
  const line = `[${new Date().toISOString().slice(11,23)}] ${level}: ${Array.from(args).map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`;
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}
console.log = function(...args) { bufferLog("LOG", args); _origLog.apply(console, args); };
console.warn = function(...args) { bufferLog("WARN", args); _origWarn.apply(console, args); };
console.error = function(...args) { bufferLog("ERR", args); _origErr.apply(console, args); };

// ── Site detection ───────────────────────────────────────────
const SITE = detectSite();
/** True for any site using the Chessground board library (lichess, playstrategy, etc.) */
const IS_CHESSGROUND = SITE === "lichess" || SITE === "playstrategy";

function detectSite() {
  const host = location.hostname;
  if (host.includes("chess.com")) return "chesscom";
  if (host.includes("lichess")) return "lichess";
  if (host.includes("playstrategy")) return "playstrategy";
  if (host.includes("chesstempo")) return "chesstempo";
  return null;
}

/** Detect chess variant from URL path. Returns key like "atomic", "chess960", etc. or null. */
function detectVariant() {
  const path = location.pathname.toLowerCase();
  if (IS_CHESSGROUND) {
    // Lichess / PlayStrategy: /atomic/..., /crazyhouse/..., /chess960/..., etc.
    if (path.includes("/atomic")) return "atomic";
    if (path.includes("/crazyhouse")) return "crazyhouse";
    if (path.includes("/chess960")) return "chess960";
    if (path.includes("/kingofthehill")) return "kingofthehill";
    if (path.includes("/threecheck") || path.includes("/three-check")) return "3check";
    if (path.includes("/fivecheck") || path.includes("/five-check")) return "3check"; // PlayStrategy five-check
    if (path.includes("/antichess")) return "antichess";
    if (path.includes("/giveaway")) return "giveaway";
    if (path.includes("/horde")) return "horde";
    if (path.includes("/racingkings") || path.includes("/racing-kings")) return "racingkings";
    if (path.includes("/bughouse")) return "bughouse";
    if (path.includes("/nocastling") || path.includes("/no-castling")) return null; // standard rules, no special engine
    // Lichess game pages (/AbCdEfGh) don't have variant in URL.
    // Detect from the game-info label or page title.
    const lichessDom = detectVariantFromLichessDOM();
    if (lichessDom) return lichessDom;
  }
  if (SITE === "chesscom") {
    // Chess.com: /variants/chess960, /variants/atomic, etc. Also /play/chess960, /live/chess960
    if (path.includes("chess960") || path.includes("960")) return "chess960";
    if (path.includes("atomic")) return "atomic";
    if (path.includes("crazyhouse")) return "crazyhouse";
    if (path.includes("kingofthehill") || path.includes("king-of-the-hill")) return "kingofthehill";
    if (path.includes("3-check") || path.includes("3check") || path.includes("threecheck") || path.includes("three-check")) return "3check";
    if (path.includes("antichess")) return "antichess";
    if (path.includes("giveaway")) return "giveaway";
    if (path.includes("horde")) return "horde";
    if (path.includes("racingkings") || path.includes("racing-kings")) return "racingkings";
    if (path.includes("bughouse")) return "bughouse";
    // Chess.com in-game pages (/game/live/12345) don't have variant in URL.
    // Try detecting from page title or DOM elements.
    const domVariant = detectVariantFromDOM();
    if (domVariant) return domVariant;
  }
  return null;
}

/** Detect variant from chess.com DOM when URL doesn't contain variant name.
 *  Chess.com shows variant name in page title ("Atomic • user vs user")
 *  and in game-info elements. */
function detectVariantFromDOM() {
  // Method 1: page title — chess.com format: "Variant • Player vs Player"
  const title = document.title.toLowerCase();
  const titleVariants = [
    ["atomic", "atomic"],
    ["crazyhouse", "crazyhouse"],
    ["king of the hill", "kingofthehill"],
    ["3-check", "3check"], ["three-check", "3check"], ["three check", "3check"],
    ["giveaway", "giveaway"],
    ["antichess", "giveaway"], // chess.com plays giveaway rules even when labelled "antichess"
    ["horde", "horde"],
    ["racing kings", "racingkings"],
    ["bughouse", "bughouse"],
    ["chess960", "chess960"], ["fischer random", "chess960"],
  ];
  for (const [needle, variant] of titleVariants) {
    if (title.includes(needle)) return variant;
  }
  // Method 2: game-info header text (chess.com shows variant name near player names)
  const infoEls = document.querySelectorAll(
    "[class*='game-info'], [class*='GameInfo'], [class*='header-title'], [class*='game-type'], [data-cy='game-info-variant']"
  );
  for (const el of infoEls) {
    const text = (el.textContent || "").toLowerCase();
    for (const [needle, variant] of titleVariants) {
      if (text.includes(needle)) return variant;
    }
  }
  return null;
}

/** Detect variant from Lichess DOM when URL is just a game ID (/AbCdEfGh).
 *  Lichess shows a variant label (e.g. blue "ATOMIC") in the game info section
 *  and includes the variant name in the page title. */
function detectVariantFromLichessDOM() {
  const variantMap = [
    ["atomic", "atomic"],
    ["crazyhouse", "crazyhouse"],
    ["chess960", "chess960"], ["chess 960", "chess960"], ["960", "chess960"],
    ["king of the hill", "kingofthehill"],
    ["three-check", "3check"], ["threecheck", "3check"], ["three check", "3check"], ["3-check", "3check"], ["3check", "3check"],
    ["antichess", "antichess"],
    ["horde", "horde"],
    ["racing kings", "racingkings"],
    ["no castling", null], // standard rules, no special engine
  ];

  // Method 1: game info section — Lichess has a .game__meta section
  // containing a variant link like <a href="/variant/atomic">ATOMIC</a>
  const metaEls = document.querySelectorAll(
    ".game__meta a[href*='/variant/'], .game__meta .header .setup, " +
    ".game__meta .setup, .round__underboard .game__meta, " +
    "section.game__meta, .setup-info a[href*='/variant/']"
  );
  for (const el of metaEls) {
    const text = (el.textContent || "").toLowerCase().trim();
    for (const [needle, variant] of variantMap) {
      if (text.includes(needle)) {
        console.log(`[chessbot] Lichess DOM variant detected: "${text}" → ${variant || "standard"}`);
        return variant;
      }
    }
    // Also check href for variant links
    const href = (el.getAttribute("href") || "").toLowerCase();
    for (const [needle, variant] of variantMap) {
      if (href.includes(needle.replace(/ /g, ""))) {
        console.log(`[chessbot] Lichess DOM variant detected from href: "${href}" → ${variant || "standard"}`);
        return variant;
      }
    }
  }

  // Method 2: page title — Lichess format: "player • player in variant"
  // or "Casual Atomic • player vs player"
  const title = document.title.toLowerCase();
  for (const [needle, variant] of variantMap) {
    if (title.includes(needle)) {
      console.log(`[chessbot] Lichess title variant detected: "${needle}" → ${variant || "standard"}`);
      return variant;
    }
  }

  return null;
}

/** Return fairy-stockfish 3-check counter string from tracked state. */
function getThreeCheckCounters() {
  if (detectedVariant !== "3check") return null;
  return `${threeCheckRemaining.w}+${threeCheckRemaining.b}`;
}

/** Check if the king of `kingColor` ("w" or "b") is in check on the given board. */
function isKingInCheck(boardPart, kingColor) {
  const grid = fenBoardToGrid(boardPart);
  const kingChar = kingColor === "w" ? "K" : "k";
  let kr = -1, kf = -1;
  for (let r = 0; r < grid.length; r++)
    for (let f = 0; f < grid[r].length; f++)
      if (grid[r][f] === kingChar) { kr = r; kf = f; }
  if (kr < 0) return false;
  const nR = grid.length, nF = grid[0].length;
  // Attacking pieces: opposite color
  const atk = kingColor === "b"
    ? { P: "P", N: "N", B: "B", R: "R", Q: "Q" }
    : { P: "p", N: "n", B: "b", R: "r", Q: "q" };
  // Knight
  for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const r = kr+dr, f = kf+df;
    if (r >= 0 && r < nR && f >= 0 && f < nF && grid[r][f] === atk.N) return true;
  }
  // Rook / Queen (straight lines)
  for (const [dr, df] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    for (let i = 1; i < 8; i++) {
      const r = kr+dr*i, f = kf+df*i;
      if (r < 0 || r >= nR || f < 0 || f >= nF) break;
      const p = grid[r][f];
      if (p) { if (p === atk.R || p === atk.Q) return true; break; }
    }
  }
  // Bishop / Queen (diagonals)
  for (const [dr, df] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
    for (let i = 1; i < 8; i++) {
      const r = kr+dr*i, f = kf+df*i;
      if (r < 0 || r >= nR || f < 0 || f >= nF) break;
      const p = grid[r][f];
      if (p) { if (p === atk.B || p === atk.Q) return true; break; }
    }
  }
  // Pawn — white pawns attack upward (lower rank index), black pawns attack downward
  if (kingColor === "b") {
    // White pawns attack from rank below (higher grid index)
    if (kr+1 < nR && kf-1 >= 0 && grid[kr+1][kf-1] === atk.P) return true;
    if (kr+1 < nR && kf+1 < nF && grid[kr+1][kf+1] === atk.P) return true;
  } else {
    // Black pawns attack from rank above (lower grid index)
    if (kr-1 >= 0 && kf-1 >= 0 && grid[kr-1][kf-1] === atk.P) return true;
    if (kr-1 >= 0 && kf+1 < nF && grid[kr-1][kf+1] === atk.P) return true;
  }
  return false;
}

/** Try to initialize 3-check counters from the move list DOM (for page refresh mid-game). */
function initThreeCheckFromMoveList() {
  if (detectedVariant !== "3check") return;
  threeCheckRemaining = { w: 3, b: 3 };
  // Gather move text from all known move list selectors
  const selectors = SITE === "chesscom"
    ? [".main-line-ply, [data-ply], move-list-ply", ".move-text-component",
       ".move-list .move, [class*='move-list'] [class*='move']"]
    : IS_CHESSGROUND
      ? ["move, m2, .moves kwdb"]
      : [];
  let moveTexts = [];
  for (const sel of selectors) {
    const nodes = document.querySelectorAll(sel);
    const filtered = Array.from(nodes).filter(el => {
      const t = el.textContent.trim();
      return t && /[a-hNBRQKO]/.test(t) && !/^\d+\.?$/.test(t);
    });
    if (filtered.length > 0) {
      moveTexts = filtered.map(el => el.textContent.trim());
      break;
    }
  }
  let wChecks = 0, bChecks = 0;
  for (let i = 0; i < moveTexts.length; i++) {
    if (/[+#]/.test(moveTexts[i])) {
      if (i % 2 === 0) wChecks++; else bChecks++;
    }
  }
  if (wChecks > 0 || bChecks > 0) {
    threeCheckRemaining.w = Math.max(0, 3 - wChecks);
    threeCheckRemaining.b = Math.max(0, 3 - bChecks);
  }
  console.log(`[chessbot] 3check init: w=${threeCheckRemaining.w} b=${threeCheckRemaining.b} (from ${moveTexts.length} moves, wChecks=${wChecks} bChecks=${bChecks})`);
}

/** Detect if the current page is a puzzle/training page. */
function isPuzzlePage() {
  const path = location.pathname.toLowerCase();
  if (SITE === "chesscom") {
    return path.includes("/puzzles") || path.includes("/puzzle") || path.includes("/lessons");
  }
  if (IS_CHESSGROUND) {
    return path.startsWith("/training") || path.startsWith("/streak") || path.startsWith("/storm");
  }
  if (SITE === "chesstempo") {
    return path.includes("/chess-tactics") || path.includes("/chess-endgames") || path.includes("/guess-the-move");
  }
  return false;
}

if (!SITE) {
  // Not a supported site — bail out
  console.log("[chessbot] unsupported site, content script inactive");
} else {
  console.log(`[chessbot] detected site: ${SITE}`);
  init();
  watchForSPANavigation();
}

// ── SPA Navigation Detection ─────────────────────────────────
// Chess.com is a SPA — navigating from /variants (lobby) to
// /variants/atomic/game/... doesn't reload the page. We need
// to detect URL changes and re-initialise variant detection + board finding.
let lastKnownPath = location.pathname;

function watchForSPANavigation() {
  // Monkey-patch history methods to detect pushState/replaceState
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;

  history.pushState = function (...args) {
    origPushState.apply(this, args);
    onPossibleNavigation();
  };
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    onPossibleNavigation();
  };

  // popstate fires on back/forward navigation
  window.addEventListener("popstate", () => onPossibleNavigation());

  // Fallback: poll for URL changes every 1.5s (catches edge cases)
  setInterval(() => {
    if (location.pathname !== lastKnownPath) {
      onPossibleNavigation();
    }
  }, 1500);
}

function onPossibleNavigation() {
  const newPath = location.pathname;
  if (newPath === lastKnownPath) return;

  const oldPath = lastKnownPath;
  lastKnownPath = newPath;
  console.log(`[chessbot] SPA navigation detected: ${oldPath} → ${newPath}`);

  // Re-detect variant from the new URL
  const newVariant = detectVariant();
  const oldVariant = detectedVariant;
  detectedVariant = newVariant;
  console.log(`[chessbot] variant re-detected: ${newVariant || "standard"} (was: ${oldVariant || "standard"})`);

  // Notify server of variant change if it changed
  if (newVariant !== oldVariant && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "switch_variant", variant: newVariant || "chess" }));
    const label = (newVariant || "standard").replace(/\b\w/g, c => c.toUpperCase());
    showToast(`Variant: ${label}`);
  }

  // Suppress auto-move for a period after any navigation — gives the new variant/game
  // time to settle so we don't play a stale bestmove from the previous game.
  variantSwitchUntil = Date.now() + 2000;

  // Reset board state and re-find the board
  boardReady = false;
  initialReadDone = false;
  lastBoardFen = "";
  lastSentFen = "";
  lastPieceCount = 0;
  pendingEval = false;
  waitingForOpponent = false;
  renderGeneration++;
  clearArrow();
  // Reset training and auto-move state for new game/variant
  trainingBestMove = null;
  trainingLastFen = "";
  trainingStage = 0;
  trainingLines = [];
  trainingRevealActive = false;
  cancelAutoMove();
  autoMoveCooldownUntil = 0;

  // Small delay to let the SPA render the new page
  setTimeout(() => {
    console.log(`[chessbot] re-initialising board search after navigation`);
    findBoard();
  }, 500);
}

// ── Initialisation ───────────────────────────────────────────
let boardReady = false;

function init() {
  detectedVariant = detectVariant();
  if (detectedVariant) {
    console.log(`[chessbot] detected variant: ${detectedVariant}`);
    const label = detectedVariant.replace(/\b\w/g, c => c.toUpperCase());
    showToast(`Variant: ${label}`);
  }

  function startAfterRestore() {
    connectWS();
    findBoard();
  }

  // Restore persisted training settings before connecting
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([
      "chessbot_trainingMode", "chessbot_trainingDifficulty",
      "chessbot_trainingStrict", "chessbot_trainingAutoReveal", "chessbot_trainingSound",
      "chessbot_autoMove"
    ], (result) => {
      if (result.chessbot_trainingMode) { trainingMode = true; console.log("[chessbot] training mode restored from storage"); }
      if (result.chessbot_trainingDifficulty) trainingDifficulty = result.chessbot_trainingDifficulty;
      if (result.chessbot_trainingStrict !== undefined) trainingStrict = !!result.chessbot_trainingStrict;
      if (result.chessbot_trainingAutoReveal !== undefined) trainingAutoReveal = !!result.chessbot_trainingAutoReveal;
      if (result.chessbot_trainingSound !== undefined) trainingSound = !!result.chessbot_trainingSound;
      if (result.chessbot_autoMove) { autoMoveEnabled = true; console.log("[chessbot] auto-move restored from storage"); }
      startAfterRestore();
    });
  } else {
    startAfterRestore();
  }
}

function findBoard() {
  boardReady = false;
  initialReadDone = false;
  pendingInitialFen = null;
  waitingForOpponent = false;
  _initialStableAttempts = 0;
  _variantColorMap = null;
  _variantColorMapKey = null;
  _cachedPlayerColor = null;
  lastKnownTurn = null;
  nullFenCount = 0;
  observedBoardEl = null;
  chesscomBoardToFen._diagLogged = false;
  waitForBoard().then((boardEl) => {
    const rect = (SITE === "chesscom") ? getVisualBoardRect(boardEl) : boardEl.getBoundingClientRect();
    console.log(`[chessbot] board found on ${SITE}: <${boardEl.tagName}> class="${(boardEl.className || '').toString().substring(0, 60)}" visual=${Math.round(rect.width)}x${Math.round(rect.height)} pieces=${boardEl.querySelectorAll(".piece").length}`);
    boardReady = true;
    observeBoard(boardEl);
    initialRead();
  });
}

/** First read after finding the board — forces analysis regardless of diff.
 *  Waits for the position to stabilise (chess.com briefly shows the start
 *  position before rendering the real game state on reload). */
let _initialStableAttempts = 0;
const MAX_STABLE_ATTEMPTS = 15; // 15 × 300ms = 4.5s max wait

function initialRead() {
  if (initialReadDone || !boardReady || !enabled) return;
  const fen = boardToFen();
  if (!fen) {
    // Pieces not rendered yet, try again shortly
    setTimeout(() => initialRead(), 200);
    return;
  }

  const boardPart = fen.split(" ")[0];
  const pieceCount = countPieces(boardPart);

  // On reload chess.com briefly shows the starting position before updating
  // to the real game.  Wait until two consecutive reads return the same FEN.
  if (boardPart !== lastBoardFen && _initialStableAttempts < MAX_STABLE_ATTEMPTS) {
    lastBoardFen = boardPart;
    lastPieceCount = pieceCount;
    _initialStableAttempts++;
    console.log(`[chessbot] initial read: position still changing, retry ${_initialStableAttempts}`);
    setTimeout(() => initialRead(), 300);
    return;
  }

  initialReadDone = true;
  lastBoardFen = boardPart;
  lastPieceCount = pieceCount;

  // Late variant detection: if URL didn't reveal the variant, try DOM-based
  // detection now that the page has loaded (title/game-info updates async)
  if (!detectedVariant) {
    let domVariant = null;
    if (SITE === "chesscom") domVariant = detectVariantFromDOM();
    else if (IS_CHESSGROUND) domVariant = detectVariantFromLichessDOM();
    if (domVariant) {
      detectedVariant = domVariant;
      console.log(`[chessbot] late variant detection from DOM: ${domVariant}`);
      const label = domVariant.replace(/\b\w/g, c => c.toUpperCase());
      showToast(`Variant: ${label}`);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "switch_variant", variant: domVariant }));
      }
    }
  }

  // Lock player color now — the board has all pieces, giving reliable flip detection.
  // Must happen AFTER variant detection (which may affect the board element found).
  lockPlayerColor();

  // Initialize 3-check counters from move list (for page refresh mid-game)
  initThreeCheckFromMoveList();

  // Determine whose turn it is using all available methods
  const turn = inferTurn("", boardPart);
  const playerColor = getPlayerColor();

  console.log(`[chessbot] initial load — turn=${turn} player=${playerColor} pieces=${pieceCount}`);

  if (!turn) {
    // Can't determine turn — for starting position it's always white's turn
    const boardNoPocket = boardPart.replace(/\[.*?\]$/, "");
    const isStart = boardNoPocket === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
    const assumedTurn = isStart ? "w" : playerColor;
    console.log(`[chessbot] turn unknown on initial load — assuming ${assumedTurn}`);
    const isMyTurn = assumedTurn === playerColor;
    const shouldAnalyze =
      runEngineFor === "both" ||
      (runEngineFor === "me" && isMyTurn) ||
      (runEngineFor === "opponent" && !isMyTurn);
    if (!shouldAnalyze) {
      // Still seed lastKnownTurn so readAndSend has a fallback
      lastKnownTurn = assumedTurn;
      console.log("[chessbot] not our analysis turn on initial load — waiting");
      return;
    }
  } else {
    const isMyTurn = turn === playerColor;
    const shouldAnalyze =
      runEngineFor === "both" ||
      (runEngineFor === "me" && isMyTurn) ||
      (runEngineFor === "opponent" && !isMyTurn);
    if (!shouldAnalyze) {
      console.log("[chessbot] not our analysis turn on initial load — waiting");
      return;
    }
  }

  // Starting position is always white's turn — don't let playerColor override this
  const boardPartNoPocket = boardPart.replace(/\[.*?\]$/, "");
  const isStartingPos = boardPartNoPocket === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
  const effectiveInitialTurn = turn || (isStartingPos ? "w" : playerColor) || "w";
  lastKnownTurn = effectiveInitialTurn; // seed so readAndSend has a fallback

  const parts = fen.split(" ");
  parts[1] = effectiveInitialTurn;
  const correctedFen = parts.join(" ");

  if (sendFen(correctedFen)) {
    lastSentFen = correctedFen;
    pendingEval = true;
    console.log(`[chessbot] → initial FEN: ${correctedFen}`);
  } else {
    // WS not ready — queue the FEN to send as soon as it connects
    pendingInitialFen = correctedFen;
    console.log(`[chessbot] WS not ready, queued FEN: ${correctedFen}`);
  }
}

// ── WebSocket ────────────────────────────────────────────────
function connectWS() {
  if (ws && ws.readyState <= 1) return; // CONNECTING or OPEN

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log(`[chessbot] connected to backend (variant=${detectedVariant || "standard"}, site=${SITE}, url=${location.pathname})`);
    wsBackoff = 3000; // reset backoff on successful connect
    // If we queued a FEN before WS was ready, send it now
    if (pendingInitialFen) {
      // Verify the board hasn't changed since we queued the FEN
      const currentFen = boardToFen();
      const currentBoard = currentFen ? currentFen.split(" ")[0] : null;
      const queuedBoard = pendingInitialFen.split(" ")[0];
      if (currentBoard && currentBoard !== queuedBoard) {
        console.log("[chessbot] board changed since queued — letting polling handle it");
        pendingInitialFen = null;
      } else {
        console.log(`[chessbot] sending queued FEN: ${pendingInitialFen}`);
        if (sendFen(pendingInitialFen)) {
          lastSentFen = pendingInitialFen;
          pendingEval = true;
          evalSentAt = Date.now();
        }
        pendingInitialFen = null;
      }
    } else if (lastSentFen && enabled) {
      // Reconnected — resend last position for continuity
      console.log(`[chessbot] reconnected — resending last position`);
      pendingEval = true;
      evalSentAt = Date.now();
      sendFen(lastSentFen);
    } else if (boardReady && !lastSentFen) {
      // Board found but no FEN queued or sent — try reading now
      console.log("[chessbot] WS connected, triggering initial read");
      initialReadDone = false;
      initialRead();
    }
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === "error") {
        console.log(`[chessbot] server error: ${msg.message}`);
        pendingEval = false;
        // If engine not ready (restarting), retry after a short delay
        if (msg.message && msg.message.includes("not ready")) {
          lastSentFen = "";
          setTimeout(() => readAndSend(), 3000);
        }
        return;
      }
      // Handle settings broadcast from panel
      if (msg.type === "set_run_engine_for" && msg.value) {
        const val = msg.value;
        if (["me", "opponent", "both"].includes(val)) {
          runEngineFor = val;
          console.log(`[chessbot] run engine for: ${runEngineFor} (from panel)`);
          waitingForOpponent = false;
          lastSentFen = "";
          pendingEval = false;
          readAndSend();
        }
        return;
      }
      if (msg.type === "set_search_limits") {
        searchMovetime = msg.movetime || null;
        searchNodes = msg.nodes || null;
        console.log(`[chessbot] search limits: movetime=${searchMovetime} nodes=${searchNodes} (from panel)`);
        resendCurrentPosition();
        return;
      }
      if (msg.type === "set_show_opponent_response") {
        showOpponentResponse = !!msg.value;
        console.log(`[chessbot] show opponent response: ${showOpponentResponse}`);
        resendCurrentPosition();
        return;
      }
      if (msg.type === "set_voice") { voiceEnabled = !!msg.value; return; }
      if (msg.type === "set_voice_eval") { voiceEvalEnabled = !!msg.value; return; }
      if (msg.type === "set_voice_opening") { voiceOpeningEnabled = !!msg.value; return; }
      if (msg.type === "set_voice_speed") { voiceSpeed = Number(msg.value) || 1.1; return; }
      if (msg.type === "set_auto_move") {
        autoMoveEnabled = !!msg.value;
        console.log(`[chessbot] auto-move: ${autoMoveEnabled} (from panel)`);
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ chessbot_autoMove: autoMoveEnabled });
        }
        if (!autoMoveEnabled) cancelAutoMove();
        return;
      }
      if (msg.type === "set_auto_move_delay") {
        autoMoveDelayMin = Math.max(0, Number(msg.min) || 500);
        autoMoveDelayMax = Math.max(autoMoveDelayMin, Number(msg.max) || 2000);
        console.log(`[chessbot] auto-move delay: ${autoMoveDelayMin}–${autoMoveDelayMax}ms`);
        return;
      }
      if (msg.type === "set_auto_move_humanize") {
        autoMoveHumanize = !!msg.value;
        if (msg.chance !== undefined) autoMoveHumanizeChance = Math.max(0, Math.min(1, Number(msg.chance)));
        console.log(`[chessbot] auto-move humanize: ${autoMoveHumanize} (chance: ${autoMoveHumanizeChance})`);
        return;
      }
      if (msg.type === "set_bullet_mode") {
        bulletMode = !!msg.value;
        console.log(`[chessbot] bullet mode: ${bulletMode} (from panel)`);
        if (bulletMode) resendCurrentPosition(); // re-send with fast movetime
        return;
      }
      if (msg.type === "set_depth") {
        currentDepth = Number(msg.value) || 15;
        console.log(`[chessbot] depth set to ${currentDepth} (from panel)`);
        resendCurrentPosition();
        return;
      }
      if (msg.type === "set_training_mode") {
        trainingMode = !!msg.value;
        trainingStage = 0;
        trainingBestMove = null;
        trainingRevealActive = false;
        console.log(`[chessbot] training mode: ${trainingMode}`);
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ chessbot_trainingMode: trainingMode });
        }
        resendCurrentPosition();
        return;
      }
      if (msg.type === "set_training_difficulty") {
        if (["easy","medium","hard"].includes(msg.value)) {
          trainingDifficulty = msg.value;
          if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ chessbot_trainingDifficulty: trainingDifficulty });
          }
          console.log(`[chessbot] training difficulty: ${trainingDifficulty}`);
          resendCurrentPosition();
        }
        return;
      }
      if (msg.type === "set_training_auto_reveal") {
        trainingAutoReveal = !!msg.value;
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ chessbot_trainingAutoReveal: trainingAutoReveal });
        }
        return;
      }
      if (msg.type === "set_training_sound") {
        trainingSound = !!msg.value;
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ chessbot_trainingSound: trainingSound });
        }
        return;
      }
      if (msg.type === "set_training_strict") {
        trainingStrict = !!msg.value;
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ chessbot_trainingStrict: trainingStrict });
        }
        return;
      }
      if (msg.type === "reset_training_stats") {
        trainingCorrect = 0;
        trainingTotal = 0;
        trainingStreak = 0;
        trainingBestMove = null;
        trainingLastFen = "";
        trainingStage = 0;
        trainingLines = [];
        trainingRevealActive = false;
        console.log("[chessbot] training stats reset");
        resendCurrentPosition();
        return;
      }
      if (msg.type === "set_display_mode") {
        if (["arrow", "box", "both"].includes(msg.value)) {
          displayMode = msg.value;
          resendCurrentPosition();
        }
        return;
      }
      if (msg.type === "variant_switched") {
        console.log(`[chessbot] variant switched to: ${msg.variant} (${msg.label})`);
        return;
      }
      if (msg.type === "bestmove") {
        // For streaming (infinite analysis), keep pendingEval true
        if (!msg.streaming) pendingEval = false;
        // Null bestmove = engine timeout / error — just unblock
        if (!msg.bestmove) {
          console.log("[chessbot] received null bestmove (engine timeout?)");
          return;
        }
        // If we just auto-moved and are waiting for the opponent, discard any
        // bestmove — it's a stale response from before our move.
        if (waitingForOpponent) {
          console.log("[chessbot] ignoring bestmove while waiting for opponent");
          return;
        }
        // Discard stale responses if the position has changed since we sent the eval.
        // Compare board position + turn so a result for white's turn is never applied
        // when it's now black's turn (and vice versa). Don't compare castling/en passant/
        // counters since those fields may differ between reads of the same position.
        const genAtReceive = renderGeneration;
        if (msg.fen && lastSentFen) {
          const rParts = msg.fen.split(" ");
          const sParts = lastSentFen.split(" ");
          if (rParts[0] !== sParts[0] || rParts[1] !== sParts[1]) {
            console.log("[chessbot] ignoring stale bestmove (position/turn changed)");
            return;
          }
        }
        console.log(`[chessbot] bestmove: ${msg.bestmove} (${msg.source})`);
        // Handle engine reporting no legal move
        if (!msg.bestmove || msg.bestmove === "(none)" || msg.bestmove === "0000") {
          console.log("[chessbot] no legal move available");
          clearArrow();
          pendingEval = false;
          return;
        }
        // Voice announce
        if (voiceEnabled) speakMove(msg);
        const source = msg.source || "engine";
        const lines = msg.lines || [];
        const bestLine = lines[0] || null;
        // Guard: if the board changed while we were processing, don't draw stale overlays
        if (genAtReceive !== renderGeneration) {
          console.log("[chessbot] board changed during bestmove processing — skipping draw");
          return;
        }
        if (trainingMode && !msg.streaming) {
          // Training mode: store best move, show progressive hint
          trainingBestMove = msg.bestmove;
          trainingLines = lines.slice(0, 3); // store top 3 for non-strict checking
          trainingLastFen = msg.fen || lastSentFen;
          // Set initial stage based on difficulty
          if (trainingDifficulty === "easy") {
            trainingStage = 1; // skip to zone hint
          } else if (trainingDifficulty === "hard") {
            trainingStage = 0; // piece hint but no hint button
          } else {
            trainingStage = 0; // medium: piece hint with 1 hint available
          }
          drawTrainingHint(msg.bestmove, bestLine, source);
          drawEvalBar(bestLine, source, msg.tablebase);
        } else if (lines.length > 1) {
          drawMultiPV(lines, source);
          drawEvalBar(bestLine, source, msg.tablebase);
        } else {
          drawSingleMove(msg.bestmove, bestLine, source);
          drawEvalBar(bestLine, source, msg.tablebase);
        }

        // Auto-move: schedule the move after drawing overlays (non-streaming only)
        // Suppress during variant switch cooldown — bestmove may be from old variant/engine
        if (autoMoveEnabled && !msg.streaming && msg.bestmove && msg.bestmove !== "(none)" && Date.now() >= variantSwitchUntil) {
          // Hard turn gate: verify it's actually our turn before scheduling.
          // This catches cases where the FEN turn was incorrectly corrected
          // (e.g. variant pages where turn detection failed and alternation guessed wrong).
          const moveFen = msg.fen || lastSentFen;
          const playerColor = getPlayerColor();
          const fenTurn = moveFen ? moveFen.split(" ")[1] : null;
          if (fenTurn && playerColor && fenTurn !== playerColor) {
            console.log(`[chessbot][auto-move] bestmove handler: not our turn (fen=${fenTurn} player=${playerColor}) — skipping`);
          } else {
            scheduleAutoMove(msg.bestmove, lines, moveFen);
          }
        }
      }
    } catch {
      // Malformed message — make sure we don't stay stuck
      pendingEval = false;
    }
  };

  ws.onclose = () => {
    console.log(`[chessbot] disconnected — retrying in ${Math.min(wsBackoff / 1000, 30)}s`);
    pendingEval = false; // unblock so we can resend on reconnect
    waitingForOpponent = false; // unblock board change detection
    _skipNextBoardChange = false;
    setTimeout(connectWS, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 1.5, 30000); // exponential backoff, max 30s
  };

  ws.onerror = (e) => {
    console.log(`[chessbot] WebSocket error (readyState=${ws.readyState})`);
  }; // onclose will fire next
}

function sendFen(fen) {
  if (trainingRevealActive) {
    console.log("[chessbot] sendFen skipped — auto-reveal active");
    return false;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log(`[chessbot] sendFen skipped — WS not open (state=${ws ? ws.readyState : "null"})`);
    return false;
  }
  // Ensure 3-check FEN always has check counters (fairy-stockfish misparses without them)
  if (detectedVariant === "3check") {
    const fenParts = fen.split(" ");
    if (fenParts.length === 6) {
      const counters = getThreeCheckCounters() || "3+3";
      fenParts.splice(4, 0, counters);
      fen = fenParts.join(" ");
      console.log(`[chessbot] injected 3check counters: ${counters}`);
    }
  }
  const msg = { type: "fen", fen, depth: bulletMode ? 15 : currentDepth };
  if (bulletMode) { msg.movetime = 2000; }
  else if (searchMovetime) msg.movetime = searchMovetime;
  if (searchNodes) msg.nodes = searchNodes;
  if (detectedVariant) msg.variant = detectedVariant;
  console.log(`[chessbot] → sendFen: ${fen.split(" ").slice(0,2).join(" ")} variant=${detectedVariant || "standard"} depth=${currentDepth}`);
  ws.send(JSON.stringify(msg));
  return true;
}

// ── Board DOM → FEN ──────────────────────────────────────────

/** Wait for the board element to appear (polling). */
function waitForBoard() {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      const el = getBoardElement();
      if (el) return resolve(el);
      attempts++;
      if (attempts % 10 === 0) {
        console.log(`[chessbot] waiting for board element... (attempt ${attempts})`);
      }
      // One-time DOM diagnostic at attempt 40 (~20s) if board still not found
      if (attempts === 40) {
        const dotPiece = document.querySelectorAll(".piece");
        const boardClasses = document.querySelectorAll("[class*='board']");
        console.log(`[chessbot] DOM diagnostic: .piece=${dotPiece.length} board-class=${boardClasses.length} iframes=${document.querySelectorAll("iframe").length} URL=${location.href}`);
      }
      setTimeout(check, 500);
    };
    check();
  });
}

// ── Game-over detection ──────────────────────────────────────

/** Detect whether the current game has ended by checking DOM indicators.
 *  Chess.com: game-over modal, result header, board "game-over" class.
 *  Lichess: result element, status "is ended", game-over classes.
 *  Returns true if the game is over. */
function detectGameOver() {
  if (SITE === "chesscom") {
    // Chess.com standard: game-over modal, result headers, board disabled state
    if (document.querySelector(
      ".game-over-modal, .modal-game-over-component, " +
      "[class*='game-over'], [class*='gameOver'], [class*='GameOver'], " +
      ".board-modal-container-container, " +
      ".game-result-header, [class*='game-result'], [class*='gameResult'], " +
      // Chess.com puts rematch/new-game buttons in specific containers
      "[class*='game-over'] button, [class*='gameOver'] button"
    )) return true;
    // Chess.com variant pages: result overlay or game-end text
    const resultTexts = document.querySelectorAll(
      "[class*='result'], [class*='Result'], [class*='endgame'], [class*='EndGame']"
    );
    for (const el of resultTexts) {
      const text = el.textContent.trim();
      if (/^(1-0|0-1|1\/2-1\/2|½-½)$/.test(text)) return true;
      if (/game over|checkmate|stalemate|resigned|time ?out|aborted|abandoned/i.test(text)) return true;
    }
    // Both clocks stopped with moves on the board = game ended
    const board = getBoardElement();
    if (board) {
      const bottomSel = ".clock-bottom .clock-running, .clock-bottom.clock-running, .clock-bottom [class*='active']";
      const topSel = ".clock-top .clock-running, .clock-top.clock-running, .clock-top [class*='active']";
      const anyClockRunning = document.querySelector(bottomSel) || document.querySelector(topSel);
      if (!anyClockRunning) {
        const hasMoves = document.querySelector(
          ".main-line-ply, [data-ply], move-list-ply, .move-text-component"
        );
        if (hasMoves) return true;
      }
    }
    return false;
  }
  if (IS_CHESSGROUND) {
    const status = document.querySelector(".status, .result-wrap, .game__status");
    if (status) {
      const text = status.textContent.trim();
      if (/game over|checkmate|stalemate|draw|resign|time out|abort|½|1-0|0-1/i.test(text)) return true;
    }
    if (document.querySelector(".rematch, .game__rematch")) return true;
    return false;
  }
  return false;
}

function getBoardElement() {
  if (SITE === "chesscom") {
    // Prefer the web component (which has shadowRoot) over the outer .board div
    const el = document.querySelector("wc-chess-board") ||
               document.querySelector("chess-board") ||
               document.querySelector(".board");
    if (el) return el;

    // Chess.com variant pages (Vue-based) use a different board container.
    // Find the element that contains piece children with [wb][prnbqk] classes.
    const variantBoard = findVariantBoardContainer();
    if (variantBoard) return variantBoard;

    // Chess.com variant pages may embed the game in an iframe
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) continue;
        const iframeEl = doc.querySelector("wc-chess-board") ||
                         doc.querySelector("chess-board") ||
                         doc.querySelector(".board");
        if (iframeEl) return iframeEl;
      } catch { /* cross-origin — skip */ }
    }
    return null;
  }
  if (IS_CHESSGROUND) {
    return document.querySelector("cg-board");
  }
  if (SITE === "chesstempo") {
    // ChessTempo uses a <chess-board> custom element (no shadow root)
    // Return the inner board holder for correct geometry
    const ct = document.querySelector("chess-board");
    if (ct) {
      return ct.querySelector(".ct-board-inner-holder") || ct.querySelector(".ct-board-holder") || ct;
    }
    return null;
  }
  return null;
}

/** Chess.com variant pages use a Vue-based board with different selectors.
 *  Find the board container by looking for known variant-page class patterns,
 *  or by finding the element whose children include chess piece divs. */
function findVariantBoardContainer() {
  // Known variant-page board selectors (chess.com Vue app)
  const candidates = [
    "[class*='TheBoard']",
    ".TheBoard-boardCenter",
    "[class*='board-container']",
    "[class*='board-wrapper']",
    "[class*='container-four-board-container']",
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (!el) continue;
    // Verify this element (or descendants) actually contains piece-like elements
    const hasPieces = el.querySelector(".piece, [class*=' wp '], [class*=' bp '], [class*='square-']") ||
                      el.querySelectorAll("[class]").length > 5;
    if (hasPieces || el.getBoundingClientRect().width > 100) {
      return el;
    }
  }
  // Last resort: look for the parent of piece elements
  const pieces = document.querySelectorAll(".piece");
  if (pieces.length >= 2) {
    // Find the closest common ancestor that looks like a board (roughly square)
    let parent = pieces[0].parentElement;
    while (parent && parent !== document.body) {
      const rect = parent.getBoundingClientRect();
      const ratio = rect.width / rect.height;
      if (ratio > 0.8 && ratio < 1.2 && rect.width > 100) {
        return parent;
      }
      parent = parent.parentElement;
    }
  }
  return null;
}

/** Watch for board changes via MutationObserver + polling fallback.
 *  Chess.com uses a web-component (<wc-chess-board>) whose shadow-DOM
 *  mutations may not bubble to an external observer, so we also poll. */
let pollTimer = null;
let lastMutationTime = 0; // timestamp of last real board mutation
let observedBoardEl = null; // the board element the observer is currently watching
let nullFenCount = 0; // consecutive boardToFen() null returns — for recovery

function observeBoard(boardEl) {
  observedBoardEl = boardEl;
  if (observer) observer.disconnect();
  if (pollTimer) clearInterval(pollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);

  // MutationObserver — catches changes that DO bubble
  observer = new MutationObserver((mutations) => {
    if (!enabled) return;
    // Ignore mutations caused by our own overlays
    const dominated = mutations.every((m) => {
      const t = m.target;
      if (t.id && t.id.startsWith("chessbot-")) return true;
      if (t.classList && t.classList.contains("chessbot-eval-badge")) return true;
      if (t.closest && t.closest("#chessbot-arrow-svg, #chessbot-bg-svg, #chessbot-eval-bar, .chessbot-eval-badge")) return true;
      // Also check addedNodes/removedNodes — appending/removing our badges
      // triggers childList mutations whose target is the parent (board), not
      // the badge itself, so the checks above miss them.
      if (m.type === "childList") {
        const allOwn = [...m.addedNodes, ...m.removedNodes].every(
          n => n.nodeType !== 1 || (n.id && n.id.startsWith("chessbot-")) ||
               (n.classList && (n.classList.contains("chessbot-eval-badge") ||
                n.classList.contains("chessbot-score-badge") ||
                n.classList.contains("chessbot-hint-btn") ||
                n.classList.contains("chessbot-training-feedback")))
        );
        if (allOwn && m.addedNodes.length + m.removedNodes.length > 0) return true;
      }
      return false;
    });
    if (dominated) return;
    lastMutationTime = Date.now();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(readAndSend, bulletMode ? 150 : 400);
  });

  // Observe the board element AND its shadow root if available
  const targets = [boardEl];
  if (boardEl.shadowRoot) targets.push(boardEl.shadowRoot);
  for (const target of targets) {
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "data-piece", "transform"],
    });
  }

  // Drag detection — suppress board reads while user is holding a piece
  // Document-level handlers (mouseup/touchend) are added only once;
  // board-specific handlers (mousedown/touchstart) re-attach on new board.
  if (!documentDragHandlersAttached) {
    documentDragHandlersAttached = true;
    document.addEventListener("mouseup", (e) => {
      if (!isDragging) return;
      isDragging = false;
      setTimeout(() => { if (enabled && boardReady) readAndSend(); }, 150);
    }, true);
    document.addEventListener("touchend", () => {
      if (!isDragging) return;
      isDragging = false;
      setTimeout(() => { if (enabled && boardReady) readAndSend(); }, 150);
    }, true);
  }
  if (!boardEl.dataset.chessbotDragBound) {
    boardEl.dataset.chessbotDragBound = "1";
    const dragTarget = boardEl.shadowRoot || boardEl;
    dragTarget.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      isDraggingSince = Date.now();
    }, true);
    dragTarget.addEventListener("touchstart", () => { isDragging = true; isDraggingSince = Date.now(); }, true);
  }

  // Polling fallback — skip if mutations are actively firing, use longer interval
  let pollCount = 0;
  pollTimer = setInterval(() => {
    if (!enabled || !boardReady) return;
    // Skip poll if a recent mutation already triggered readAndSend
    if (Date.now() - lastMutationTime < 300) return;
    // Periodic heartbeat every ~30s so we can confirm script is alive
    pollCount++;
    if (pollCount % 38 === 0) {
      console.log(`[chessbot] heartbeat: boardReady=${boardReady} drag=${isDragging} pending=${pendingEval} lastTurn=${lastKnownTurn} waiting=${waitingForOpponent} nullFen=${nullFenCount} lastBoard=${lastBoardFen.substring(0,20)}…`);
    }
    try {
      // Verify the board element is still in the DOM (SPA navigation)
      const currentBoard = getBoardElement();
      if (!currentBoard) {
        console.log("[chessbot] board disappeared (navigation?), searching again");
        boardReady = false;
        observedBoardEl = null;
        if (observer) observer.disconnect();
        clearInterval(pollTimer);
        clearArrow();
        lastBoardFen = "";
        lastSentFen = "";
        lastPieceCount = 0;
        findBoard();
        return;
      }

      // Board element changed (Vue re-render, SPA navigation) — re-attach observer
      if (observedBoardEl && currentBoard !== observedBoardEl) {
        console.log("[chessbot] board element replaced — re-attaching observer");
        observedBoardEl = currentBoard;
        if (observer) observer.disconnect();
        observer = new MutationObserver((mutations) => {
          if (!enabled) return;
          const dominated = mutations.every((m) => {
            const t = m.target;
            if (t.id && t.id.startsWith("chessbot-")) return true;
            if (t.classList && t.classList.contains("chessbot-eval-badge")) return true;
            if (t.closest && t.closest("#chessbot-arrow-svg, #chessbot-bg-svg, #chessbot-eval-bar, .chessbot-eval-badge")) return true;
            if (m.type === "childList") {
              const allOwn = [...m.addedNodes, ...m.removedNodes].every(
                n => n.nodeType !== 1 || (n.id && n.id.startsWith("chessbot-")) ||
                     (n.classList && (n.classList.contains("chessbot-eval-badge") ||
                      n.classList.contains("chessbot-score-badge") ||
                      n.classList.contains("chessbot-hint-btn") ||
                      n.classList.contains("chessbot-training-feedback")))
              );
              if (allOwn && m.addedNodes.length + m.removedNodes.length > 0) return true;
            }
            return false;
          });
          if (dominated) return;
          lastMutationTime = Date.now();
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(readAndSend, bulletMode ? 150 : 400);
        });
        const targets = [currentBoard];
        if (currentBoard.shadowRoot) targets.push(currentBoard.shadowRoot);
        for (const target of targets) {
          observer.observe(target, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ["class", "style", "data-piece", "transform"],
          });
        }
        // Reset drag binding for new element
        if (!currentBoard.dataset.chessbotDragBound) {
          currentBoard.dataset.chessbotDragBound = "1";
          const dragTarget = currentBoard.shadowRoot || currentBoard;
          dragTarget.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            isDragging = true;
            isDraggingSince = Date.now();
          }, true);
          dragTarget.addEventListener("touchstart", () => { isDragging = true; isDraggingSince = Date.now(); }, true);
        }
        // Reset board reader state for new element
        _variantColorMap = null;
        _variantColorMapKey = null;
        _geoCache = null;
        chesscomBoardToFen._diagLogged = false;
        nullFenCount = 0;
      }

      readAndSend();
    } catch (err) {
      console.log("[chessbot] poll error:", err);
    }
  }, 800);
}

/** Check if the board currently has premove ghost/indicator elements. */
function hasPremoveElements() {
  if (SITE === "chesscom") {
    const board = getBoardElement();
    if (!board) return false;
    // Check both regular DOM and shadow root for ghost or premove elements
    const roots = [board];
    if (board.shadowRoot) roots.push(board.shadowRoot);
    for (const root of roots) {
      if (root.querySelector(".ghost, .premove, [class*='ghost'], [class*='premove']")) return true;
      // Also check for semi-transparent pieces (opacity < 0.5) as premove indicator
      const els = root.querySelectorAll(".piece");
      for (const el of els) {
        if (parseFloat(getComputedStyle(el).opacity) < 0.5) return true;
      }
    }
    return false;
  }
  if (IS_CHESSGROUND) {
    const board = document.querySelector("cg-board");
    if (!board) return false;
    // Lichess/PlayStrategy marks premoved squares and ghost pieces
    if (board.querySelector("piece.ghost, square.premove, .premove")) return true;
    return false;
  }
  return false;
}

function countPieces(boardFen) {
  let n = 0;
  // Strip pocket notation [...] before counting
  const cleaned = boardFen.replace(/\[.*?\]$/g, "");
  for (const ch of cleaned) {
    if (ch !== "/" && ch !== "+" && ch !== "~" && (ch < "0" || ch > "9")) n++;
  }
  return n;
}

function readAndSend() {
  if (!boardReady) return;

  // Check if the game has ended — stop analyzing and auto-moving
  if (detectGameOver()) {
    if (!gameOver) {
      gameOver = true;
      console.log("[chessbot] game over detected — stopping analysis");
      cancelAutoMove();
      clearMoveIndicators();
      pendingEval = false;
      waitingForOpponent = false;
      _skipNextBoardChange = false;
      lastSentFen = "";
    }
    return;
  }
  // Game was over but now it's not (new game started on same page)
  if (gameOver) {
    gameOver = false;
    console.log("[chessbot] game resumed / new game — re-enabling analysis");
  }

  // Safety valve: if isDragging has been stuck for >5s, force-clear it
  if (isDragging && isDraggingSince && (Date.now() - isDraggingSince > 5000)) {
    console.log("[chessbot] isDragging stuck for >5s — force-clearing");
    isDragging = false;
  }
  if (isDragging) return; // user is holding a piece — wait for drop

  // Client-side eval timeout: if we've been waiting too long for a response,
  // reset state so we can re-analyze on the next board change
  if (pendingEval && evalSentAt && currentDepth !== 0 && (Date.now() - evalSentAt > getEvalTimeout())) {
    console.log(`[chessbot] eval timeout (${getEvalTimeout()}ms) — resetting state`);
    pendingEval = false;
    lastSentFen = "";
    waitingForOpponent = false; // unblock so board changes trigger re-analysis
  }

  const fen = boardToFen();
  if (!fen) {
    // Track consecutive null reads — if persistent, the board DOM may have changed
    nullFenCount++;
    if (nullFenCount === 5) {
      console.log("[chessbot] boardToFen() returned null 5 times — logging diagnostics");
      const board = getBoardElement();
      if (board) {
        const tag = board.tagName;
        const cls = (board.className || "").toString().substring(0, 80);
        const rect = board.getBoundingClientRect();
        const pieces = board.querySelectorAll(".piece, [data-piece]");
        console.log(`[chessbot] board: <${tag}> class="${cls}" rect=${Math.round(rect.width)}x${Math.round(rect.height)} pieces=${pieces.length} inDOM=${document.body.contains(board)}`);
      } else {
        console.log("[chessbot] getBoardElement() also returned null");
      }
    }
    if (nullFenCount >= 15) {
      console.log("[chessbot] boardToFen() null for 15 cycles — re-finding board");
      nullFenCount = 0;
      boardReady = false;
      observedBoardEl = null;
      if (observer) observer.disconnect();
      if (pollTimer) clearInterval(pollTimer);
      lastBoardFen = "";
      lastSentFen = "";
      lastPieceCount = 0;
      findBoard();
    }
    return;
  }
  nullFenCount = 0; // successful read — reset counter

  const boardPart = fen.split(" ")[0];

  // Board hasn't changed — skip
  if (boardPart === lastBoardFen) {
    // If we're waiting for the opponent, don't re-analyze the same position
    if (waitingForOpponent || lastSentFen) return;
  } else {
    // Board position changed — clear failed-move tracker so auto-move can try new positions
    _autoMoveFailedFen = "";

    // Board actually changed. If we just auto-moved, the first board change
    // is our own move being applied — skip analysis and keep waiting.
    if (_skipNextBoardChange) {
      _skipNextBoardChange = false;
      console.log("[chessbot] board changed after auto-move — skipping own move, waiting for opponent");
      lastBoardFen = boardPart;
      lastPieceCount = countPieces(boardPart);
      return;
    }
    waitingForOpponent = false;
  }

  // Animation guard: if piece count dropped by more than threshold, a piece is
  // likely mid-flight (temporarily off both squares). Standard threshold of 2
  // allows en passant. For atomic chess, explosions can remove up to 9 pieces
  // in a single capture, so we use a much higher threshold.
  const pieceCount = countPieces(boardPart);
  const animThreshold = detectedVariant === "atomic" ? 10 : 2;
  if (lastPieceCount > 0 && pieceCount < lastPieceCount - animThreshold) {
    console.log(`[chessbot] piece count dropped ${lastPieceCount}→${pieceCount}, likely mid-animation — skipping`);
    // DON'T update lastBoardFen here — we want the next stable read to see
    // the real diff from the last confirmed position (prevents double-alternation)
    lastPieceCount = pieceCount;
    return;
  }

  console.log(`[chessbot] board change detected (pieces=${pieceCount})`);
  const prevBoard = lastBoardFen;
  lastBoardFen = boardPart;
  lastPieceCount = pieceCount;
  renderGeneration++; // new position — invalidate any in-flight responses
  const myGen = renderGeneration;

  // Training mode: check if user's move matched the engine suggestion
  if (trainingMode && trainingBestMove) {
    checkTrainingAccuracy(fen);
  }

  // Detect new game: standard starting position, variant starting position,
  // or piece count jumped significantly upward (board reset).
  // Strip pocket notation [...] before comparing (Crazyhouse appends e.g. "[]")
  const boardPartNoPocket = boardPart.replace(/\[.*?\]$/, "");
  const isStandardStart = boardPartNoPocket === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
  const variantStartFen = detectedVariant && VARIANT_START_FENS[detectedVariant];
  const isVariantStart = variantStartFen && boardPartNoPocket === variantStartFen;
  const isStartPos = isStandardStart || isVariantStart;
  const prevPieceCount = prevBoard ? countPieces(prevBoard) : 0;
  const pieceCountJump = prevPieceCount > 0 && pieceCount - prevPieceCount >= 10;
  if (isStartPos || pieceCountJump) {
    console.log("[chessbot] new game detected — resetting state");
    gameOver = false;
    waitingForOpponent = false;
    lastSentFen = "";
    lastKnownTurn = null;
    lastSpokenMove = "";
    lastSpokenOpening = "";
    _variantColorMap = null;
    _variantColorMapKey = null;
    _cachedPlayerColor = null; // reset so flip detection re-runs for new game
    _geoCache = null; // force geometry recomputation with fresh flip detection
    _skipNextBoardChange = false;
    // Reset training state so hints from previous game don't leak
    trainingBestMove = null;
    trainingLastFen = "";
    trainingStage = 0;
    trainingLines = [];
    trainingRevealActive = false;
    cancelAutoMove();
    autoMoveCooldownUntil = 0;
    _autoMoveFailedFen = "";
    if (detectedVariant === "3check") threeCheckRemaining = { w: 3, b: 3 };
  }

  // Determine whose turn it is by diffing board positions
  const turn = inferTurn(prevBoard, boardPart);
  const playerColor = getPlayerColor();

  console.log(`[chessbot] turn=${turn} player=${playerColor}`);

  // If turn detection failed entirely, use heuristic:
  // - Starting position → always white's turn
  // - Otherwise skip and wait for next poll
  if (!turn) {
    if (isStartPos) {
      // Starting position is definitely white's turn
      console.log("[chessbot] starting position — assuming white's turn");
    } else if (lastKnownTurn) {
      // All detection methods failed — alternate from last known turn
      const altTurn = lastKnownTurn === "w" ? "b" : "w";
      console.log(`[chessbot] turn unknown — alternating from last known ${lastKnownTurn} → ${altTurn}`);
      lastKnownTurn = altTurn;
    } else {
      // No lastKnownTurn — use player color as fallback instead of blocking forever
      const fallback = playerColor || "w";
      console.log(`[chessbot] turn unknown — using player color fallback: ${fallback}`);
      lastKnownTurn = fallback;
    }
  }

  // Effective turn: use detected turn, alternation fallback, or "w" for starting position
  const effectiveTurn = turn || lastKnownTurn || "w";
  if (turn) lastKnownTurn = turn;

  // 3-check: track check counts by detecting king-in-check from FEN
  if (detectedVariant === "3check" && prevBoard && boardPart !== prevBoard) {
    // effectiveTurn = side that now has to move (their king may be in check)
    if (isKingInCheck(boardPart, effectiveTurn)) {
      const checker = effectiveTurn === "w" ? "b" : "w";
      threeCheckRemaining[checker] = Math.max(0, threeCheckRemaining[checker] - 1);
      console.log(`[chessbot] 3check: ${checker} gave check! remaining: w=${threeCheckRemaining.w} b=${threeCheckRemaining.b}`);
    }
  }

  // Only show move suggestions based on runEngineFor setting
  // On puzzle pages, always analyze regardless of turn
  const isMyTurn = effectiveTurn === playerColor;
  const onPuzzle = isPuzzlePage();
  const shouldAnalyze =
    onPuzzle ||
    runEngineFor === "both" ||
    (runEngineFor === "me" && isMyTurn) ||
    (runEngineFor === "opponent" && !isMyTurn);

  if (!shouldAnalyze) {
    clearMoveIndicators(); // clear stale move suggestions, keep eval bar
    lastSentFen = ""; // reset so we re-analyse when appropriate turn arrives
    waitingForOpponent = true; // don't re-analyze until board changes
    pendingEval = false;
    cancelAutoMove(); // cancel any pending auto-move — it's not our turn
    return;
  }

  // Build FEN with correct side-to-move
  const parts = fen.split(" ");
  parts[1] = effectiveTurn;
  const correctedFen = parts.join(" ");

  if (correctedFen === lastSentFen) return;
  pendingEval = true;
  evalSentAt = Date.now();
  console.log(`[chessbot] → FEN: ${correctedFen}`);
  clearMoveIndicators();
  if (sendFen(correctedFen)) {
    lastSentFen = correctedFen;
  } else {
    pendingEval = false;
  }
}

// ── Chess.com board reader ───────────────────────────────────

/** On chess.com variant pages, the board wrapper (TheBoard-layers) may have 0x0
 *  dimensions. The visual rect comes from a child element like TheBoard-boardCenter.
 *  This helper finds the actual visible board rect. */
function getVisualBoardRect(board) {
  let rect = board.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return rect;
  // Variant page: try known child elements that carry the real dimensions
  const sizeChildren = [
    board.querySelector("[class*='boardCenter'], [class*='BoardCenter']"),
    board.querySelector("[class*='squares'], [class*='Squares']"),
    board.querySelector("[class*='pieces'], [class*='Pieces']"),
  ];
  for (const child of sizeChildren) {
    if (!child) continue;
    const cr = child.getBoundingClientRect();
    if (cr.width > 0 && cr.height > 0) return cr;
  }
  // Last resort: find any child with square-ish non-zero dimensions
  for (const child of board.children) {
    const cr = child.getBoundingClientRect();
    if (cr.width > 50 && cr.height > 50) {
      const ratio = cr.width / cr.height;
      if (ratio > 0.8 && ratio < 1.2) return cr;
    }
  }
  return rect; // still 0x0 — caller handles null
}

// Cache for variant page color mapping (data-color value → 'w'/'b')
let _variantColorMap = null;
let _variantColorMapKey = null;

function buildVariantColorMap(pieces, boardRect, flipped) {
  // Group pieces by data-color and compute average Y position
  // Only consider pieces whose center is within the board area
  const groups = {};
  for (const p of pieces) {
    const dc = p.getAttribute("data-color");
    if (!dc) continue;
    const r = p.getBoundingClientRect();
    if (r.height === 0) continue;
    const cx = r.left + r.width / 2 - boardRect.left;
    const cy = r.top + r.height / 2 - boardRect.top;
    // Skip pieces outside the board area (bank/captured pieces)
    if (cx < -5 || cx > boardRect.width + 5 || cy < -5 || cy > boardRect.height + 5) continue;
    if (!groups[dc]) groups[dc] = { sumY: 0, count: 0 };
    groups[dc].sumY += cy;
    groups[dc].count++;
  }
  const keys = Object.keys(groups);
  if (keys.length === 2) {
    const avg0 = groups[keys[0]].sumY / groups[keys[0]].count;
    const avg1 = groups[keys[1]].sumY / groups[keys[1]].count;
    // Higher avg Y = bottom of visual board
    const bottomKey = avg0 > avg1 ? keys[0] : keys[1];
    const topKey = avg0 > avg1 ? keys[1] : keys[0];
    // Non-flipped: bottom = white; flipped: bottom = black
    const whiteKey = flipped ? topKey : bottomKey;
    const blackKey = flipped ? bottomKey : topKey;
    return { white: whiteKey, black: blackKey };
  }
  // Fallback: try literal color names, then sort numerically, lower = white
  const keysLower = keys.map(k => k.toLowerCase());
  if (keysLower.includes("white") || keysLower.includes("w")) {
    const wk = keys[keysLower.indexOf("white")] || keys[keysLower.indexOf("w")];
    const bk = keys.find(k => k !== wk) || keys[0];
    return { white: wk, black: bk };
  }
  if (keysLower.includes("black") || keysLower.includes("b")) {
    const bk = keys[keysLower.indexOf("black")] || keys[keysLower.indexOf("b")];
    const wk = keys.find(k => k !== bk) || keys[0];
    return { white: wk, black: bk };
  }
  keys.sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    if (isNaN(na) || isNaN(nb)) return a < b ? -1 : a > b ? 1 : 0;
    return na - nb;
  });
  return { white: keys[0], black: keys[1] || keys[0] };
}

function chesscomBoardToFen() {
  const board = getBoardElement();
  if (!board) return null;

  // Chess.com renders pieces in various ways depending on version.
  // Try every known method to find them.
  let pieces = findChesscomPieces(board);
  if (!pieces || !pieces.length) return null;

  const boardRect = getVisualBoardRect(board);
  if (boardRect.width === 0) return null;
  const squareW = boardRect.width / 8;
  const squareH = boardRect.height / 8;
  const flipped = isChesscomFlipped(board);

  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  let found = 0;
  const isDropVariant = detectedVariant && DROP_VARIANTS.has(detectedVariant);
  let whitePocket = "";
  let blackPocket = "";

  for (const piece of pieces) {
    const classes = typeof piece.className === "string" ? piece.className : (piece.getAttribute("class") || "");

    // Skip ghost/premove pieces — chess.com adds these for premove visualization
    if (/\bghost\b/.test(classes)) continue;
    // Also skip pieces with very low opacity (premove ghosts are semi-transparent)
    const opacity = parseFloat(getComputedStyle(piece).opacity);
    if (opacity < 0.5) continue;

    // Get piece type — Method A: class like "bb", "wp", "bk", etc.
    let fenChar;
    let color; // 'w' or 'b'
    const pieceMatch = classes.match(/\b([wb][prnbqk])\b/);
    if (pieceMatch) {
      color = pieceMatch[1][0];
      const type = pieceMatch[1][1];
      fenChar = color === "w" ? type.toUpperCase() : type.toLowerCase();
    } else {
      // Method B: data-piece + data-color (variant pages)
      const dp = piece.getAttribute("data-piece");
      const dc = piece.getAttribute("data-color");
      if (!dp || !dc) continue;
      const type = dp.toLowerCase();
      if (!/^[prnbqk]$/.test(type)) continue;
      // Build color map once per call (uses position heuristic)
      const mapKey = `${boardRect.left},${boardRect.top},${flipped}`;
      if (!_variantColorMap || _variantColorMapKey !== mapKey) {
        _variantColorMap = buildVariantColorMap(pieces, boardRect, flipped);
        _variantColorMapKey = mapKey;
      }
      const isWhite = (dc === _variantColorMap.white);
      color = isWhite ? "w" : "b";
      fenChar = isWhite ? type.toUpperCase() : type.toLowerCase();
    }

    // Primary: use visual position via getBoundingClientRect (always up-to-date)
    const pieceRect = piece.getBoundingClientRect();
    if (pieceRect.width > 0 && squareW > 0) {
      const cx = pieceRect.left + pieceRect.width / 2 - boardRect.left;
      const cy = pieceRect.top + pieceRect.height / 2 - boardRect.top;
      // Pieces outside the board area are pocket/bank pieces in drop variants
      if (cx < -5 || cx > boardRect.width + 5 || cy < -5 || cy > boardRect.height + 5) {
        if (isDropVariant && fenChar) {
          // Count this as a pocket piece — check for a count indicator
          const countEl = piece.querySelector("[class*='count'], [class*='Count'], [class*='badge']");
          const countText = countEl ? countEl.textContent.trim() : "";
          const count = parseInt(countText) || 1;
          for (let i = 0; i < count; i++) {
            if (color === "w") whitePocket += fenChar;
            else blackPocket += fenChar;
          }
        }
        continue;
      }
      let visFile = Math.floor(cx / squareW);
      let visRank = Math.floor(cy / squareH);
      visFile = Math.max(0, Math.min(7, visFile));
      visRank = Math.max(0, Math.min(7, visRank));

      // Convert visual position to board coordinates
      const file = flipped ? 7 - visFile : visFile;
      const rank = flipped ? visRank : 7 - visRank;
      grid[7 - rank][file] = fenChar;
      found++;
      continue;
    }

    // Fallback: use square-XY class
    const sqMatch = classes.match(/\bsquare-(\d)(\d)\b/);
    if (sqMatch) {
      const file = parseInt(sqMatch[1], 10) - 1;
      const rank = parseInt(sqMatch[2], 10) - 1;
      grid[7 - rank][file] = fenChar;
      found++;
    }
  }

  if (found < 2) {
    // Diagnostic: if we found pieces but couldn't match types, log full element details
    if (pieces.length >= 2 && found === 0 && !chesscomBoardToFen._diagLogged) {
      chesscomBoardToFen._diagLogged = true;
      for (let i = 0; i < Math.min(4, pieces.length); i++) {
        const p = pieces[i];
        const cls = typeof p.className === "string" ? p.className : (p.getAttribute("class") || "");
        const bg = getComputedStyle(p).backgroundImage || "";
        const attrs = Array.from(p.attributes).map(a => `${a.name}="${a.value}"`).join(" ");
        console.log(`[chessbot] piece[${i}]: <${p.tagName} ${attrs}> bg=${bg.substring(0, 120)}`);
      }
    }
    return null;
  }
  const pocket = isDropVariant ? "[" + whitePocket + blackPocket + "]" : readPocket();
  if (isDropVariant) {
    if (whitePocket || blackPocket) {
      console.log(`[chessbot] pocket: ${pocket} (${pieces.length} total pieces, ${found} on board)`);
    } else if (found < pieces.length) {
      // Some pieces are off-board but we didn't categorise them as pocket pieces
      // — try DOM-scanning fallback
      const scannedPocket = scanChesscomPocketDOM(board, flipped);
      if (scannedPocket && scannedPocket !== "[]") {
        console.log(`[chessbot] pocket (DOM scan): ${scannedPocket}`);
        const fen = gridToFenBoard(grid, scannedPocket);
        const boardPart2 = fen.split(" ")[0].replace(/\[.*?\]/, "");
        const wK2 = (boardPart2.match(/K/g) || []).length;
        const bK2 = (boardPart2.match(/k/g) || []).length;
        const isVar = !!detectedVariant && detectedVariant !== "chess960";
        if (isVar || (wK2 === 1 && bK2 === 1)) return fen;
      }
      if (!chesscomBoardToFen._pocketWarnLogged) {
        chesscomBoardToFen._pocketWarnLogged = true;
        console.warn(`[chessbot] drop variant "${detectedVariant}" but no pocket pieces found (${pieces.length} total pieces, ${found} on board)`);
      }
    }
    // else: all pieces are on the board → empty pocket is expected (game start / no captures yet)
  }
  const fen = gridToFenBoard(grid, pocket);
  // Validate king counts (only in the board portion, before castling rights)
  // Strip pocket notation [xxx] before checking
  const boardPart = fen.split(" ")[0].replace(/\[.*?\]/, "");
  const whiteKings = (boardPart.match(/K/g) || []).length;
  const blackKings = (boardPart.match(/k/g) || []).length;
  // In variants, king counts can differ from standard chess:
  // Three Kings: 3 white kings, Horde: 0 black king, Atomic: kings destroyed, etc.
  const isVariant = !!detectedVariant && detectedVariant !== "chess960";
  const isAtomic = detectedVariant === "atomic";
  const validW = isVariant || isAtomic ? true : whiteKings === 1;
  const validB = isVariant || isAtomic ? true : blackKings === 1;
  if (!validW || !validB) {
    console.log(`[chessbot] invalid FEN: K=${whiteKings} k=${blackKings} — ${fen.substring(0, 60)}`);
    _variantColorMap = null; // force re-build of color map
    return null;
  }
  return fen;
}

function isChesscomFlipped(board) {
  // If player color was already locked (reliable detection at game start),
  // derive flip state from it — avoids unreliable piece-position heuristics
  // in endgames with few pieces (e.g. giveaway with 3 pieces left).
  if (_cachedPlayerColor) return _cachedPlayerColor === "b";

  // Method 1: JS property on the custom element (wc-chess-board exposes this)
  try {
    if (board.isFlipped === true || board.flipped === true) return true;
    if (board.isFlipped === false || board.flipped === false) return false;
  } catch (_) {}

  // Method 2: "flipped" class on board element
  if (board.classList.contains("flipped")) return true;
  // Method 3: "flipped" attribute
  if (board.getAttribute("flipped") !== null) return true;

  // Method 4: Shadow DOM flipped indicator
  const root = board.shadowRoot;
  if (root) {
    const inner = root.querySelector("[class*='flipped'], [flipped]");
    if (inner) return true;
  }

  // Method 4b: Ancestor elements with flip indicator
  // On variant pages the board container may not carry the "flipped" class,
  // but a wrapper higher in the DOM might.
  let ancestor = board.parentElement;
  for (let i = 0; i < 5 && ancestor && ancestor !== document.body; i++) {
    const acls = typeof ancestor.className === "string" ? ancestor.className : (ancestor.getAttribute("class") || "");
    if (/\bflipped\b/i.test(acls) || ancestor.getAttribute("flipped") !== null) return true;
    ancestor = ancestor.parentElement;
  }

  // Method 5: Coordinate labels — both in regular DOM and shadow DOM
  const searchRoots = [document];
  if (root) searchRoots.push(root);
  for (const sr of searchRoots) {
    const coords = sr.querySelectorAll(
      ".coordinates-row, .coords-row, .coords-files, coords-files, [class*='coord'], [class*='Coord'], [class*='notation'], [class*='files'], [class*='ranks']"
    );
    for (const c of coords) {
      const txt = c.textContent.trim();
      if (txt.startsWith("h")) return true;
      if (txt.startsWith("a")) return false;
    }
  }

  // Method 5b: Scan individual text/label elements near the board for file letters
  const boardRect5 = getVisualBoardRect(board);
  if (boardRect5.width > 0) {
    const labelRoots = [board.parentElement, board];
    if (root) labelRoots.push(root);
    for (const lr of labelRoots) {
      if (!lr) continue;
      const labels = lr.querySelectorAll("text, span, div");
      for (const el of labels) {
        if (el.children.length > 0) continue; // only leaf nodes
        const txt = el.textContent.trim();
        if (txt !== "a" && txt !== "h") continue;
        const elRect = el.getBoundingClientRect();
        if (elRect.width === 0) continue;
        const relX = elRect.left + elRect.width / 2 - boardRect5.left;
        // Only trust labels near the left or right edge of the board
        if (relX < boardRect5.width * 0.15) {
          return txt === "h"; // h on left = flipped
        }
        if (relX > boardRect5.width * 0.85) {
          return txt === "a"; // a on right = flipped
        }
      }
    }
  }

  // Method 6: Compare average Y position of white vs black pieces.
  // On a non-flipped board, white pieces are near the bottom (high Y).
  // On a flipped board, white pieces are near the top (low Y).
  // This is the most robust fallback — works regardless of DOM structure.
  const pieces = findChesscomPieces(board);
  if (pieces && pieces.length >= 4) {
    const boardRect = getVisualBoardRect(board);
    if (boardRect.height > 0) {
      let whiteSumY = 0, whiteCount = 0;
      let blackSumY = 0, blackCount = 0;
      for (const piece of pieces) {
        const cls = typeof piece.className === "string"
          ? piece.className
          : (piece.getAttribute("class") || "");
        const m = cls.match(/\b([wb])[prnbqk]\b/);
        if (!m) continue;
        const r = piece.getBoundingClientRect();
        if (r.height === 0) continue;
        const cy = r.top + r.height / 2 - boardRect.top;
        if (m[1] === "w") { whiteSumY += cy; whiteCount++; }
        else { blackSumY += cy; blackCount++; }
      }
      if (whiteCount >= 2 && blackCount >= 2) {
        const whiteAvgY = whiteSumY / whiteCount;
        const blackAvgY = blackSumY / blackCount;
        // White avg Y < black avg Y → white is higher on screen → board is flipped
        return whiteAvgY < blackAvgY;
      }

      // Method 6b: data-color grouping for variant pages
      // When class-based [wb] matching fails, use data-color attribute
      const dcGroups = {};
      for (const piece of pieces) {
        const dc = piece.getAttribute("data-color");
        if (!dc) continue;
        const r = piece.getBoundingClientRect();
        if (r.height === 0) continue;
        const cy = r.top + r.height / 2 - boardRect.top;
        // Skip pieces outside the board area
        const pcx = r.left + r.width / 2 - boardRect.left;
        if (pcx < -5 || pcx > boardRect.width + 5 || cy < -5 || cy > boardRect.height + 5) continue;
        if (!dcGroups[dc]) dcGroups[dc] = { sumY: 0, count: 0 };
        dcGroups[dc].sumY += cy;
        dcGroups[dc].count++;
      }
      const dcKeys = Object.keys(dcGroups);
      if (dcKeys.length === 2) {
        // Determine which data-color = white.
        // First check if data-color values are literal color names.
        const dcLower = dcKeys.map(k => k.toLowerCase());
        let whiteKey, blackKey;
        if (dcLower.includes("white")) {
          whiteKey = dcKeys[dcLower.indexOf("white")];
          blackKey = dcKeys.find(k => k !== whiteKey);
        } else if (dcLower.includes("black")) {
          blackKey = dcKeys[dcLower.indexOf("black")];
          whiteKey = dcKeys.find(k => k !== blackKey);
        } else if (dcLower.includes("w")) {
          whiteKey = dcKeys[dcLower.indexOf("w")];
          blackKey = dcKeys.find(k => k !== whiteKey);
        } else if (dcLower.includes("b")) {
          blackKey = dcKeys[dcLower.indexOf("b")];
          whiteKey = dcKeys.find(k => k !== blackKey);
        } else {
          // Numeric or opaque values — sort numerically, lower = white (convention)
          const sorted = [...dcKeys].sort((a, b) => {
            const na = parseInt(a), nb = parseInt(b);
            if (isNaN(na) || isNaN(nb)) return a < b ? -1 : a > b ? 1 : 0;
            return na - nb;
          });
          whiteKey = sorted[0];
          blackKey = sorted[1];
        }
        const whiteAvgDC = dcGroups[whiteKey].sumY / dcGroups[whiteKey].count;
        const blackAvgDC = dcGroups[blackKey].sumY / dcGroups[blackKey].count;
        // If white has lower avgY → white at top → flipped
        return whiteAvgDC < blackAvgDC;
      }
    }
  }

  return false;
}

/** Filter out ghost/premove elements from a NodeList of pieces. */
function filterGhostPieces(pieces) {
  return Array.from(pieces).filter(el => {
    const cls = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
    // chess.com ghost pieces: class contains "ghost", "premove", or "dragging"
    if (/\b(ghost|premove)\b/i.test(cls)) return false;
    return true;
  });
}

/** Try every known way to find chess.com piece elements. */
function findChesscomPieces(board) {
  const isDropVar = detectedVariant && DROP_VARIANTS.has(detectedVariant);

  // Method 0: variant pages — only pieces inside the actual pieces container
  // (excludes banks, playerboxes, and other non-board pieces)
  const piecesContainer = board.querySelector("[class*='TheBoard-pieces'], [class*='Pieces-layer']");
  if (piecesContainer) {
    let pieces = piecesContainer.querySelectorAll(".piece");
    if (pieces.length >= 2) {
      let result = filterGhostPieces(pieces);
      // For drop variants, also include pocket/bank pieces outside the board container
      if (isDropVar) {
        const bankPieces = findChesscomBankPieces(board, piecesContainer);
        if (bankPieces.length) result = [...result, ...bankPieces];
      }
      return result;
    }
  }

  // Method 1: direct children/descendants with .piece class
  let pieces = board.querySelectorAll(".piece");
  if (pieces.length >= 2) return filterGhostPieces(pieces);

  // Method 2: shadow root
  if (board.shadowRoot) {
    pieces = board.shadowRoot.querySelectorAll(".piece");
    if (pieces.length >= 2) return filterGhostPieces(pieces);
  }

  // Method 3: global search (pieces may be siblings, not children)
  pieces = document.querySelectorAll(".piece");
  if (pieces.length >= 2) return filterGhostPieces(pieces);

  // Method 4: look for elements with piece-type class pattern [wb][prnbqk]
  // and square-NN pattern, anywhere in the document
  pieces = document.querySelectorAll("[class*='square-']");
  if (pieces.length >= 2) {
    // Filter to only those that also have a piece-type class
    const filtered = Array.from(pieces).filter(el => {
      const cls = el.className || "";
      return /\b[wb][prnbqk]\b/.test(cls);
    });
    if (filtered.length >= 2) return filtered;
  }

  // Method 5: chess.com sometimes uses data attributes or img-based pieces
  pieces = document.querySelectorAll("[data-piece]");
  if (pieces.length >= 2) return pieces;

  return null;
}

/** Find pocket/bank/spare pieces on chess.com variant pages.
 *  These live outside the main pieces container in crazyhouse/bughouse. */
function findChesscomBankPieces(board, excludeContainer) {
  const bankPieces = [];
  const seen = new Set();
  const addPiece = (el) => {
    if (seen.has(el)) return;
    if (excludeContainer && excludeContainer.contains(el)) return;
    seen.add(el);
    bankPieces.push(el);
  };

  // Search for piece elements in bank/pocket/spare containers
  const containerSelectors = [
    "[class*='bank']", "[class*='Bank']",
    "[class*='pocket']", "[class*='Pocket']",
    "[class*='spare']", "[class*='Spare']",
    "[class*='holdings']", "[class*='Holdings']",
    "[class*='hand']", "[class*='Hand']",
    "[class*='reserve']", "[class*='Reserve']",
  ];
  // Walk up the DOM from the board to find the layout wrapper
  const searchRoots = [];
  let node = board;
  for (let i = 0; i < 5 && node; i++) {
    searchRoots.push(node);
    node = node.parentElement;
  }
  if (!searchRoots.includes(document.body)) searchRoots.push(document.body);

  for (const root of searchRoots) {
    for (const csel of containerSelectors) {
      const containers = root.querySelectorAll(csel);
      for (const container of containers) {
        if (excludeContainer && (container === excludeContainer || excludeContainer.contains(container))) continue;
        const pieces = container.querySelectorAll(".piece, [data-piece]");
        for (const el of pieces) addPiece(el);
      }
    }
    if (bankPieces.length) break;
  }

  // Fallback: any .piece or [data-piece] outside the pieces container anywhere on page
  if (!bankPieces.length) {
    const allPieces = document.querySelectorAll(".piece, [data-piece]");
    for (const el of allPieces) addPiece(el);
  }

  if (bankPieces.length) {
    console.log(`[chessbot] found ${bankPieces.length} bank/pocket piece elements outside board container`);
  }
  return bankPieces;
}

/** Scan chess.com variant page DOM for pocket piece information.
 *  Chess.com Crazyhouse renders pockets as custom UI elements (not .piece divs).
 *  This scans sibling/nearby elements around the board for anything that looks
 *  like a pocket: piece icons with counts, text like "Q N B R P", SVG icons, etc.
 *  Returns a pocket string like "[QNBppp]" or null. */
function scanChesscomPocketDOM(board, flipped) {
  let whitePocket = "";
  let blackPocket = "";
  const boardRect = getVisualBoardRect(board);
  const boardCenterY = boardRect.top + boardRect.height / 2;

  // Strategy: look for elements near but outside the board that contain piece info.
  // Walk up from the board to find the game layout container.
  let layoutRoot = board;
  for (let i = 0; i < 6 && layoutRoot.parentElement && layoutRoot.parentElement !== document.body; i++) {
    layoutRoot = layoutRoot.parentElement;
  }

  // Piece type patterns to recognize
  const pieceLetterMap = {
    queen: "q", rook: "r", bishop: "b", knight: "n", pawn: "p", king: "k",
    q: "q", r: "r", b: "b", n: "n", p: "p", k: "k",
  };

  // --- Method 1: Elements with piece-related data attributes ---
  const dataEls = layoutRoot.querySelectorAll("[data-piece], [data-type], [data-role]");
  for (const el of dataEls) {
    // Skip elements on the board itself
    const er = el.getBoundingClientRect();
    if (er.width === 0) continue;
    const ecx = er.left + er.width / 2;
    const ecy = er.top + er.height / 2;
    if (ecx >= boardRect.left - 5 && ecx <= boardRect.right + 5 &&
        ecy >= boardRect.top - 5 && ecy <= boardRect.bottom + 5) continue;

    const dp = (el.getAttribute("data-piece") || el.getAttribute("data-type") || el.getAttribute("data-role") || "").toLowerCase();
    const type = pieceLetterMap[dp];
    if (!type) continue;
    const dc = (el.getAttribute("data-color") || el.getAttribute("data-side") || "").toLowerCase();
    // Count
    const countAttr = el.getAttribute("data-count") || el.getAttribute("data-nb") || "";
    const countChild = el.querySelector("[class*='count'], [class*='Count'], [class*='badge'], [class*='num']");
    const count = parseInt(countAttr) || parseInt(countChild?.textContent) || 1;
    if (count <= 0) continue;

    // Determine color: if above board center → top player, below → bottom player
    const isTop = ecy < boardCenterY;
    // Top = opponent, bottom = us. If flipped, top = white pieces, bottom = black
    const isWhitePiece = flipped ? isTop : !isTop;
    const ch = isWhitePiece ? type.toUpperCase() : type.toLowerCase();
    for (let i = 0; i < count; i++) {
      if (isWhitePiece) whitePocket += ch;
      else blackPocket += ch;
    }
  }
  if (whitePocket || blackPocket) return "[" + whitePocket + blackPocket + "]";

  // --- Method 2: Elements with piece class names (wb][prnbqk] pattern) ---
  const allEls = layoutRoot.querySelectorAll("[class*='piece'], [class*='Piece']");
  for (const el of allEls) {
    const er = el.getBoundingClientRect();
    if (er.width === 0) continue;
    const ecx = er.left + er.width / 2;
    const ecy = er.top + er.height / 2;
    if (ecx >= boardRect.left - 5 && ecx <= boardRect.right + 5 &&
        ecy >= boardRect.top - 5 && ecy <= boardRect.bottom + 5) continue;

    const cls = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
    const m = cls.match(/\b([wb])([prnbqk])\b/);
    if (!m) continue;
    const color = m[1];
    const type = m[2];
    const ch = color === "w" ? type.toUpperCase() : type.toLowerCase();
    const countChild = el.querySelector("[class*='count'], [class*='Count'], [class*='badge'], [class*='num']");
    const count = parseInt(countChild?.textContent) || 1;
    for (let i = 0; i < count; i++) {
      if (color === "w") whitePocket += ch;
      else blackPocket += ch;
    }
  }
  if (whitePocket || blackPocket) return "[" + whitePocket + blackPocket + "]";

  // --- Method 3: Look for img/svg elements with piece-indication src/class ---
  const imgEls = layoutRoot.querySelectorAll("img[src*='piece'], img[src*='chess'], svg[class*='piece'], svg[class*='Piece']");
  for (const el of imgEls) {
    const er = el.getBoundingClientRect();
    if (er.width === 0) continue;
    const ecx = er.left + er.width / 2;
    const ecy = er.top + er.height / 2;
    if (ecx >= boardRect.left - 5 && ecx <= boardRect.right + 5 &&
        ecy >= boardRect.top - 5 && ecy <= boardRect.bottom + 5) continue;

    const src = (el.getAttribute("src") || el.getAttribute("href") || el.getAttribute("class") || "").toLowerCase();
    // chess.com piece image URLs typically contain the piece code like "wq", "bn", "wp" etc.
    const pieceMatch = src.match(/[\/._-]([wb])([prnbqk])[\/._-]/);
    if (!pieceMatch) continue;
    const color = pieceMatch[1];
    const type = pieceMatch[2];
    const ch = color === "w" ? type.toUpperCase() : type.toLowerCase();
    if (color === "w") whitePocket += ch;
    else blackPocket += ch;
  }
  if (whitePocket || blackPocket) return "[" + whitePocket + blackPocket + "]";

  return null;
}

// ── Lichess board reader ─────────────────────────────────────

function lichessBoardToFen() {
  const board = document.querySelector("cg-board");
  if (!board) return null;

  const pieces = board.querySelectorAll("piece");
  if (!pieces.length) return null;

  // Detect orientation
  const flipped = isLichessFlipped();

  // Board dimensions from the cg-board element
  const boardRect = board.getBoundingClientRect();
  const squareW = boardRect.width / 8;
  const squareH = boardRect.height / 8;

  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));

  for (const piece of pieces) {
    // Skip ghost/premove pieces on lichess (class contains "ghost")
    if (piece.classList.contains("ghost")) continue;
    // Lichess uses CSS transform: translate(…) for positioning
    const transform = piece.style.transform;
    const match = transform && transform.match(/translate\((\d+(?:\.\d+)?)px\s*,\s*(\d+(?:\.\d+)?)px\)/);
    if (!match) continue;

    const px = parseFloat(match[1]);
    const py = parseFloat(match[2]);

    let file = Math.round(px / squareW);
    let rank = Math.round(py / squareH);

    // Handle flip: lichess has rank 0 = top visually
    if (flipped) {
      file = 7 - file;
      rank = 7 - rank;
    }

    // Lichess classes: "white pawn", "black king", etc.
    const cl = piece.className;
    const color = cl.includes("white") ? "w" : "b";
    const typeMap = { pawn: "p", rook: "r", knight: "n", bishop: "b", queen: "q", king: "k" };
    let type = null;
    for (const [name, ch] of Object.entries(typeMap)) {
      if (cl.includes(name)) { type = ch; break; }
    }
    if (!type) continue;

    const fenChar = color === "w" ? type.toUpperCase() : type.toLowerCase();
    if (rank >= 0 && rank < 8 && file >= 0 && file < 8) {
      grid[rank][file] = fenChar;
    }
  }

  return gridToFenBoard(grid, readPocket());
}

function isLichessFlipped() {
  // Method 1: orientation class on cg-wrap (lichess + PlayStrategy)
  const cgWrap = document.querySelector(".cg-wrap");
  if (cgWrap) {
    if (cgWrap.classList.contains("orientation-black") || cgWrap.classList.contains("orientation-p2")) return true;
    if (cgWrap.classList.contains("orientation-white") || cgWrap.classList.contains("orientation-p1")) return false;
  }
  // Method 2: check coordinate labels — if rank 1 is at top, board is flipped
  const ranks = document.querySelector("coords.ranks coord:first-child");
  if (ranks && ranks.textContent.trim() === "1") return true;
  return false;
}

// ── PlayStrategy board reader ────────────────────────────────

function playstrategyBoardToFen() {
  const board = document.querySelector("cg-board");
  if (!board) return null;

  const pieces = board.querySelectorAll("piece");
  if (!pieces.length) return null;

  const flipped = isLichessFlipped();

  const boardRect = board.getBoundingClientRect();
  const squareW = boardRect.width / 8;
  const squareH = boardRect.height / 8;

  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));

  for (const piece of pieces) {
    if (piece.classList.contains("ghost")) continue;
    const transform = piece.style.transform;
    const match = transform && transform.match(/translate\((\d+(?:\.\d+)?)px\s*,\s*(\d+(?:\.\d+)?)px\)/);
    if (!match) continue;

    const px = parseFloat(match[1]);
    const py = parseFloat(match[2]);

    let file = Math.round(px / squareW);
    let rank = Math.round(py / squareH);

    if (flipped) {
      file = 7 - file;
      rank = 7 - rank;
    }

    // PlayStrategy classes: "p1 r-piece ally", "p2 n-piece enemy", etc.
    const cl = piece.className;
    const color = cl.includes("p1") ? "w" : "b";
    const typeMap = { "p-piece": "p", "r-piece": "r", "n-piece": "n", "b-piece": "b", "q-piece": "q", "k-piece": "k" };
    let type = null;
    for (const [name, ch] of Object.entries(typeMap)) {
      if (cl.includes(name)) { type = ch; break; }
    }
    if (!type) continue;

    const fenChar = color === "w" ? type.toUpperCase() : type.toLowerCase();
    if (rank >= 0 && rank < 8 && file >= 0 && file < 8) {
      grid[rank][file] = fenChar;
    }
  }

  return gridToFenBoard(grid, readPocket());
}

// ── ChessTempo board reader ──────────────────────────────────

function chesstempoBoardToFen() {
  // Method 1: read FEN from accessibility description (most reliable)
  const fenHeadings = document.querySelectorAll("chess-board h2");
  for (const h of fenHeadings) {
    const text = h.textContent.trim();
    const fenMatch = text.match(/^FEN:\s*(.+)$/);
    if (fenMatch) return fenMatch[1].trim();
  }

  // Method 2: parse piece elements from DOM
  const ctBoard = document.querySelector("chess-board");
  if (!ctBoard) return null;

  const pieces = ctBoard.querySelectorAll(".ct-pieceClass");
  if (!pieces.length) return null;

  const flipped = isChesstempFlipped();

  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));

  for (const piece of pieces) {
    const cl = piece.className;
    // Classes: "ct-pieceClass ct-piece-whiterook"
    const typeMatch = cl.match(/ct-piece-(white|black)(pawn|rook|knight|bishop|queen|king)/);
    if (!typeMatch) continue;

    const color = typeMatch[1] === "white" ? "w" : "b";
    const typeMap = { pawn: "p", rook: "r", knight: "n", bishop: "b", queen: "q", king: "k" };
    const type = typeMap[typeMatch[2]];
    if (!type) continue;

    // Position via percentage left/top — each square is 12.5%
    const left = parseFloat(piece.style.left);
    const top = parseFloat(piece.style.top);
    if (isNaN(left) || isNaN(top)) continue;

    let file = Math.round(left / 12.5);
    let rank = Math.round(top / 12.5);

    if (flipped) {
      file = 7 - file;
      rank = 7 - rank;
    }

    const fenChar = color === "w" ? type.toUpperCase() : type.toLowerCase();
    if (rank >= 0 && rank < 8 && file >= 0 && file < 8) {
      grid[rank][file] = fenChar;
    }
  }

  return gridToFenBoard(grid, readPocket());
}

function isChesstempFlipped() {
  // Check coordinate labels — if file 'h' is first (leftmost), board is flipped
  const fileCoords = document.querySelectorAll("chess-board .ct-board-inner-holder .ct-file-coord, chess-board coords coord");
  if (fileCoords.length > 0) {
    const first = fileCoords[0].textContent.trim().toLowerCase();
    if (first === "h") return true;
    if (first === "a") return false;
  }
  // Alternative: check rank labels — if rank 1 is at top, board is flipped
  const rankCoords = document.querySelectorAll("chess-board .ct-rank-coord");
  if (rankCoords.length > 0) {
    const first = rankCoords[0].textContent.trim();
    if (first === "1") return true;
    if (first === "8") return false;
  }
  return false;
}

// ── Turn detection (multiple methods, prioritized) ───────────

function inferTurn(prevBoardFen, currentBoardFen) {
  // Method 1: read the move list from the DOM (most reliable — works mid-game, on refresh, etc.)
  const moveListTurn = detectTurnFromMoveList();
  if (moveListTurn) return moveListTurn;

  // Method 2: clock-based detection (whose clock is ticking)
  const clockTurn = detectTurnFromClocks();
  if (clockTurn) return clockTurn;

  // Method 3: diff the two positions to see which color just moved
  // (can be unreliable for variants with unusual captures/drops — checked after DOM methods)
  if (prevBoardFen && prevBoardFen !== currentBoardFen) {
    const movedColor = detectWhoMoved(prevBoardFen, currentBoardFen);
    if (movedColor) {
      return movedColor === "w" ? "b" : "w";
    }
  }

  // Method 4: last-move highlight squares (chess.com highlights the move just played)
  const highlightTurn = detectTurnFromHighlights();
  if (highlightTurn) return highlightTurn;

  // Last resort: DON'T assume — return null so callers can handle uncertainty
  console.log(`[chessbot] turn detection uncertain — all methods failed`);
  return null;
}

/** Read the move list panel to determine whose turn it is.
 *  If the last move in the list was made by black, it's white's turn (and vice versa). */
function detectTurnFromMoveList() {
  if (SITE === "chesscom") {
    // Chess.com move list: try multiple known selector patterns
    // Pattern 1: modern chess.com — each ply is a separate node
    let moveNodes = document.querySelectorAll(
      ".main-line-ply, [data-ply], move-list-ply"
    );
    // Filter to actual move nodes (exclude move numbers, annotations, etc.)
    if (moveNodes.length > 0) {
      const realMoves = Array.from(moveNodes).filter(el => {
        const text = el.textContent.trim();
        // Must contain at least one letter (a-h or piece letter) and not be just a number
        return text && /[a-hNBRQKO]/.test(text) && !/^\d+\.?$/.test(text);
      });
      if (realMoves.length > 0) {
        const lastPly = realMoves.length;
        return lastPly % 2 === 0 ? "w" : "b";
      }
    }

    // Pattern 2: move-text-component elements (older chess.com)
    moveNodes = document.querySelectorAll(".move-text-component");
    if (moveNodes.length > 0) {
      const realMoves = Array.from(moveNodes).filter(el => {
        const text = el.textContent.trim();
        return text && /[a-hNBRQKO]/.test(text) && !/^\d+\.?$/.test(text);
      });
      if (realMoves.length > 0) {
        return realMoves.length % 2 === 0 ? "w" : "b";
      }
    }

    // Pattern 3: vertical move list with numbered rows
    const rows = document.querySelectorAll(
      ".move-list .move, [class*='move-list'] [class*='move']"
    );
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const text = lastRow.textContent.trim();
      const parts = text.replace(/^\d+\.?\s*/, "").trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] && !parts[1].match(/^[\d.]+$/)) {
        return "w";
      }
      return "b";
    }

    // Pattern 4: chess.com variant/Vue pages — broad search for move notation
    // elements with data attributes or variant-specific class patterns
    const variantMoveNodes = document.querySelectorAll(
      "[class*='Move-'], [class*='move-node'], [class*='MoveList'] [class*='move'], [class*='notations'] [class*='move']"
    );
    if (variantMoveNodes.length > 0) {
      const realMoves = Array.from(variantMoveNodes).filter(el => {
        const text = el.textContent.trim();
        return text && /[a-hNBRQKO]/.test(text) && !/^\d+\.?$/.test(text);
      });
      if (realMoves.length > 0) {
        return realMoves.length % 2 === 0 ? "w" : "b";
      }
    }
  }

  if (IS_CHESSGROUND) {
    // Lichess / PlayStrategy: moves are in <move>, <m2>, <kwdb>, or .tview2 elements
    const moves = document.querySelectorAll("move, m2, kwdb, .moves kwdb");
    if (moves.length > 0) {
      // Filter to only actual move elements (must contain move notation text)
      const realMoves = Array.from(moves).filter(el => {
        const text = el.textContent.trim();
        return text && /[a-hNBRQKO@]/.test(text) && !/^\d+\.?$/.test(text);
      });
      if (realMoves.length > 0) {
        return realMoves.length % 2 === 0 ? "w" : "b";
      }
      // Fallback: use raw count
      return moves.length % 2 === 0 ? "w" : "b";
    }
    // Alternative: l4x/tview2 container elements
    const plies = document.querySelectorAll("l4x move, .tview2 move, .tview2 kwdb");
    if (plies.length > 0) {
      return plies.length % 2 === 0 ? "w" : "b";
    }

    // Alternative: Lichess <rm6> container with child move tags
    const rm6Moves = document.querySelectorAll("rm6 kwdb, rm6 move");
    if (rm6Moves.length > 0) {
      return rm6Moves.length % 2 === 0 ? "w" : "b";
    }
  }

  return null;
}

/** Chess.com highlights the last-move squares with a yellow/green overlay.
 *  The piece on a highlighted square tells us who moved last. */
function detectTurnFromHighlights() {
  if (SITE === "chesscom") {
    // Chess.com adds elements with "highlight" class on last-move squares
    const highlights = document.querySelectorAll(
      ".highlight, [class*='highlight']"
    );
    if (highlights.length >= 2) {
      // Get the destination highlight (the one with a piece on it or the later square)
      for (const hl of highlights) {
        const classes = hl.className || "";
        const sqMatch = classes.match(/\bsquare-(\d)(\d)\b/);
        if (!sqMatch) continue;
        // Find if there's a piece on this square
        const file = parseInt(sqMatch[1], 10) - 1;
        const rank = parseInt(sqMatch[2], 10) - 1;
        // Check all pieces to find one on this square
        const pieces = findChesscomPieces(hl.closest("wc-chess-board, chess-board, .board, [class*='TheBoard']") || getBoardElement() || document);
        if (!pieces) continue;
        for (const piece of pieces) {
          const pcls = typeof piece.className === "string" ? piece.className : "";
          const pSq = pcls.match(/\bsquare-(\d)(\d)\b/);
          if (pSq && parseInt(pSq[1], 10) - 1 === file && parseInt(pSq[2], 10) - 1 === rank) {
            const pm = pcls.match(/\b([wb])[prnbqk]\b/);
            if (pm) {
              // This color just moved → other color's turn
              return pm[1] === "w" ? "b" : "w";
            }
          }
        }
      }
    }
  }

  if (IS_CHESSGROUND) {
    // Lichess / PlayStrategy: last-move squares have class "last-move"
    const lastMove = document.querySelectorAll("square.last-move, .last-move");
    if (lastMove.length >= 2) {
      // The destination square has a piece — check its color
      const board = document.querySelector("cg-board");
      if (board) {
        const boardRect = board.getBoundingClientRect();
        const squareW = boardRect.width / 8;
        const squareH = boardRect.height / 8;
        const flipped = isLichessFlipped();
        for (const sq of lastMove) {
          const sqRect = sq.getBoundingClientRect();
          const cx = sqRect.left + sqRect.width / 2 - boardRect.left;
          const cy = sqRect.top + sqRect.height / 2 - boardRect.top;
          let vf = Math.floor(cx / squareW);
          let vr = Math.floor(cy / squareH);
          // Check for piece at this visual position
          const pieces = board.querySelectorAll("piece");
          for (const p of pieces) {
            const t = p.style.transform;
            const m = t && t.match(/translate\((\d+(?:\.\d+)?)px\s*,\s*(\d+(?:\.\d+)?)px\)/);
            if (!m) continue;
            const pf = Math.round(parseFloat(m[1]) / squareW);
            const pr = Math.round(parseFloat(m[2]) / squareH);
            if (pf === vf && pr === vr) {
              const cl = p.className;
              if (cl.includes("white")) return "b";
              if (cl.includes("black")) return "w";
            }
          }
        }
      }
    }
  }

  return null;
}

function detectWhoMoved(prevFen, currFen) {
  const prev = fenBoardToGrid(prevFen);
  const curr = fenBoardToGrid(currFen);

  // Count squares where a piece of each color newly appeared
  // Use dynamic grid dimensions to support non-8x8 variants
  let whiteAppeared = 0;
  let blackAppeared = 0;
  let whiteDisappeared = 0;
  let blackDisappeared = 0;

  const ranks = Math.max(prev.length, curr.length);
  for (let r = 0; r < ranks; r++) {
    const prevRank = prev[r] || [];
    const currRank = curr[r] || [];
    const files = Math.max(prevRank.length, currRank.length);
    for (let f = 0; f < files; f++) {
      const p = prevRank[f] || null;
      const c = currRank[f] || null;
      if (p === c) continue;

      // Something left this square
      if (p) {
        if (p === p.toUpperCase()) whiteDisappeared++;
        else blackDisappeared++;
      }
      // Something arrived at this square
      if (c) {
        if (c === c.toUpperCase()) whiteAppeared++;
        else blackAppeared++;
      }
    }
  }

  // The side that moved will have pieces disappear from old square and
  // appear on new square. For a normal move: 1 disappear + 1 appear.
  // For castling: 2 disappear + 2 appear (king + rook).
  // The OTHER side might have 1 disappear (capture) but 0 appear.
  const whiteMoved = whiteDisappeared > 0 && whiteAppeared > 0;
  const blackMoved = blackDisappeared > 0 && blackAppeared > 0;

  if (whiteMoved && !blackMoved) return "w";
  if (blackMoved && !whiteMoved) return "b";

  // Atomic chess: captures cause explosions where the capturing piece also
  // disappears. Both sides lose pieces but neither "appears" on a new square.
  // In this case, the side that lost MORE pieces likely had the explosion on
  // their opponent's territory (opponent's pieces got destroyed). The side
  // with fewer disappearances is the one that got captured = the non-mover.
  // Actually, the capturing side loses exactly 1 piece (the capturer), while
  // the captured side loses 1+ (the captured piece + any adjacent friendlies).
  // But adjacent pieces of BOTH colors explode, so use net disappearance.
  if (!whiteMoved && !blackMoved && (whiteDisappeared > 0 || blackDisappeared > 0)) {
    // Explosion detected — fall through to other turn detection methods
    return null;
  }

  // Both or neither — use net movement as tiebreaker
  if (whiteAppeared > blackAppeared) return "w";
  if (blackAppeared > whiteAppeared) return "b";

  return null;
}

function fenBoardToGrid(boardFen) {
  const grid = [];
  // Strip pocket notation [...] (crazyhouse, shogi, etc.)
  const cleaned = boardFen.replace(/\[.*?\]$/g, "");
  const rows = cleaned.split("/");
  for (const row of rows) {
    const rank = [];
    let numBuf = "";
    for (const ch of row) {
      if (ch >= "0" && ch <= "9") {
        numBuf += ch;
      } else {
        if (numBuf) { for (let i = 0; i < parseInt(numBuf); i++) rank.push(null); numBuf = ""; }
        // Skip promoted piece markers (+ and ~ in Shogi/Fairy FENs)
        if (ch !== "+" && ch !== "~") rank.push(ch);
      }
    }
    if (numBuf) { for (let i = 0; i < parseInt(numBuf); i++) rank.push(null); }
    grid.push(rank);
  }
  return grid;
}

function detectTurnFromClocks() {
  if (IS_CHESSGROUND) {
    const clocks = document.querySelectorAll(".rclock");
    for (const clock of clocks) {
      if (clock.classList.contains("rclock-running")) {
        const isBottom = clock.classList.contains("rclock-bottom");
        const flipped = isLichessFlipped();
        return isBottom ? (flipped ? "b" : "w") : (flipped ? "w" : "b");
      }
    }
  }
  if (SITE === "chesscom") {
    const board = getBoardElement();
    const flipped = board ? isChesscomFlipped(board) : false;
    // Try multiple selector patterns for the active/running clock
    const bottomSel = [
      ".clock-bottom .clock-running",
      ".clock-bottom.clock-running",
      ".clock-bottom [class*='active']",
      ".clock-bottom.active",
      "div[class*='clock-bottom'] [class*='running']",
      "div[class*='clock-bottom'][class*='active']",
    ].join(", ");
    const topSel = [
      ".clock-top .clock-running",
      ".clock-top.clock-running",
      ".clock-top [class*='active']",
      ".clock-top.active",
      "div[class*='clock-top'] [class*='running']",
      "div[class*='clock-top'][class*='active']",
    ].join(", ");
    const bottom = document.querySelector(bottomSel);
    if (bottom) return flipped ? "b" : "w";
    const top = document.querySelector(topSel);
    if (top) return flipped ? "w" : "b";

    // Variant/Vue page clocks — broader selectors for active/running clocks
    // positioned relative to the board (use Y-coordinate heuristic)
    const variantClocks = document.querySelectorAll(
      "[class*='clock'][class*='active'], [class*='clock'][class*='running'], " +
      "[class*='Clock'][class*='active'], [class*='Clock'][class*='running'], " +
      "[class*='timer'][class*='active'], [class*='Timer'][class*='running']"
    );
    if (variantClocks.length > 0) {
      const boardEl = board || getBoardElement();
      if (boardEl) {
        const boardRect = getVisualBoardRect(boardEl);
        const boardMidY = boardRect.top + boardRect.height / 2;
        for (const clock of variantClocks) {
          const cr = clock.getBoundingClientRect();
          if (cr.height === 0) continue;
          const clockMidY = cr.top + cr.height / 2;
          const isBelow = clockMidY > boardMidY;
          // Below board = player's clock, above = opponent's
          return isBelow ? (flipped ? "b" : "w") : (flipped ? "w" : "b");
        }
      }
    }
  }
  return null; // couldn't determine — let caller decide
}

let _cachedPlayerColor = null; // locked after first reliable detection

function getPlayerColor() {
  // Once locked (after initial board read with enough pieces), return cached value.
  // This prevents mid-game flips when piece-position heuristics become unreliable
  // (e.g. giveaway endgame with 3 pieces left).
  if (_cachedPlayerColor) return _cachedPlayerColor;

  let color = "w";
  if (IS_CHESSGROUND) {
    color = isLichessFlipped() ? "b" : "w";
  } else if (SITE === "chesscom") {
    const board = getBoardElement();
    color = board && isChesscomFlipped(board) ? "b" : "w";
  } else if (SITE === "chesstempo") {
    color = isChesstempFlipped() ? "b" : "w";
  }
  return color;
}

/** Lock player color after a reliable detection (many pieces on board). */
function lockPlayerColor() {
  if (_cachedPlayerColor) return; // already locked
  const color = getPlayerColor();
  _cachedPlayerColor = color;
  console.log(`[chessbot] player color locked: ${color}`);
}

// ── FEN helpers ──────────────────────────────────────────────

/** Read pocket/hand pieces for drop variants (Crazyhouse, etc.) from the DOM.
 *  Returns Fairy-Stockfish pocket notation like "[QNPppp]" or "" if not a drop variant. */
function readPocket() {
  if (!detectedVariant || !DROP_VARIANTS.has(detectedVariant)) return "";

  if (IS_CHESSGROUND) return readPocketChessground();
  if (SITE === "chesscom") return readPocketChessCom();
  // Default: empty pocket so engine knows this is a drop variant
  return "[]";
}

/** Read pocket pieces from Lichess/PlayStrategy Chessground pockets. */
function readPocketChessground() {
  let whitePocket = "";
  let blackPocket = "";
  // Lichess uses <pocket> elements, or .pocket containers, or crazyhouse-specific elements
  const pockets = document.querySelectorAll("pocket, .pocket, .crazyhouse-pocket, [class*='pocket']");
  if (!pockets.length) return "[]";

  const typeMap = { pawn: "p", rook: "r", knight: "n", bishop: "b", queen: "q", king: "k" };

  for (const pocket of pockets) {
    const pieces = pocket.querySelectorAll("piece");
    for (const piece of pieces) {
      const cl = piece.className || "";
      const color = cl.includes("white") || cl.includes("p1") ? "w" : "b";

      let type = null;
      // Try class-based role detection
      for (const [name, ch] of Object.entries(typeMap)) {
        if (cl.includes(name)) { type = ch; break; }
      }
      // Try data-role attribute (some lichess versions)
      if (!type) {
        const role = piece.getAttribute("data-role") || "";
        if (typeMap[role]) type = typeMap[role];
      }
      if (!type) continue;

      // Get count: data-nb attribute or just 1
      const nb = parseInt(piece.getAttribute("data-nb") || "1", 10);
      if (nb <= 0) continue;

      const ch = color === "w" ? type.toUpperCase() : type.toLowerCase();
      for (let i = 0; i < nb; i++) {
        if (color === "w") whitePocket += ch;
        else blackPocket += ch;
      }
    }
  }
  return "[" + whitePocket + blackPocket + "]";
}

/** Read pocket pieces from Chess.com spare/bank areas. */
function readPocketChessCom() {
  let whitePocket = "";
  let blackPocket = "";
  const board = getBoardElement();
  const roots = [document];
  if (board && board.shadowRoot) roots.push(board.shadowRoot);

  for (const root of roots) {
    const candidates = root.querySelectorAll(
      "[class*='spare'] [class*='piece'], [class*='pocket'] [class*='piece'], [class*='bank'] [class*='piece'], [class*='Spare'] [class*='piece']"
    );
    for (const el of candidates) {
      const cls = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
      const m = cls.match(/\b([wb])([prnbqk])\b/);
      if (!m) continue;
      const color = m[1];
      const type = m[2];
      const ch = color === "w" ? type.toUpperCase() : type.toLowerCase();
      // Count: data-count, data-nb, or textContent number
      const countAttr = el.getAttribute("data-count") || el.getAttribute("data-nb") || el.textContent.trim();
      const count = parseInt(countAttr) || 1;
      for (let i = 0; i < count; i++) {
        if (color === "w") whitePocket += ch;
        else blackPocket += ch;
      }
    }
  }
  return "[" + whitePocket + blackPocket + "]";
}

function gridToFenBoard(grid, pocket) {
  const rows = [];
  const numRanks = grid.length;
  for (let r = 0; r < numRanks; r++) {
    let row = "";
    let empty = 0;
    const numFiles = grid[r].length;
    for (let f = 0; f < numFiles; f++) {
      if (grid[r][f]) {
        if (empty) { row += empty; empty = 0; }
        row += grid[r][f];
      } else {
        empty++;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  // Derive castling rights from king/rook positions (only for 8x8 boards)
  // Some variants never have castling (antichess, racing kings, horde)
  // grid[0] = rank 8 (top), grid[7] = rank 1 (bottom)
  let castling = "";
  const noCastling = detectedVariant && NO_CASTLING_VARIANTS.has(detectedVariant);
  if (!noCastling && numRanks === 8 && (grid[7] || []).length >= 8) {
    if (grid[7][4] === "K") { // white king on e1
      if (grid[7][7] === "R") castling += "K";
      if (grid[7][0] === "R") castling += "Q";
    }
    if (grid[0][4] === "k") { // black king on e8
      if (grid[0][7] === "r") castling += "k";
      if (grid[0][0] === "r") castling += "q";
    }
  }
  if (!castling) castling = "-";
  // Append pocket notation for drop variants (Crazyhouse, etc.)
  const pocketStr = pocket || "";
  return rows.join("/") + pocketStr + " w " + castling + " - 0 1";
}

function boardToFen() {
  if (SITE === "chesscom") return chesscomBoardToFen();
  if (SITE === "lichess") return lichessBoardToFen();
  if (SITE === "playstrategy") return playstrategyBoardToFen();
  if (SITE === "chesstempo") return chesstempoBoardToFen();
  return null;
}

// ── Arrow overlay ────────────────────────────────────────────

function uciToSquares(uci) {
  if (!uci || uci.length < 3) return null;
  // Handle drop notation: P@e4 (piece @ destination square)
  const dropMatch = uci.match(/^([PNBRQK])@([a-z])(\d+)$/i);
  if (dropMatch) {
    const tf = dropMatch[2].charCodeAt(0) - 97;
    const tr = parseInt(dropMatch[3], 10) - 1;
    if (tf < 0 || tr < 0) return null;
    return { from: null, to: { file: tf, rank: tr }, drop: dropMatch[1].toUpperCase() };
  }
  // Parse UCI move — supports multi-digit ranks for larger boards (e.g. a10b10)
  const m = uci.match(/^([a-z])(\d+)([a-z])(\d+)/);
  if (!m) return null;
  const ff = m[1].charCodeAt(0) - 97;
  const fr = parseInt(m[2], 10) - 1;
  const tf = m[3].charCodeAt(0) - 97;
  const tr = parseInt(m[4], 10) - 1;
  if (ff < 0 || fr < 0 || tf < 0 || tr < 0) return null;
  return {
    from: { file: ff, rank: fr },
    to:   { file: tf, rank: tr },
  };
}

/** Clear move arrows and eval badges, but keep the eval bar. */
function clearMoveIndicators() {
  // Check both document and shadow root for our overlay elements
  const roots = [document];
  const board = getBoardElement();
  if (board && board.shadowRoot) roots.push(board.shadowRoot);
  for (const root of roots) {
    // Clear SVG children instead of removing containers (persist-svg optimisation)
    const existing = root.getElementById("chessbot-arrow-svg");
    if (existing) existing.innerHTML = "";
    const bg = root.getElementById("chessbot-bg-svg");
    if (bg) bg.innerHTML = "";
    root.querySelectorAll(".chessbot-eval-badge").forEach((el) => el.remove());
    root.querySelectorAll(".chessbot-training-feedback").forEach((el) => el.remove());
    root.querySelectorAll(".chessbot-hint-btn").forEach((el) => el.remove());
    root.querySelectorAll(".chessbot-score-badge").forEach((el) => el.remove());
  }
}

/** Clear everything — move indicators AND eval bar. */
function clearArrow() {
  clearMoveIndicators();
  const roots = [document];
  const board = getBoardElement();
  if (board && board.shadowRoot) roots.push(board.shadowRoot);
  for (const root of roots) {
    const bar = root.getElementById("chessbot-eval-bar");
    if (bar) bar.remove();
  }
}

// ── Board geometry helpers ───────────────────────────────────

// Cache for getBoardGeometry — invalidated by board resize
let _geoCache = null;
let _geoCacheKey = "";

function getBoardGeometry() {
  const board = getBoardElement();
  if (!board) { _geoCache = null; return null; }
  const rect = (SITE === "chesscom") ? getVisualBoardRect(board) : board.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) { _geoCache = null; return null; }
  const sqSize = rect.width / 8;
  // Always recompute flip state — it can change between games without
  // the board element or dimensions changing (e.g. white→black in Crazyhouse)
  const flipped =
    (SITE === "chesscom" && isChesscomFlipped(board)) ||
    (IS_CHESSGROUND && isLichessFlipped()) ||
    (SITE === "chesstempo" && isChesstempFlipped());
  // Cache by board identity + dimensions + flip state
  const key = `${board.id || ""}:${Math.round(rect.width)}:${Math.round(rect.height)}:${flipped}`;
  if (_geoCache && _geoCacheKey === key) return _geoCache;
  _geoCache = { board, rect, sqSize, flipped };
  _geoCacheKey = key;
  return _geoCache;
}

function squareTopLeft(file, rank, sqSize, flipped) {
  const f = flipped ? 7 - file : file;
  const r = flipped ? rank : 7 - rank;
  return { x: f * sqSize, y: r * sqSize };
}

function squareCenter(file, rank, sqSize, flipped) {
  const tl = squareTopLeft(file, rank, sqSize, flipped);
  return { x: tl.x + sqSize / 2, y: tl.y + sqSize / 2 };
}

// ── Arrow drawing helper ─────────────────────────────────

/** Draw an SVG arrow from one square to another on the board overlay. */
function drawArrowOnBoard(svg, fromFile, fromRank, toFile, toRank, sqSize, flipped, color, opacity) {
  const from = squareCenter(fromFile, fromRank, sqSize, flipped);
  const to = squareCenter(toFile, toRank, sqSize, flipped);

  let x2 = to.x, y2 = to.y;
  const dx = x2 - from.x, dy = y2 - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Shorten line so arrowhead sits near target square edge
  const shorten = sqSize * 0.35;
  if (dist > shorten) {
    const scale = (dist - shorten) / dist;
    x2 = from.x + dx * scale;
    y2 = from.y + dy * scale;
  }

  const strokeW = sqSize / 5;
  const op = opacity || 0.85;

  // Line
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", from.x);
  line.setAttribute("y1", from.y);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", strokeW);
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("opacity", op);
  svg.appendChild(line);

  // Arrowhead polygon (avoids marker url(#) CSP issues)
  const adx = x2 - from.x, ady = y2 - from.y;
  const len = Math.sqrt(adx * adx + ady * ady);
  if (len < 1) return;
  const ux = adx / len, uy = ady / len;
  const headLen = sqSize * 0.38;
  const headW = sqSize * 0.28;
  const tipX = x2 + ux * headLen * 0.3;
  const tipY = y2 + uy * headLen * 0.3;
  const baseX = x2 - ux * headLen * 0.5;
  const baseY = y2 - uy * headLen * 0.5;
  const px = -uy * headW, py = ux * headW;

  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points",
    `${tipX},${tipY} ${baseX + px},${baseY + py} ${baseX - px},${baseY - py}`);
  polygon.setAttribute("fill", color);
  polygon.setAttribute("opacity", op);
  svg.appendChild(polygon);
}

/** Draw a drop marker on a destination square for drop moves (e.g. P@e4).
 *  Shows a prominent pulsing indicator with the piece symbol and "DROP" label. */
function drawDropMarker(svg, file, rank, sqSize, flipped, color, pieceLetter, opacity) {
  const center = squareCenter(file, rank, sqSize, flipped);
  const top = squareTopLeft(file, rank, sqSize, flipped);
  const op = opacity || 0.9;
  const PIECE_SYMBOLS = { P: "\u265F", N: "\u265E", B: "\u265D", R: "\u265C", Q: "\u265B", K: "\u265A" };
  const PIECE_NAMES = { P: "PAWN", N: "KNIGHT", B: "BISHOP", R: "ROOK", Q: "QUEEN", K: "KING" };
  const symbol = PIECE_SYMBOLS[pieceLetter?.toUpperCase()] || pieceLetter || "";
  const sw = Math.max(2, sqSize * 0.04);

  // Inject pulse animation once
  if (!svg.querySelector("#chessbot-drop-pulse-style")) {
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.id = "chessbot-drop-pulse-style";
    style.textContent = `
      @keyframes chessbot-drop-pulse {
        0%, 100% { opacity: ${op}; transform: scale(1); }
        50% { opacity: ${Math.min(1, op + 0.1)}; transform: scale(1.06); }
      }
    `;
    svg.insertBefore(style, svg.firstChild);
  }

  // Group for the drop marker (enables pulse animation on all elements)
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("style", `animation: chessbot-drop-pulse 1.2s ease-in-out infinite; transform-origin: ${center.x}px ${center.y}px;`);

  // Square highlight with dashed border
  const highlight = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  highlight.setAttribute("x", top.x + sw / 2);
  highlight.setAttribute("y", top.y + sw / 2);
  highlight.setAttribute("width", sqSize - sw);
  highlight.setAttribute("height", sqSize - sw);
  highlight.setAttribute("fill", color);
  highlight.setAttribute("fill-opacity", "0.3");
  highlight.setAttribute("stroke", color);
  highlight.setAttribute("stroke-width", sw);
  highlight.setAttribute("stroke-dasharray", `${sqSize * 0.15} ${sqSize * 0.08}`);
  highlight.setAttribute("rx", sqSize * 0.06);
  g.appendChild(highlight);

  // Central circle background
  const radius = sqSize * 0.38;
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", center.x);
  circle.setAttribute("cy", center.y);
  circle.setAttribute("r", radius);
  circle.setAttribute("fill", color);
  circle.setAttribute("stroke", "#fff");
  circle.setAttribute("stroke-width", Math.max(2, sqSize * 0.04));
  circle.setAttribute("filter", "drop-shadow(0 2px 4px rgba(0,0,0,0.5))");
  g.appendChild(circle);

  // Piece symbol
  if (symbol) {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", center.x);
    text.setAttribute("y", center.y + sqSize * 0.14);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", sqSize * 0.46);
    text.setAttribute("font-weight", "900");
    text.setAttribute("fill", "#fff");
    text.setAttribute("filter", "drop-shadow(0 1px 2px rgba(0,0,0,0.6))");
    text.textContent = symbol;
    g.appendChild(text);
  }

  // "DROP" label above the square (or piece name if enough room)
  const labelText = sqSize > 40 ? (PIECE_NAMES[pieceLetter?.toUpperCase()] || "DROP") : "DROP";
  const labelFontSize = Math.max(8, sqSize * 0.17);
  const labelY = top.y - labelFontSize * 0.3;
  if (labelY > 0) {
    // Label background pill
    const pillW = labelFontSize * labelText.length * 0.7 + 8;
    const pillH = labelFontSize + 4;
    const pill = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    pill.setAttribute("x", center.x - pillW / 2);
    pill.setAttribute("y", labelY - pillH + 2);
    pill.setAttribute("width", pillW);
    pill.setAttribute("height", pillH);
    pill.setAttribute("fill", color);
    pill.setAttribute("rx", pillH / 2);
    pill.setAttribute("filter", "drop-shadow(0 1px 3px rgba(0,0,0,0.4))");
    g.appendChild(pill);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", center.x);
    label.setAttribute("y", labelY);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", labelFontSize);
    label.setAttribute("font-weight", "900");
    label.setAttribute("font-family", "system-ui, sans-serif");
    label.setAttribute("fill", "#fff");
    label.setAttribute("letter-spacing", "0.5");
    label.textContent = labelText;
    g.appendChild(label);
  }

  svg.appendChild(g);
}

// ── Square highlight drawing ─────────────────────────────────

/** Create or retrieve the background SVG layer (sits behind pieces). */
function getOrCreateBgSvg(board, rect) {
  const { target, dx, dy } = getOverlayTarget(board);
  let bg = target.querySelector ? target.querySelector("#chessbot-bg-svg") : null;
  if (!bg) {
    bg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    bg.id = "chessbot-bg-svg";
    bg.setAttribute("width", rect.width);
    bg.setAttribute("height", rect.height);
    bg.style.cssText = `position:absolute;top:${dy}px;left:${dx}px;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:0;`;
    // Insert as first child so it's behind pieces in DOM stacking order
    if (target.firstChild) {
      target.insertBefore(bg, target.firstChild);
    } else {
      target.appendChild(bg);
    }
  }
  return bg;
}

/** Create or retrieve the foreground arrow SVG layer (sits on top of pieces). */
function getOrCreateArrowSvg(board, rect) {
  const { target, dx, dy } = getOverlayTarget(board);
  let svg = target.querySelector ? target.querySelector("#chessbot-arrow-svg") : null;
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "chessbot-arrow-svg";
    svg.style.cssText = `position:absolute;top:${dy}px;left:${dx}px;pointer-events:none;z-index:1000;`;
  }
  // Always (re-)append so the SVG is the last child — ensures it renders
  // on top of chess.com's own overlays (highlights, animations) that may
  // have been inserted after our SVG since the last draw cycle.
  target.appendChild(svg);
  svg.setAttribute("width", rect.width);
  svg.setAttribute("height", rect.height);
  svg.style.width = `${rect.width}px`;
  svg.style.height = `${rect.height}px`;
  svg.innerHTML = "";
  return svg;
}

/** Draw a coloured square highlight: fill on background SVG (behind pieces), border on foreground SVG (on top). */
function drawSquareHighlight(svg, file, rank, sqSize, flipped, color, style, bgSvg) {
  const tl = squareTopLeft(file, rank, sqSize, flipped);
  // Filled rectangle on background layer (behind pieces)
  if (bgSvg) {
    const fill = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    fill.setAttribute("x", tl.x);
    fill.setAttribute("y", tl.y);
    fill.setAttribute("width", sqSize);
    fill.setAttribute("height", sqSize);
    fill.setAttribute("fill", color);
    bgSvg.appendChild(fill);
  }
  // Border on foreground layer (on top of pieces)
  const strokeW = Math.max(3, sqSize * 0.06);
  const inset = strokeW / 2 + 1;
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", tl.x + inset);
  rect.setAttribute("y", tl.y + inset);
  rect.setAttribute("width", sqSize - inset * 2);
  rect.setAttribute("height", sqSize - inset * 2);
  rect.setAttribute("rx", "3");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke", color);
  rect.setAttribute("stroke-width", strokeW);
  if (style !== "from") {
    rect.setAttribute("stroke-dasharray", `${sqSize * 0.14} ${sqSize * 0.08}`);
  }
  svg.appendChild(rect);
}

// ── Training mode ────────────────────────────────────────────

/**
 * Draw progressive training hints:
 * Stage 0: Highlight the piece to move (source square only)
 * Stage 1: Also highlight the zone (rank or file of destination)
 * Stage 2: Full reveal (same as normal)
 */
function drawTrainingHint(uci, bestLine, source) {
  clearArrow();
  if (!uci || uci.length < 3) return;
  const geo = getBoardGeometry();
  if (!geo) return;
  const { board, rect, sqSize, flipped } = geo;
  const squares = uciToSquares(uci);
  if (!squares) return;
  const { from, to } = squares;
  const isDrop = !!squares.drop;

  const bgSvg = getOrCreateBgSvg(board, rect);

  const svg = getOrCreateArrowSvg(board, rect);

  const hintColor = "rgba(168,85,247,0.5)"; // purple
  const borderColor = "rgba(168,85,247,0.9)";
  const zoneColor = "rgba(168,85,247,0.2)";

  // For drop moves, skip the source-square hint (there is no source square)
  if (isDrop) {
    // Just show the destination in training
    if (trainingStage >= 2) {
      drawSingleMove(uci, bestLine, source);
    } else {
      // Show "Drop a piece" hint
      const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
      txt.setAttribute("x", rect.width / 2);
      txt.setAttribute("y", 18);
      txt.setAttribute("text-anchor", "middle");
      txt.setAttribute("font-size", Math.max(10, sqSize * 0.14));
      txt.setAttribute("font-weight", "600");
      txt.setAttribute("fill", "rgba(168,85,247,0.7)");
      txt.setAttribute("font-family", "'Inter', sans-serif");
      txt.textContent = "Drop a piece";
      svg.appendChild(txt);
    }
    return;
  }

  const fromPos = squareTopLeft(from.file, from.rank, sqSize, flipped);

  if (trainingDifficulty === "hard") {
    // Hard mode: just a subtle purple border around the entire board, no piece hints
    const boardBorder = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    boardBorder.setAttribute("x", 2);
    boardBorder.setAttribute("y", 2);
    boardBorder.setAttribute("width", rect.width - 4);
    boardBorder.setAttribute("height", rect.height - 4);
    boardBorder.setAttribute("rx", "4");
    boardBorder.setAttribute("fill", "none");
    boardBorder.setAttribute("stroke", "rgba(168,85,247,0.4)");
    boardBorder.setAttribute("stroke-width", "3");
    svg.appendChild(boardBorder);
    // "Your move" text
    const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
    txt.setAttribute("x", rect.width / 2);
    txt.setAttribute("y", 18);
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("font-size", Math.max(10, sqSize * 0.14));
    txt.setAttribute("font-weight", "600");
    txt.setAttribute("fill", "rgba(168,85,247,0.7)");
    txt.setAttribute("font-family", "'Inter', sans-serif");
    txt.textContent = "Find the best move";
    svg.appendChild(txt);
  } else {
    // Easy/Medium: Source square highlight (which piece to move)
    // Fill on background layer (behind piece), border + "?" on foreground
    const bgFill = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bgFill.setAttribute("x", fromPos.x);
    bgFill.setAttribute("y", fromPos.y);
    bgFill.setAttribute("width", sqSize);
    bgFill.setAttribute("height", sqSize);
    bgFill.setAttribute("fill", hintColor);
    bgSvg.appendChild(bgFill);

    // Border on foreground (on top of piece)
    const strokeW = Math.max(3, sqSize * 0.06);
    const inset = strokeW / 2 + 1;
    const border = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    border.setAttribute("x", fromPos.x + inset);
    border.setAttribute("y", fromPos.y + inset);
    border.setAttribute("width", sqSize - inset * 2);
    border.setAttribute("height", sqSize - inset * 2);
    border.setAttribute("rx", "3");
    border.setAttribute("fill", "none");
    border.setAttribute("stroke", borderColor);
    border.setAttribute("stroke-width", strokeW);
    svg.appendChild(border);

    // "?" label on source square (foreground, on top)
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", fromPos.x + sqSize / 2);
    label.setAttribute("y", fromPos.y + sqSize - 4);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", Math.max(12, sqSize * 0.22));
    label.setAttribute("font-weight", "900");
    label.setAttribute("fill", "#fff");
    label.setAttribute("font-family", "monospace");
    label.setAttribute("paint-order", "stroke");
    label.setAttribute("stroke", "rgba(0,0,0,0.5)");
    label.setAttribute("stroke-width", "3");
    label.textContent = "?";
    svg.appendChild(label);
  } // end easy/medium source square block

  // Remove any old hint button
  // (will create a new one below the board after appending the SVG)

  if (trainingStage >= 1) {
    // Stage 1: Context-aware zone hint based on piece type
    // Look up the piece from the FEN at the source square
    const fen = trainingLastFen || "";
    const fenBoard = fen.split(" ")[0] || "";
    const fenRows = fenBoard.split("/");
    let piece = "";
    if (fenRows.length === 8) {
      const row = fenRows[7 - from.rank]; // rank 0 = row index 7
      let col = 0;
      for (const ch of row) {
        if (ch >= "1" && ch <= "8") col += parseInt(ch);
        else { if (col === from.file) { piece = ch.toLowerCase(); break; } col++; }
      }
    }

    const isDiagonal = Math.abs(to.file - from.file) === Math.abs(to.rank - from.rank) && to.file !== from.file;
    const isStraight = to.file === from.file || to.rank === from.rank;

    if (piece === "p" || piece === "k") {
      // Pawns: file is obvious. Kings: limited range. Just highlight destination square.
      const destPos = squareTopLeft(to.file, to.rank, sqSize, flipped);
      const zone = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      zone.setAttribute("x", destPos.x);
      zone.setAttribute("y", destPos.y);
      zone.setAttribute("width", sqSize);
      zone.setAttribute("height", sqSize);
      zone.setAttribute("fill", zoneColor);
      bgSvg.appendChild(zone);
    } else if ((piece === "b" || (piece === "q" && isDiagonal)) && isDiagonal) {
      // Bishops / Queens moving diagonally: highlight the diagonal
      const df = to.file > from.file ? 1 : -1;
      const dr = to.rank > from.rank ? 1 : -1;
      let f = from.file, r = from.rank;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        const pos = squareTopLeft(f, r, sqSize, flipped);
        const zone = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        zone.setAttribute("x", pos.x);
        zone.setAttribute("y", pos.y);
        zone.setAttribute("width", sqSize);
        zone.setAttribute("height", sqSize);
        zone.setAttribute("fill", zoneColor);
        bgSvg.appendChild(zone);
        f += df; r += dr;
      }
    } else if ((piece === "r" || (piece === "q" && isStraight)) && isStraight) {
      // Rooks / Queens moving straight: highlight the rank or file they're moving along
      if (to.file === from.file) {
        // Moving along a file — highlight the rank of destination
        for (let f = 0; f < 8; f++) {
          const pos = squareTopLeft(f, to.rank, sqSize, flipped);
          const zone = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          zone.setAttribute("x", pos.x);
          zone.setAttribute("y", pos.y);
          zone.setAttribute("width", sqSize);
          zone.setAttribute("height", sqSize);
          zone.setAttribute("fill", zoneColor);
          bgSvg.appendChild(zone);
        }
      } else {
        // Moving along a rank — highlight the file of destination
        for (let r = 0; r < 8; r++) {
          const pos = squareTopLeft(to.file, r, sqSize, flipped);
          const zone = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          zone.setAttribute("x", pos.x);
          zone.setAttribute("y", pos.y);
          zone.setAttribute("width", sqSize);
          zone.setAttribute("height", sqSize);
          zone.setAttribute("fill", zoneColor);
          bgSvg.appendChild(zone);
        }
      }
    } else {
      // Knights or fallback: highlight the destination file
      for (let r = 0; r < 8; r++) {
        const pos = squareTopLeft(to.file, r, sqSize, flipped);
        const zone = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        zone.setAttribute("x", pos.x);
        zone.setAttribute("y", pos.y);
        zone.setAttribute("width", sqSize);
        zone.setAttribute("height", sqSize);
        zone.setAttribute("fill", zoneColor);
        bgSvg.appendChild(zone);
      }
    }
  }

  if (trainingStage >= 2) {
    // Stage 2: Full reveal — draw the actual move
    clearArrow();
    drawSingleMove(uci, bestLine, source);
    return;
  }

  // Score badge will be placed as HTML element below the board

  const { target: parent, dx, dy } = getOverlayTarget(board);
  if (!parent) return;
  svg.style.left = `${dx}px`;
  svg.style.top = `${dy}px`;
  parent.appendChild(svg);

  // Remove old hint button and score badge
  parent.querySelectorAll(".chessbot-hint-btn, .chessbot-score-badge").forEach(el => el.remove());

  // Hint button below the board — hidden in hard mode, limited in easy mode
  // Hard: no hints at all. Easy: starts at stage 1, 1 hint to reveal. Medium: starts at 0, 2 hints.
  const canHint = trainingDifficulty !== "hard" && trainingStage < 2;
  if (canHint) {
    const btnSize = Math.max(28, sqSize * 0.42);
    const fontSize = Math.max(11, btnSize * 0.4);
    const btn = document.createElement("button");
    btn.className = "chessbot-hint-btn";
    btn.textContent = "Hint";
    btn.style.cssText = `
      position:absolute;
      left:${dx + rect.width / 2 - btnSize / 2}px;
      top:${dy + rect.height + 6}px;
      width:${btnSize}px; height:${btnSize}px;
      background:rgba(168,85,247,0.9); color:#fff;
      border:none; border-radius:4px; cursor:pointer;
      font-size:${fontSize}px; font-weight:700;
      font-family:'Inter',sans-serif;
      z-index:1001; pointer-events:auto;
      box-shadow:0 2px 6px rgba(0,0,0,0.3);
      display:flex; align-items:center; justify-content:center;
      line-height:1; padding:0;
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      trainingStage++;
      drawTrainingHint(uci, bestLine, source);
    });
    parent.appendChild(btn);

    // Score tracker to the right of the hint button
    const scoreEl = document.createElement("span");
    scoreEl.className = "chessbot-score-badge";
    const scoreFontSize = Math.max(13, btnSize * 0.45);
    scoreEl.style.cssText = `
      position:absolute;
      left:${dx + rect.width / 2 + btnSize / 2 + 8}px;
      top:${dy + rect.height + 6}px;
      height:${btnSize}px;
      display:flex; align-items:center;
      font-size:${scoreFontSize}px; font-weight:700;
      font-family:'Inter',sans-serif;
      color:rgba(168,85,247,0.9);
      z-index:1001; pointer-events:none;
      text-shadow:0 1px 3px rgba(0,0,0,0.4);
    `;
    scoreEl.textContent = `${trainingCorrect}/${trainingTotal}`;
    parent.appendChild(scoreEl);
  } else if (trainingStage < 2) {
    // Hard mode: still show score badge (centered below board)
    const btnSize = Math.max(28, sqSize * 0.42);
    const scoreEl = document.createElement("span");
    scoreEl.className = "chessbot-score-badge";
    const scoreFontSize = Math.max(13, btnSize * 0.45);
    scoreEl.style.cssText = `
      position:absolute;
      left:${dx + rect.width / 2}px;
      top:${dy + rect.height + 6}px;
      height:${btnSize}px;
      transform:translateX(-50%);
      display:flex; align-items:center;
      font-size:${scoreFontSize}px; font-weight:700;
      font-family:'Inter',sans-serif;
      color:rgba(168,85,247,0.9);
      z-index:1001; pointer-events:none;
      text-shadow:0 1px 3px rgba(0,0,0,0.4);
    `;
    scoreEl.textContent = `${trainingCorrect}/${trainingTotal}`;
    parent.appendChild(scoreEl);
  }
}

/**
 * Apply a UCI move to a FEN and return the resulting board part (piece placement only).
 * Handles standard moves, captures, castling, en passant, and promotions.
 */
function applyUciMove(fen, uci) {
  if (!fen || !uci || uci.length < 4) return null;
  const parts = fen.split(" ");
  const board = parts[0];
  const rows = board.split("/");
  // Expand FEN rows into 8x8 grid
  const grid = rows.map(row => {
    let expanded = "";
    for (const ch of row) {
      if (ch >= "1" && ch <= "8") expanded += ".".repeat(parseInt(ch));
      else expanded += ch;
    }
    return expanded.split("");
  });

  const fc = uci.charCodeAt(0) - 97; // from col 0-7
  const fr = 8 - parseInt(uci[1]);    // from row 0-7 (0=rank8)
  const tc = uci.charCodeAt(2) - 97;
  const tr = 8 - parseInt(uci[3]);
  const promo = uci.length > 4 ? uci[4] : null;

  const piece = grid[fr][fc];
  if (piece === ".") return null;

  // Check if destination square was empty before moving (needed for en passant detection)
  const destWasEmpty = grid[tr][tc] === ".";

  // Move the piece
  grid[fr][fc] = ".";
  let placed = piece;
  if (promo) placed = piece === piece.toUpperCase() ? promo.toUpperCase() : promo.toLowerCase();
  grid[tr][tc] = placed;

  // Castling — move the rook
  if (piece.toLowerCase() === "k" && Math.abs(fc - tc) === 2) {
    if (tc > fc) { grid[fr][7] = "."; grid[fr][5] = piece === "K" ? "R" : "r"; } // kingside
    else { grid[fr][0] = "."; grid[fr][3] = piece === "K" ? "R" : "r"; }         // queenside
  }

  // En passant — remove captured pawn
  // A pawn moving diagonally to an empty square must be en passant
  if (piece.toLowerCase() === "p" && fc !== tc && destWasEmpty) {
    const epRow = piece === "P" ? tr + 1 : tr - 1;
    if (epRow >= 0 && epRow < 8) {
      const captured = grid[epRow][tc];
      if (captured.toLowerCase() === "p" && captured !== piece) grid[epRow][tc] = ".";
    }
  }

  // Compress grid back to FEN board part
  return grid.map(row => {
    let s = "", empty = 0;
    for (const c of row) {
      if (c === ".") empty++;
      else { if (empty) { s += empty; empty = 0; } s += c; }
    }
    if (empty) s += empty;
    return s;
  }).join("/");
}

/** Check if the user's move matched the engine's suggestion */
function checkTrainingAccuracy(currentFen) {
  if (!trainingMode || !trainingBestMove || !trainingLastFen) return;
  const currentBoard = currentFen.split(" ")[0];
  const trainingBoard = trainingLastFen.split(" ")[0];
  if (currentBoard === trainingBoard) return; // same position, no move made yet

  trainingTotal++;

  // Apply the engine's best move to the training FEN and compare
  const expectedBoard = applyUciMove(trainingLastFen, trainingBestMove);
  let isCorrect = expectedBoard && currentBoard === expectedBoard;

  // Non-strict mode: also accept any of the top 3 engine moves
  if (!isCorrect && !trainingStrict && trainingLines.length > 1) {
    for (let i = 1; i < trainingLines.length && i < 3; i++) {
      const altMove = trainingLines[i]?.pv?.[0];
      if (altMove) {
        const altBoard = applyUciMove(trainingLastFen, altMove);
        if (altBoard && currentBoard === altBoard) { isCorrect = true; break; }
      }
    }
  }

  if (isCorrect) {
    trainingCorrect++;
    trainingStreak++;
  } else {
    trainingStreak = 0;
  }

  // Show visual + audio feedback
  showTrainingFeedback(isCorrect);
  if (trainingSound) playTrainingSound(isCorrect);

  // Broadcast stats to panel
  broadcastTrainingStats();

  // Auto-reveal: show the correct move briefly after user plays wrong
  if (trainingAutoReveal && !isCorrect && trainingBestMove) {
    const revealMove = trainingBestMove;
    const revealLines = trainingLines.slice();
    trainingRevealActive = true;
    // Delay slightly so user sees the feedback flash first
    setTimeout(() => {
      const bestLine = revealLines[0] || null;
      drawSingleMove(revealMove, bestLine, "engine");
      // Clear after 2.5 seconds and resume analysis
      setTimeout(() => {
        trainingRevealActive = false;
        clearArrow();
        resendCurrentPosition();
      }, 2500);
    }, 600);
  }

  trainingBestMove = null;
  trainingLastFen = "";
  trainingStage = 0;
  trainingLines = [];
}

/** Broadcast training stats to panel via WebSocket */
function broadcastTrainingStats() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "broadcast",
      payload: {
        type: "training_stats_update",
        correct: trainingCorrect,
        total: trainingTotal,
        streak: trainingStreak,
      }
    }));
  }
}

/** Play a simple tone for correct/wrong using Web Audio API */
function playTrainingSound(correct) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.15;
    if (correct) {
      // Rising pleasant tone
      osc.type = "sine";
      osc.frequency.setValueAtTime(523, ctx.currentTime); // C5
      osc.frequency.setValueAtTime(659, ctx.currentTime + 0.1); // E5
      osc.frequency.setValueAtTime(784, ctx.currentTime + 0.2); // G5
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } else {
      // Low buzzy tone
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(200, ctx.currentTime);
      osc.frequency.setValueAtTime(150, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    }
    // Cleanup
    osc.onended = () => ctx.close();
  } catch {}
}

/** Flash a green (correct) or red (wrong) border overlay on the board */
function showTrainingFeedback(correct) {
  const geo = getBoardGeometry();
  if (!geo) return;
  const { board, rect } = geo;
  const { target: parent, dx, dy } = getOverlayTarget(board);
  if (!parent) return;

  const overlay = document.createElement("div");
  overlay.className = "chessbot-training-feedback";
  overlay.style.cssText = `
    position:absolute; top:${dy}px; left:${dx}px;
    width:${rect.width}px; height:${rect.height}px;
    pointer-events:none; z-index:1001;
    border: 4px solid ${correct ? "rgba(16,185,129,0.9)" : "rgba(231,76,60,0.9)"};
    border-radius: 4px;
    background: ${correct ? "rgba(16,185,129,0.12)" : "rgba(231,76,60,0.12)"};
    transition: opacity 0.6s ease-out;
    opacity: 1;
  `;

  // Emoji icon in center
  const icon = document.createElement("div");
  icon.style.cssText = `
    position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
    font-size:${Math.max(32, rect.width * 0.1)}px;
    opacity:0.9; pointer-events:none;
  `;
  icon.textContent = correct ? "\u2714" : "\u2718";
  overlay.appendChild(icon);

  parent.appendChild(overlay);
  // Fade out and remove
  setTimeout(() => { overlay.style.opacity = "0"; }, 800);
  setTimeout(() => { overlay.remove(); }, 1500);
}

// ── Single best move: green squares (our move) + red squares (opponent response) ──

function drawSingleMove(uci, bestLine, source) {
  clearArrow();
  if (!uci || uci.length < 3) return;
  const geo = getBoardGeometry();
  if (!geo) { console.log("[chessbot] drawSingleMove: no board geometry"); return; }
  const { board, rect, sqSize, flipped } = geo;
  console.log(`[chessbot] drawing move ${uci} on board ${rect.width}x${rect.height} sq=${sqSize} flipped=${flipped}`);
  const squares = uciToSquares(uci);
  if (!squares) { console.log("[chessbot] drawSingleMove: invalid UCI move"); return; }
  const { from, to } = squares;
  const isDrop = !!squares.drop;
  const isBook = source === "book" || source === "lichess";

  const svg = getOrCreateArrowSvg(board, rect);

  const moveColor = source === "lichess" ? "rgba(66,133,244,0.95)" : isBook ? "rgba(212,160,23,0.9)" : "rgba(16,185,129,0.9)";
  const boxColorFrom = source === "lichess" ? "rgba(66,133,244,0.4)" : isBook ? "rgba(212,160,23,0.4)" : "rgba(16,185,129,0.4)";
  const boxColorTo   = source === "lichess" ? "rgba(66,133,244,0.5)" : isBook ? "rgba(212,160,23,0.5)" : "rgba(16,185,129,0.5)";

  // Background SVG for fills (behind pieces)
  const bgSvg = (displayMode === "box" || displayMode === "both") ? getOrCreateBgSvg(board, rect) : null;

  // Box highlights (drawn first so they sit behind arrows)
  if (displayMode === "box" || displayMode === "both") {
    if (from) drawSquareHighlight(svg, from.file, from.rank, sqSize, flipped, boxColorFrom, "from", bgSvg);
    drawSquareHighlight(svg, to.file, to.rank, sqSize, flipped, boxColorTo, "to", bgSvg);
  }

  // Arrow (or drop circle for drop moves)
  if (displayMode === "arrow" || displayMode === "both") {
    if (isDrop) {
      drawDropMarker(svg, to.file, to.rank, sqSize, flipped, moveColor, squares.drop);
    } else {
      drawArrowOnBoard(svg, from.file, from.rank, to.file, to.rank, sqSize, flipped, moveColor);
    }
  }

  // Red opponent response
  if (showOpponentResponse && bestLine && bestLine.pv && bestLine.pv.length >= 2) {
    const response = bestLine.pv[1];
    if (response && response.length >= 3) {
      const resp = uciToSquares(response);
      if (resp) {
      const respIsDrop = !!resp.drop;
      if (displayMode === "box" || displayMode === "both") {
        // Skip highlight if square overlaps with best-move squares to avoid muddy blending
        const sameAsFrom = (sq) => from && sq && sq.file === from.file && sq.rank === from.rank;
        const sameAsTo = (sq) => sq && sq.file === to.file && sq.rank === to.rank;
        if (resp.from && !sameAsFrom(resp.from) && !sameAsTo(resp.from)) {
          drawSquareHighlight(svg, resp.from.file, resp.from.rank, sqSize, flipped, "rgba(231,76,60,0.4)", "from", bgSvg);
        }
        if (!sameAsFrom(resp.to) && !sameAsTo(resp.to)) {
          drawSquareHighlight(svg, resp.to.file, resp.to.rank, sqSize, flipped, "rgba(231,76,60,0.5)", "to", bgSvg);
        }
      }
      if (displayMode === "arrow" || displayMode === "both") {
        if (respIsDrop) {
          drawDropMarker(svg, resp.to.file, resp.to.rank, sqSize, flipped, "hsla(350,100%,50%,0.7)", resp.drop, 0.7);
        } else {
          drawArrowOnBoard(svg, resp.from.file, resp.from.rank, resp.to.file, resp.to.rank, sqSize, flipped, "hsla(350,100%,50%,0.7)", 0.7);
        }
      }
      }
    }
  }

  // Badge on destination square — "OB" for book, eval score for engine
  const dst = squareTopLeft(to.file, to.rank, sqSize, flipped);
  const badgeH = sqSize * 0.28;
  const fontSize = Math.max(9, sqSize * 0.17);
  if (isBook) {
    const badgeFill = source === "lichess" ? "rgba(66,133,244,0.9)" : "rgba(160,120,0,0.85)";
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", dst.x);
    bg.setAttribute("y", dst.y + sqSize - badgeH);
    bg.setAttribute("width", sqSize);
    bg.setAttribute("height", badgeH);
    bg.setAttribute("fill", badgeFill);
    bg.setAttribute("rx", "2");
    svg.appendChild(bg);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", dst.x + sqSize / 2);
    text.setAttribute("y", dst.y + sqSize - 4);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", fontSize);
    text.setAttribute("font-weight", "800");
    text.setAttribute("font-family", "monospace");
    text.setAttribute("fill", "#fff");
    text.textContent = source === "lichess" ? "LI" : "OB";
    svg.appendChild(text);
  } else if (bestLine) {
    const scoreText = formatScore(bestLine);
    const losing = isLineLosing(bestLine);
    const badgeBg = losing ? "rgba(231,76,60,0.85)" : "rgba(0,0,0,0.6)";
    const textColor = losing ? "#fff" : "#fff";
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", dst.x);
    bg.setAttribute("y", dst.y + sqSize - badgeH);
    bg.setAttribute("width", sqSize);
    bg.setAttribute("height", badgeH);
    bg.setAttribute("fill", badgeBg);
    bg.setAttribute("rx", "2");
    svg.appendChild(bg);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", dst.x + sqSize / 2);
    text.setAttribute("y", dst.y + sqSize - 4);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", fontSize);
    text.setAttribute("font-weight", "800");
    text.setAttribute("font-family", "monospace");
    text.setAttribute("fill", textColor);
    text.textContent = scoreText;
    svg.appendChild(text);
  }
}

// ── Multi-PV: colored eval badges on destination squares ─────

const EVAL_COLORS = [
  "#2ecc71", // best — green
  "#00bcd4", // 2nd — cyan
  "#f39c12", // 3rd — orange
  "#e74c3c", // 4th — red
  "#9b59b6", // 5th — purple
];

function formatScore(line) {
  if (line.mate !== undefined && line.mate !== null) {
    return (line.mate >= 0 ? "+" : "\u2212") + "M" + Math.abs(line.mate);
  }
  if (line.score !== undefined && line.score !== null) {
    const val = line.score / 100;
    return (val >= 0 ? "+" : "") + val.toFixed(1);
  }
  return "?";
}

/** Is this line losing for the side to move? */
function isLineLosing(line) {
  if (line.mate !== undefined && line.mate !== null) return line.mate < 0;
  if (line.score !== undefined && line.score !== null) return line.score < -50;
  return false;
}

function drawMultiPV(lines) {
  clearArrow();
  const geo = getBoardGeometry();
  if (!geo) return;
  const { board, rect, sqSize, flipped } = geo;

  // Create or reuse SVG layer for arrows
  const svg = getOrCreateArrowSvg(board, rect);

  // Background SVG for fills (behind pieces)
  const bgSvg = (displayMode === "box" || displayMode === "both") ? getOrCreateBgSvg(board, rect) : null;

  // Draw highlights + arrows for each PV line
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.move || line.move.length < 3) continue;
    const lineSquares = uciToSquares(line.move);
    if (!lineSquares) continue;
    const { from, to } = lineSquares;
    const lineDrop = !!lineSquares.drop;
    // Use red for losing lines, otherwise position-based color
    const losing = isLineLosing(line);
    const color = losing ? "#e74c3c" : (EVAL_COLORS[i] || EVAL_COLORS[EVAL_COLORS.length - 1]);
    const opacity = i === 0 ? 0.9 : 0.6;
    // Box highlights first (behind arrows)
    if (displayMode === "box" || displayMode === "both") {
      const boxAlpha = i === 0 ? 0.5 : 0.35;
      const hexToRgba = (hex, a) => {
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        return `rgba(${r},${g},${b},${a})`;
      };
      const bc = color.startsWith("#") ? hexToRgba(color, boxAlpha) : color.replace(")", `,${boxAlpha})`).replace("rgb(", "rgba(");
      if (from) drawSquareHighlight(svg, from.file, from.rank, sqSize, flipped, bc, "from", bgSvg);
      drawSquareHighlight(svg, to.file, to.rank, sqSize, flipped, bc, "to", bgSvg);
    }
    if (displayMode === "arrow" || displayMode === "both") {
      if (lineDrop) {
        drawDropMarker(svg, to.file, to.rank, sqSize, flipped, color, lineSquares.drop, opacity);
      } else {
        drawArrowOnBoard(svg, from.file, from.rank, to.file, to.rank, sqSize, flipped, color, opacity);
      }
    }
    parsed.push({ line, from, to, color, dk: `${to.file},${to.rank}` });
  }

  // Draw eval badges on destination squares — stack vertically when sharing a square
  const badgeH = sqSize * 0.28;
  const dstSlots = {};
  for (const { line, from, to, color, dk } of parsed) {
    const dst = squareTopLeft(to.file, to.rank, sqSize, flipped);
    const scoreText = formatScore(line);
    const sanMove = (line.san && line.san[0]) ? line.san[0] : "";
    const badgeText = sanMove ? `${sanMove} ${scoreText}` : scoreText;
    if (!dstSlots[dk]) dstSlots[dk] = 0;
    const slot = dstSlots[dk]++;
    const fontSize = Math.max(10, sqSize * 0.20);

    const badgeLosing = isLineLosing(line);
    const badgeBgColor = badgeLosing ? "#e74c3c" : color;

    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", dst.x);
    bg.setAttribute("y", dst.y + slot * badgeH);
    bg.setAttribute("width", sqSize);
    bg.setAttribute("height", badgeH);
    bg.setAttribute("fill", badgeBgColor);
    bg.setAttribute("rx", "3");
    svg.appendChild(bg);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", dst.x + sqSize / 2);
    text.setAttribute("y", dst.y + slot * badgeH + badgeH * 0.75);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", fontSize);
    text.setAttribute("font-weight", "800");
    text.setAttribute("font-family", "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, monospace");
    text.setAttribute("fill", "#fff");
    text.textContent = badgeText;
    svg.appendChild(text);
  }
}

// ── Inject SVG overlay into board container ──────────────────

/** Return the overlay parent and the pixel offset of the board within it.
 *  On lichess we inject directly into cg-board to avoid offset issues
 *  (cg-board → cg-container → cg-wrap introduces fractional pixel drift). */
function getOverlayTarget(board) {
  if (!board) return { target: null, dx: 0, dy: 0 };
  if (IS_CHESSGROUND) {
    const pos = getComputedStyle(board).position;
    if (pos === "static") board.style.position = "relative";
    return { target: board, dx: 0, dy: 0 };
  }
  if (SITE === "chesstempo") {
    // ChessTempo: board element is already the inner holder (no shadow root)
    const pos = getComputedStyle(board).position;
    if (pos === "static") board.style.position = "relative";
    return { target: board, dx: 0, dy: 0 };
  }
  // Chess.com: wc-chess-board is a web component — inject into its shadow root
  if (board.shadowRoot) {
    return { target: board.shadowRoot, dx: 0, dy: 0 };
  }
  // Chess.com variant pages: board wrapper may be 0x0, inject into the visual child
  const boardRect = board.getBoundingClientRect();
  if (boardRect.width === 0) {
    // Find the visual board child for overlay injection
    const visualChild = board.querySelector("[class*='boardCenter'], [class*='BoardCenter'], [class*='pieces'], [class*='Pieces']");
    if (visualChild) {
      const pos = getComputedStyle(visualChild).position;
      if (pos === "static") visualChild.style.position = "relative";
      return { target: visualChild, dx: 0, dy: 0 };
    }
  }
  // Fallback: use the board element itself with position:relative
  const pos = getComputedStyle(board).position;
  if (pos === "static") board.style.position = "relative";
  return { target: board, dx: 0, dy: 0 };
}

function injectOverlay(board, svg) {
  const { target, dx, dy } = getOverlayTarget(board);
  if (!target) return;
  if (dx || dy) {
    svg.style.left = `${dx}px`;
    svg.style.top = `${dy}px`;
  }
  target.appendChild(svg);
  console.log(`[chessbot] overlay injected into ${target.tagName}.${target.className} (offset ${dx},${dy})`);
}

// ── Eval bar + WDL display ───────────────────────────────────

function drawEvalBar(bestLine, source, tablebase) {
  // Remove existing
  const old = document.getElementById("chessbot-eval-bar");
  if (old) old.remove();

  const isBook = source === "book" || source === "lichess";
  if (!bestLine && !isBook) return;

  const board = getBoardElement();
  if (!board) return;

  const { target: parent, dx, dy } = getOverlayTarget(board);
  if (!parent) return;

  const rect = (SITE === "chesscom") ? getVisualBoardRect(board) : board.getBoundingClientRect();
  if (rect.width <= 0) return;
  const playerColor = getPlayerColor();
  const flipped = (SITE === "chesscom" && board && isChesscomFlipped(board)) ||
                  (IS_CHESSGROUND && isLichessFlipped()) ||
                  (SITE === "chesstempo" && isChesstempFlipped());

  // Build the eval bar container
  // For drop-variant games, place eval bar on the RIGHT to avoid pocket overlap
  const isDropVar = detectedVariant && DROP_VARIANTS.has(detectedVariant);
  const evalBarOnRight = SITE === "chesscom" && isDropVar;
  const evalBarLeft = evalBarOnRight ? (dx + rect.width + 6) : (dx - 28);
  const container = document.createElement("div");
  container.id = "chessbot-eval-bar";
  container.style.cssText = `
    position: absolute;
    left: ${evalBarLeft}px;
    top: ${dy}px;
    width: 22px;
    height: ${rect.height}px;
    border-radius: 3px;
    overflow: hidden;
    pointer-events: none;
    z-index: 1000;
    box-shadow: 0 0 4px rgba(0,0,0,0.4);
    display: flex;
    flex-direction: column;
  `;

  if (isBook) {
    // Show gold "OB" bar for opening book, or blue "LI" for Lichess
    const bookBar = document.createElement("div");
    const barGrad = source === "lichess"
      ? "background:linear-gradient(180deg,#3b82f6,#2563eb)"
      : "background:linear-gradient(180deg,#d4a017,#b8860b)";
    bookBar.style.cssText = `${barGrad};flex:1;display:flex;align-items:center;justify-content:center;`;
    container.appendChild(bookBar);

    const label = document.createElement("div");
    label.style.cssText = `
      position: absolute;
      top: 50%;
      left: 0;
      width: 22px;
      transform: translateY(-50%);
      text-align: center;
      font-size: 8px;
      font-weight: 900;
      font-family: monospace;
      color: #fff;
      text-shadow: 0 1px 2px rgba(0,0,0,0.5);
      pointer-events: none;
      z-index: 1;
    `;
    label.textContent = source === "lichess" ? "LI" : "OB";
    container.appendChild(label);

    parent.appendChild(container);
    return;
  }

  // Calculate white's advantage percentage (0-100)
  // Score from Stockfish is from the side-to-move perspective.
  // We set side-to-move = playerColor, so score > 0 means good for player.
  let whitePct = 50;
  if (bestLine.mate !== undefined && bestLine.mate !== null) {
    // mate > 0 = player is winning
    const playerWinning = bestLine.mate > 0;
    whitePct = (playerColor === "w") === playerWinning ? 98 : 2;
  } else if (bestLine.score !== undefined && bestLine.score !== null) {
    // Convert player-relative centipawns to white-relative
    const cpFromWhite = playerColor === "w" ? bestLine.score : -bestLine.score;
    whitePct = Math.min(98, Math.max(2, 50 + cpFromWhite / 10));
  }
  const blackPct = 100 - whitePct;

  // Standard eval bar: black on top, white on bottom (matching unflipped board).
  // When flipped: white on top, black on bottom.
  const topColor = flipped ? "#f0f0f0" : "#333";
  const botColor = flipped ? "#333" : "#f0f0f0";
  const topHeight = flipped ? whitePct : (100 - whitePct);

  const topDiv = document.createElement("div");
  topDiv.style.cssText = `background:${topColor};height:${topHeight}%;transition:height 0.5s ease;`;
  container.appendChild(topDiv);

  const botDiv = document.createElement("div");
  botDiv.style.cssText = `background:${botColor};flex:1;`;
  container.appendChild(botDiv);

  // Score label
  const scoreLabel = document.createElement("div");
  const scoreText = formatScore(bestLine);
  const isWhiteAdvantage = whitePct > 50;
  scoreLabel.style.cssText = `
    position: absolute;
    left: 0;
    width: 22px;
    text-align: center;
    font-size: 8px;
    font-weight: 800;
    font-family: monospace;
    pointer-events: none;
    z-index: 1;
    ${isWhiteAdvantage !== flipped
      ? `bottom: 2px;` : `top: 2px;`}
    color: ${isWhiteAdvantage ? "#333" : "#ccc"};
  `;
  scoreLabel.textContent = scoreText;
  container.appendChild(scoreLabel);

  // Tablebase result indicator
  if (tablebase) {
    const tbLabel = document.createElement("div");
    const tbColor = tablebase === "win" ? "#2ecc71" : tablebase === "loss" ? "#e74c3c" : "#95a5a6";
    const tbText = tablebase === "win" ? "TB+" : tablebase === "loss" ? "TB−" : "TB=";
    tbLabel.style.cssText = `
      position: absolute;
      top: 50%;
      left: 0;
      width: 22px;
      transform: translateY(-50%);
      text-align: center;
      font-size: 7px;
      font-weight: 900;
      font-family: monospace;
      color: ${tbColor};
      text-shadow: 0 1px 2px rgba(0,0,0,0.7);
      pointer-events: none;
      z-index: 2;
    `;
    tbLabel.textContent = tbText;
    container.appendChild(tbLabel);
  }

  // WDL bar at the bottom
  if (bestLine.wdl) {
    const { win, draw, loss } = bestLine.wdl;
    const total = win + draw + loss;
    if (total > 0) {
      // From player's perspective
      const pWin = ((win / total) * 100).toFixed(0);
      const pDraw = ((draw / total) * 100).toFixed(0);
      const pLoss = ((loss / total) * 100).toFixed(0);

      const wdlBox = document.createElement("div");
      wdlBox.style.cssText = `
        position: absolute;
        bottom: -22px;
        left: -4px;
        width: ${rect.width + 32}px;
        height: 18px;
        display: flex;
        border-radius: 2px;
        overflow: hidden;
        pointer-events: none;
        z-index: 1000;
        font-family: monospace;
        font-size: 9px;
        font-weight: 700;
      `;

      const winBar = document.createElement("div");
      winBar.style.cssText = `background:#2ecc71;flex:${win};display:flex;align-items:center;justify-content:center;color:#fff;`;
      winBar.textContent = pWin > 5 ? `${pWin}%` : "";

      const drawBar = document.createElement("div");
      drawBar.style.cssText = `background:#95a5a6;flex:${draw};display:flex;align-items:center;justify-content:center;color:#fff;`;
      drawBar.textContent = pDraw > 5 ? `${pDraw}%` : "";

      const lossBar = document.createElement("div");
      lossBar.style.cssText = `background:#e74c3c;flex:${loss};display:flex;align-items:center;justify-content:center;color:#fff;`;
      lossBar.textContent = pLoss > 5 ? `${pLoss}%` : "";

      wdlBox.appendChild(winBar);
      wdlBox.appendChild(drawBar);
      wdlBox.appendChild(lossBar);
      container.appendChild(wdlBox);
    }
  }

  // On chessground sites, we inject into cg-board directly. Both cg-board and its
  // ancestor cg-wrap may clip overflow. Override so the eval bar (left:-28px)
  // and WDL bar (bottom:-22px) are visible.
  if (IS_CHESSGROUND) {
    parent.style.overflow = "visible";
    const cgWrap = parent.closest(".cg-wrap");
    if (cgWrap) cgWrap.style.overflow = "visible";
  }
  parent.appendChild(container);
}

// ── Voice TTS ────────────────────────────────────────────────
function speakMove(msg) {
  if (!window.speechSynthesis) return;
  const move = msg.bestmove;
  if (!move || move === lastSpokenMove) return;
  lastSpokenMove = move;

  const parts = [];

  // Move announcement
  const lines = msg.lines || [];
  let moveText = move;
  if (lines.length && lines[0].san && lines[0].san.length) {
    moveText = lines[0].san[0];
  }
  moveText = moveText.replace(/\+/g, " check").replace(/#/g, " checkmate")
    .replace(/^O-O-O$/i, "queen side castle").replace(/^O-O$/i, "king side castle");
  parts.push(moveText);

  // Eval announcement
  if (voiceEvalEnabled && lines.length && lines[0]) {
    const line = lines[0];
    if (line.mate !== undefined && line.mate !== null) {
      parts.push(`mate in ${Math.abs(line.mate)}`);
    } else if (line.score !== undefined && line.score !== null) {
      const pawns = (line.score / 100).toFixed(1);
      parts.push(`eval ${pawns >= 0 ? "plus" : "minus"} ${Math.abs(pawns)}`);
    }
  }

  // Opening announcement
  if (voiceOpeningEnabled && msg.eco && msg.eco !== lastSpokenOpening) {
    lastSpokenOpening = msg.eco;
    parts.push(msg.eco);
  }

  const text = parts.join(". ");
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = voiceSpeed;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utt);
}

// ── Re-evaluate current position (after settings change) ─────
function resendCurrentPosition() {
  if (!enabled || !lastSentFen || waitingForOpponent) return;
  console.log(`[chessbot] re-evaluating current position after settings change`);
  pendingEval = true;
  clearMoveIndicators();
  sendFen(lastSentFen);
}

// ── Auto-move / bot mode ─────────────────────────────────────

/** Fire a synthetic mouse event on an element at page-relative coordinates. */
function fireMouse(target, type, clientX, clientY, opts = {}) {
  const ev = new MouseEvent(type, {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX, clientY,
    screenX: clientX + (window.screenX || 0),
    screenY: clientY + (window.screenY || 0),
    button: 0, buttons: type === "mouseup" ? 0 : 1,
    ...opts,
  });
  target.dispatchEvent(ev);
}

/** Fire a synthetic pointer event (needed by some modern boards). */
function firePointer(target, type, clientX, clientY, opts = {}) {
  if (typeof PointerEvent === "undefined") return;
  // For mouse input, pressure should be 0.5 when buttons are pressed, 0 otherwise.
  // Many boards check pressure > 0 to detect actual pointer contact.
  const isPress = type !== "pointerup" && type !== "pointerleave" && type !== "pointercancel";
  const ev = new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX, clientY,
    screenX: clientX + (window.screenX || 0),
    screenY: clientY + (window.screenY || 0),
    button: 0, buttons: type === "pointerup" ? 0 : 1,
    pointerId: 1, pointerType: "mouse",
    isPrimary: true,
    pressure: isPress ? 0.5 : 0,
    width: 1, height: 1,
    ...opts,
  });
  target.dispatchEvent(ev);
}

/** Get the DOM element at a board-relative position for a given site.
 *  Returns { target, clientX, clientY }. */
function getSquareTarget(file, rank) {
  const geo = getBoardGeometry();
  if (!geo) return null;
  const { board, rect, sqSize, flipped } = geo;
  const center = squareCenter(file, rank, sqSize, flipped);
  const clientX = rect.left + center.x;
  const clientY = rect.top + center.y;

  // Determine the actual event target element
  let target;
  if (SITE === "chesscom") {
    // Chess.com uses wc-chess-board (shadow DOM) or Vue-based variant boards.
    // Try elementFromPoint on the shadow root first (hits internal elements that
    // have the actual event listeners). Fall back to the board element itself
    // if elementFromPoint returns null (can happen during animations/renders).
    const sr = board.shadowRoot;
    if (sr && sr.elementFromPoint) {
      target = sr.elementFromPoint(clientX, clientY) || board;
    } else {
      target = document.elementFromPoint(clientX, clientY) || board;
    }
  } else {
    target = document.elementFromPoint(clientX, clientY) || board;
  }
  return { target, clientX, clientY };
}

/** Execute a UCI move on the board by simulating click events.
 *  uci = "e2e4", "e7e8q" (with optional promotion char), or "P@e4" (drop).
 *  attempt = retry attempt number (1-based), used to alternate strategies. */
function executeMove(uci, attempt = 1) {
  if (!uci || uci.length < 3) return false;
  const squares = uciToSquares(uci);
  if (!squares) return false;

  console.log(`[chessbot][auto-move] executing ${uci} on ${SITE} (attempt ${attempt})`);

  // Handle drop moves (e.g. P@e4)
  if (squares.drop) {
    return executeDropMove(squares.drop, squares.to);
  }

  const { from, to } = squares;
  const promo = uci.length === 5 ? uci[4] : null;

  if (SITE === "chesscom") {
    return executeMoveChessCom(from, to, promo, attempt);
  } else if (IS_CHESSGROUND) {
    return executeMoveChessground(from, to, promo);
  } else if (SITE === "chesstempo") {
    return executeMoveChesstempo(from, to, promo);
  }
  return false;
}

/** Execute a drop move by clicking the pocket piece then the destination square.
 *  pieceLetter: "P", "N", "B", "R", "Q". to: { file, rank }. */
function executeDropMove(pieceLetter, to) {
  const geo = getBoardGeometry();
  if (!geo) return false;

  const roleMap = { P: "pawn", N: "knight", B: "bishop", R: "rook", Q: "queen" };
  const role = roleMap[pieceLetter.toUpperCase()] || "pawn";

  if (IS_CHESSGROUND) {
    // Lichess/PlayStrategy: pocket pieces are in <pocket> elements
    // Determine our color from board orientation
    const flipped = isLichessFlipped();
    const ourColor = flipped ? "black" : "white";
    const pocketPiece = findPocketPiece(role, ourColor);
    if (!pocketPiece) {
      console.warn(`[chessbot][auto-move] pocket piece not found: ${role} ${ourColor}`);
      return false;
    }
    const pr = pocketPiece.getBoundingClientRect();
    const pcx = pr.left + pr.width / 2;
    const pcy = pr.top + pr.height / 2;

    // Click pocket piece — Chessground drop mode handles pocket clicks
    // through dragNewPiece, so we use mousedown on the pocket element
    const marker = { detail: 42424242 };
    fireMouse(pocketPiece, "mousedown", pcx, pcy, marker);
    setTimeout(() => {
      // Drag to destination on document, then release
      const { board, rect, sqSize, flipped } = geo;
      const dstCenter = squareCenter(to.file, to.rank, sqSize, flipped);
      const dstX = rect.left + dstCenter.x;
      const dstY = rect.top + dstCenter.y;
      fireMouse(document, "mousemove", dstX, dstY);
      setTimeout(() => {
        fireMouse(document, "mouseup", dstX, dstY);
      }, 130);
    }, 20);
    return true;
  }

  // Chess.com and other sites: try similar approach
  if (SITE === "chesscom") {
    // Chess.com Bughouse/Crazyhouse: pocket pieces may be in spare pieces area
    const pocketPiece = findPocketPieceChessCom(pieceLetter);
    if (!pocketPiece) {
      console.warn(`[chessbot][auto-move] chess.com pocket piece not found: ${pieceLetter}`);
      return false;
    }
    const pr = pocketPiece.getBoundingClientRect();
    const pcx = pr.left + pr.width / 2;
    const pcy = pr.top + pr.height / 2;

    const dst = getSquareTarget(to.file, to.rank);
    if (!dst) {
      console.warn("[chessbot][auto-move] chess.com drop: destination square not found");
      return false;
    }

    // Method: drag from pocket piece to destination square.
    firePointer(pocketPiece, "pointerdown", pcx, pcy);
    fireMouse(pocketPiece, "mousedown", pcx, pcy);

    setTimeout(() => {
      // Move to destination
      firePointer(pocketPiece, "pointermove", dst.clientX, dst.clientY);
      fireMouse(document, "mousemove", dst.clientX, dst.clientY);

      setTimeout(() => {
        // Release on destination
        firePointer(dst.target, "pointerup", dst.clientX, dst.clientY);
        fireMouse(dst.target, "mouseup", dst.clientX, dst.clientY);
      }, 80);
    }, 20);
    return true;
  }

  console.warn(`[chessbot][auto-move] drop moves not supported on ${SITE}`);
  return false;
}

/** Find a pocket piece element on Lichess/PlayStrategy (Chessground). */
function findPocketPiece(role, color) {
  // Lichess Crazyhouse pockets: <pocket> elements near the board
  // Each contains <piece> elements with class like "pawn white"
  const pockets = document.querySelectorAll("pocket, .pocket, .crazyhouse-pocket, [class*='pocket']");
  for (const pocket of pockets) {
    const pieces = pocket.querySelectorAll("piece");
    for (const piece of pieces) {
      const cl = piece.className || "";
      if (cl.includes(role) && cl.includes(color)) {
        // Check piece is available (not empty/zero count)
        const nb = piece.getAttribute("data-nb");
        if (nb && parseInt(nb) <= 0) continue;
        return piece;
      }
    }
  }
  return null;
}

/** Find a pocket piece element on Chess.com. */
function findPocketPieceChessCom(pieceLetter) {
  const board = getBoardElement();
  const boardRect = board ? getVisualBoardRect(board) : null;
  const flipped = board ? isChesscomFlipped(board) : false;

  // Determine our color: if board is flipped, we're playing black
  const ourColor = flipped ? "b" : "w";
  const target = ourColor + pieceLetter.toLowerCase(); // e.g. "wp", "bn"
  const targetType = pieceLetter.toLowerCase(); // e.g. "p", "n"

  const roots = [document];
  if (board && board.shadowRoot) roots.push(board.shadowRoot);

  for (const root of roots) {
    // Method A: look for pieces in bank/pocket/spare containers by class pattern
    const candidates = root.querySelectorAll(
      "[class*='spare'] .piece, [class*='pocket'] .piece, [class*='bank'] .piece, " +
      "[class*='Spare'] .piece, [class*='Pocket'] .piece, [class*='Bank'] .piece, " +
      "[class*='reserve'] .piece, [class*='Reserve'] .piece, " +
      "[class*='holdings'] .piece, [class*='Holdings'] .piece"
    );
    for (const el of candidates) {
      const cls = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
      // Class-based: "wp", "bn", etc.
      if (cls.includes(target)) return el;
      // data-piece + data-color (variant pages)
      const dp = (el.getAttribute("data-piece") || "").toLowerCase();
      const dc = el.getAttribute("data-color") || "";
      if (dp === targetType && _variantColorMap) {
        const isOurs = (ourColor === "w") ? (dc === _variantColorMap.white) : (dc === _variantColorMap.black);
        if (isOurs) return el;
      }
    }

    // Method B: find any piece outside the board rect that matches our piece type
    if (boardRect && boardRect.width > 0) {
      const allPieces = root.querySelectorAll(".piece, [data-piece]");
      for (const el of allPieces) {
        const pr = el.getBoundingClientRect();
        if (pr.width === 0) continue;
        const cx = pr.left + pr.width / 2 - boardRect.left;
        const cy = pr.top + pr.height / 2 - boardRect.top;
        // Must be outside the board
        if (cx >= -5 && cx <= boardRect.width + 5 && cy >= -5 && cy <= boardRect.height + 5) continue;
        const cls = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
        if (cls.includes(target)) return el;
        const dp = (el.getAttribute("data-piece") || "").toLowerCase();
        const dc = el.getAttribute("data-color") || "";
        if (dp === targetType && _variantColorMap) {
          const isOurs = (ourColor === "w") ? (dc === _variantColorMap.white) : (dc === _variantColorMap.black);
          if (isOurs) return el;
        }
      }
    }
  }
  console.warn(`[chessbot] findPocketPieceChessCom: no match for ${pieceLetter} (color=${ourColor})`);
  return null;
}

/** Chess.com: execute a move by simulating drag or click events.
 *  Primary strategy is drag (works on both standard and variant pages).
 *  Fallback is click-click for retry attempts. */
function executeMoveChessCom(from, to, promo, attemptNum = 1) {
  // Clear overlays BEFORE computing targets to avoid elementFromPoint hitting our SVGs
  clearArrow();

  const src = getSquareTarget(from.file, from.rank);
  if (!src || !src.target) return false;
  const dst = getSquareTarget(to.file, to.rank);
  if (!dst || !dst.target) return false;

  try {
    if (attemptNum <= 2) {
      // Primary strategy: drag from source to destination.
      // All pointer events simulate pointer capture (go to source element with varying coordinates).
      console.log(`[chessbot][auto-move] chess.com: trying drag approach (attempt ${attemptNum})`);
      firePointer(src.target, "pointerdown", src.clientX, src.clientY);
      fireMouse(src.target, "mousedown", src.clientX, src.clientY);
      setTimeout(() => {
        try {
          // Re-query the source square element — Chess.com may re-render after pointerdown
          // (e.g. piece selection highlight, legal move indicators). The original src.target
          // may now be a detached DOM node that ignores dispatched events.
          _geoCache = null;
          const src2 = getSquareTarget(from.file, from.rank);
          const moveEl = (src2 && src2.target) ? src2.target : src.target;
          firePointer(moveEl, "pointermove", dst.clientX, dst.clientY);
          fireMouse(document, "mousemove", dst.clientX, dst.clientY);
          setTimeout(() => {
            try {
              // pointerup goes to same element (pointer capture) with destination coordinates
              firePointer(moveEl, "pointerup", dst.clientX, dst.clientY);
              const dst2 = getSquareTarget(to.file, to.rank);
              fireMouse((dst2 && dst2.target) ? dst2.target : dst.target, "mouseup", dst.clientX, dst.clientY);
              if (promo) setTimeout(() => selectPromotionChessCom(promo), 200);
            } catch (e) { console.warn("[chessbot][auto-move] drag pointerup failed:", e.message); }
          }, 80);
        } catch (e) { console.warn("[chessbot][auto-move] drag pointermove failed:", e.message); }
      }, 30);
      return true;
    }

    // Fallback strategy (attempt 3): click source, then click destination
    console.log("[chessbot][auto-move] chess.com: trying click-click approach");
    firePointer(src.target, "pointerdown", src.clientX, src.clientY);
    fireMouse(src.target, "mousedown", src.clientX, src.clientY);
    setTimeout(() => {
      try {
        firePointer(src.target, "pointerup", src.clientX, src.clientY);
        fireMouse(src.target, "mouseup", src.clientX, src.clientY);
        fireMouse(src.target, "click", src.clientX, src.clientY);

        setTimeout(() => {
          try {
            // Re-fetch destination target (selection may have changed the DOM)
            _geoCache = null;
            const dst2 = getSquareTarget(to.file, to.rank);
            if (!dst2 || !dst2.target) return;
            firePointer(dst2.target, "pointerdown", dst2.clientX, dst2.clientY);
            fireMouse(dst2.target, "mousedown", dst2.clientX, dst2.clientY);
            setTimeout(() => {
              try {
                firePointer(dst2.target, "pointerup", dst2.clientX, dst2.clientY);
                fireMouse(dst2.target, "mouseup", dst2.clientX, dst2.clientY);
                fireMouse(dst2.target, "click", dst2.clientX, dst2.clientY);
                if (promo) setTimeout(() => selectPromotionChessCom(promo), 200);
              } catch (e) { console.warn("[chessbot][auto-move] click dst pointerup failed:", e.message); }
            }, 30);
          } catch (e) { console.warn("[chessbot][auto-move] click dst pointerdown failed:", e.message); }
        }, 80);
      } catch (e) { console.warn("[chessbot][auto-move] click src pointerup failed:", e.message); }
    }, 30);

    return true;
  } catch (e) {
    console.warn("[chessbot][auto-move] executeMoveChessCom failed:", e.message);
    return false;
  }
}

/** Chess.com promotion: find and click the promotion piece in the popup. */
function selectPromotionChessCom(promoChar, attempt = 0) {
  // Map promotion letter to class pattern used by chess.com
  const map = { q: "queen", r: "rook", b: "bishop", n: "knight" };
  const pieceName = map[promoChar.toLowerCase()] || "queen";
  const promoLetter = promoChar.toLowerCase();

  // Look in document and shadow root
  const roots = [document];
  const board = getBoardElement();
  if (board && board.shadowRoot) roots.push(board.shadowRoot);

  for (const root of roots) {
    // chess.com uses .promotion-piece with data-piece attribute (e.g. "wq", "br")
    const promoEls = root.querySelectorAll("[class*='promotion'] [class*='piece'], .promotion-piece");
    for (const el of promoEls) {
      // Prefer data-piece attribute (most reliable): e.g. "wq", "br"
      const dataPiece = el.getAttribute("data-piece") || "";
      if (dataPiece.endsWith(promoLetter)) {
        el.click();
        console.log(`[chessbot][auto-move] selected promotion: ${pieceName} (data-piece)`);
        return;
      }
      // Fallback: match piece abbreviation as a class token (e.g. "wq", "bn")
      // Use regex to avoid false matches like "r" in "promotion"
      const cls = el.className || "";
      const pieceAbbrRegex = new RegExp(`\\b[wb]${promoLetter}\\b`, "i");
      if (cls.toLowerCase().includes(pieceName) || pieceAbbrRegex.test(cls)) {
        el.click();
        console.log(`[chessbot][auto-move] selected promotion: ${pieceName}`);
        return;
      }
    }
  }
  // Retry — popup may not have appeared yet
  if (attempt < 5) {
    setTimeout(() => selectPromotionChessCom(promoChar, attempt + 1), 150);
  } else {
    console.warn(`[chessbot][auto-move] promotion popup not found for ${promoChar}`);
  }
}

/** Lichess / PlayStrategy (Chessground): select piece then click destination.
 *  Chessground binds mousedown on cg-board and mouseup/mousemove on document.
 *  Our lichess-inject.js wraps the mousedown handler to bypass isTrusted check
 *  for events with detail=42424242. We use drag simulation (mousedown → mousemove
 *  → mouseup) which is the most reliable approach regardless of the user's
 *  selectable/draggable preference settings. */
function executeMoveChessground(from, to, promo) {
  const geo = getBoardGeometry();
  if (!geo) return false;
  const { board, rect, sqSize, flipped } = geo;

  const srcCenter = squareCenter(from.file, from.rank, sqSize, flipped);
  const srcX = rect.left + srcCenter.x;
  const srcY = rect.top + srcCenter.y;

  const dstCenter = squareCenter(to.file, to.rank, sqSize, flipped);
  const dstX = rect.left + dstCenter.x;
  const dstY = rect.top + dstCenter.y;

  // Chessground rejects synthetic events via isTrusted check in drag.start().
  // Our injected page-context script (lichess-inject.js) wraps the mousedown
  // handler on cg-board and proxies isTrusted for events with this marker.
  const marker = { detail: 42424242 };

  // Drag simulation: mousedown on source → mousemove to destination → mouseup
  // on destination. This works for both drag-only and click-only user prefs.
  // Only fire mousedown on the board (Chessground only listens for mousedown,
  // not pointerdown). Fire mousemove/mouseup on document (where Chessground
  // binds those handlers).

  // Step 1: mousedown on source — Chessground selects the piece and starts drag tracking
  fireMouse(board, "mousedown", srcX, srcY, marker);

  // Step 2: mousemove to destination on document — updates drag position.
  // processDrag runs in rAF loop and sets cur.started when distance threshold met.
  setTimeout(() => {
    fireMouse(document, "mousemove", dstX, dstY);
  }, 20);

  // Step 3: mouseup on document at destination — drag.end() sees cur.started
  // and dest !== orig, calls userMove to complete the move.
  // Wait long enough for multiple rAF frames (~16ms each) after the mousemove
  // so processDrag can set cur.started = true. 150ms gives ~8 frames of margin,
  // surviving background-tab throttling and high CPU load.
  setTimeout(() => {
    fireMouse(document, "mouseup", dstX, dstY);

    // Handle promotion popup
    if (promo) {
      setTimeout(() => selectPromotionChessground(promo), 200);
    }
  }, 150);

  return true;
}

/** Lichess / PlayStrategy promotion: click the correct piece in the promotion dialog. */
function selectPromotionChessground(promoChar, attempt = 0) {
  const roleMap = { q: "queen", r: "rook", b: "bishop", n: "knight" };
  const role = roleMap[promoChar.toLowerCase()] || "queen";

  // Chessground promotion picker: pieces are inside <square> elements
  // that are direct children of cg-container (NOT inside cg-board).
  // Using "cg-container > square piece" avoids matching regular board pieces.
  const promoSquares = document.querySelectorAll("cg-container > square piece, .cg-wrap > square piece");
  for (const el of promoSquares) {
    const cls = el.className.toLowerCase();
    if (cls.includes(role)) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      firePointer(el, "pointerdown", cx, cy);
      fireMouse(el, "mousedown", cx, cy);
      setTimeout(() => {
        firePointer(el, "pointerup", cx, cy);
        fireMouse(el, "mouseup", cx, cy);
        fireMouse(el, "click", cx, cy);
      }, 30);
      console.log(`[chessbot][auto-move] selected promotion: ${role}`);
      return;
    }
  }
  // Retry — popup may not have appeared yet
  if (attempt < 5) {
    setTimeout(() => selectPromotionChessground(promoChar, attempt + 1), 150);
  } else {
    console.warn(`[chessbot][auto-move] promotion popup not found for ${promoChar}`);
  }
}

/** ChessTempo: click source, then click target. */
function executeMoveChesstempo(from, to, promo) {
  const src = getSquareTarget(from.file, from.rank);
  if (!src) return false;

  // Click source
  fireMouse(src.target, "mousedown", src.clientX, src.clientY);
  fireMouse(src.target, "mouseup", src.clientX, src.clientY);
  fireMouse(src.target, "click", src.clientX, src.clientY);

  setTimeout(() => {
    const dst = getSquareTarget(to.file, to.rank);
    if (!dst) return;

    fireMouse(dst.target, "mousedown", dst.clientX, dst.clientY);
    fireMouse(dst.target, "mouseup", dst.clientX, dst.clientY);
    fireMouse(dst.target, "click", dst.clientX, dst.clientY);

    if (promo) {
      setTimeout(() => {
        // ChessTempo shows a promotion dialog with clickable pieces
        const promoMap = { q: "queen", r: "rook", b: "bishop", n: "knight" };
        const pieceName = promoMap[promo.toLowerCase()] || "queen";
        const btns = document.querySelectorAll("[class*='promotion'] button, [class*='promote'] [class*='piece']");
        for (const btn of btns) {
          if (btn.textContent.toLowerCase().includes(pieceName) || btn.className.toLowerCase().includes(pieceName)) {
            btn.click();
            return;
          }
        }
      }, 200);
    }
  }, 80);

  return true;
}

/** Cancel any pending auto-move. */
function cancelAutoMove() {
  if (autoMoveTimer) {
    clearTimeout(autoMoveTimer);
    autoMoveTimer = null;
  }
}

/** Schedule an auto-move after a humanized delay.
 *  moveUci: the UCI move to play.
 *  lines: all PV lines (for humanization — occasionally pick 2nd/3rd best).
 *  fen: the FEN this move is for (to check staleness). */
function scheduleAutoMove(moveUci, lines, fen) {
  cancelAutoMove();

  // Don't auto-move in training mode
  if (trainingMode) return;

  // Don't auto-move if the game is over
  if (gameOver || detectGameOver()) {
    console.log("[chessbot][auto-move] game is over — skipping");
    return;
  }

  // Don't schedule while waiting for the opponent — prevents premoves
  if (waitingForOpponent) {
    console.log("[chessbot][auto-move] waiting for opponent — skipping");
    return;
  }

  // Cooldown after executing a move — prevent premoves from stale/intermediate states
  if (Date.now() < autoMoveCooldownUntil) {
    console.log("[chessbot][auto-move] cooldown active — skipping");
    return;
  }

  // Only auto-move on our own turn — prevent premoves when analyzing for "both"
  if (fen) {
    const fenTurn = fen.split(" ")[1]; // "w" or "b"
    const playerColor = getPlayerColor();
    if (fenTurn && playerColor && fenTurn !== playerColor) {
      console.log(`[chessbot][auto-move] skipping — not our turn (fen=${fenTurn} player=${playerColor})`);
      return;
    }
  }

  // Don't re-schedule auto-move for a position where all attempts already failed.
  // This prevents the retry loop: fail → readAndSend → same bestmove → fail → ...
  // The tracker is cleared when the board changes (new position).
  if (fen) {
    const fenBoard = fen.split(" ")[0];
    if (fenBoard && fenBoard === _autoMoveFailedFen) {
      console.log("[chessbot][auto-move] skipping — auto-move already failed for this position");
      return;
    }
  }

  // Determine which move to actually play
  let finalMove = moveUci;
  if (!bulletMode && autoMoveHumanize && lines && lines.length > 1 && Math.random() < autoMoveHumanizeChance) {
    // Pick a random move from the top 3 (weighted toward better moves)
    const candidates = lines.slice(0, Math.min(3, lines.length));
    // Only pick suboptimal if it's not a blunder (within 100cp of best, no mate difference)
    const best = candidates[0];
    const filtered = candidates.filter((c, i) => {
      if (i === 0) return true;
      // Don't pick a move that loses mate or drops >100cp
      if (best.mate !== undefined && c.mate === undefined) return false;
      if (best.mate !== undefined && c.mate !== undefined) return Math.sign(best.mate) === Math.sign(c.mate);
      if (c.score !== undefined && best.score !== undefined) return Math.abs(best.score - c.score) <= 100;
      return false;
    });
    if (filtered.length > 1) {
      const pick = filtered[1 + Math.floor(Math.random() * (filtered.length - 1))];
      finalMove = pick.move;
      console.log(`[chessbot][auto-move] humanized: playing ${finalMove} instead of ${moveUci}`);
    }
  }

  // Random delay within configured range (bullet mode: small delay to let DOM settle)
  const delay = bulletMode ? 150 : autoMoveDelayMin + Math.random() * (autoMoveDelayMax - autoMoveDelayMin);
  const scheduledFen = fen;

  console.log(`[chessbot][auto-move] scheduled ${finalMove} in ${Math.round(delay)}ms`);

  autoMoveTimer = setTimeout(() => {
    autoMoveTimer = null;

    // Check if game ended while we were waiting
    if (gameOver || detectGameOver()) {
      console.log("[chessbot][auto-move] game ended during delay — aborting");
      return;
    }

    // Re-verify it's still our turn at execution time using multiple methods.
    // This is critical to prevent premoves (making a move during opponent's turn).
    const playerColor = getPlayerColor();
    if (playerColor) {
      // Method 1: check lastSentFen or scheduledFen turn field
      const checkFen = lastSentFen || scheduledFen;
      if (checkFen) {
        const currentTurn = checkFen.split(" ")[1];
        if (currentTurn && currentTurn !== playerColor) {
          console.log(`[chessbot][auto-move] not our turn at execution (fen=${currentTurn} player=${playerColor}), skipping`);
          return;
        }
      }

      // Method 2: real-time DOM check — clock and move list indicate whose turn it is.
      // This catches cases where lastSentFen's turn field is stale or wrong.
      const domTurn = detectTurnFromClocks() || detectTurnFromMoveList();
      if (domTurn && domTurn !== playerColor) {
        console.log(`[chessbot][auto-move] DOM says not our turn (dom=${domTurn} player=${playerColor}), skipping premove`);
        return;
      }

      // Method 3: real-time board read — the most reliable check.
      // Read the actual board position and check whose turn it is.
      const liveFen = boardToFen();
      if (liveFen) {
        const liveBoard = liveFen.split(" ")[0];
        const scheduledBoard = scheduledFen ? scheduledFen.split(" ")[0] : null;
        if (scheduledBoard && liveBoard !== scheduledBoard) {
          console.log("[chessbot][auto-move] board position changed since scheduling, skipping");
          return;
        }
      }
    }

    // Suppress auto-move during variant switch cooldown
    if (Date.now() < variantSwitchUntil) {
      console.log("[chessbot][auto-move] variant switch cooldown — skipping");
      return;
    }

    // Verify position hasn't changed since we scheduled
    if (scheduledFen) {
      const currentBoard = (lastSentFen || "").split(" ")[0];
      const scheduledBoard = scheduledFen.split(" ")[0];
      if (currentBoard !== scheduledBoard) {
        console.log("[chessbot][auto-move] position changed, skipping stale move");
        return;
      }
    }

    // Set cooldown to prevent re-scheduling from intermediate board states
    autoMoveCooldownUntil = Date.now() + (bulletMode ? 500 : 2000);
    waitingForOpponent = true;
    _skipNextBoardChange = true; // skip analysis of our own move appearing on board
    lastSentFen = ""; // clear so we don't re-analyze the current position

    // Attempt the move with retries — DOM interactions can fail silently
    // (e.g. elementFromPoint returns wrong element, shadow DOM not ready, etc.)
    const boardBefore = lastBoardFen;
    let attempts = 0;
    const maxAttempts = 3;

    function attemptMove() {
      attempts++;
      console.log(`[chessbot][auto-move] attempt ${attempts}/${maxAttempts} for ${finalMove}`);

      let moveOk = false;
      try {
        // Clear geometry cache before each attempt to ensure fresh coordinates
        _geoCache = null;
        moveOk = executeMove(finalMove, attempts);
      } catch (e) {
        console.warn(`[chessbot][auto-move] executeMove threw (attempt ${attempts}):`, e.message);
      }

      if (!moveOk) {
        console.warn(`[chessbot][auto-move] executeMove returned false (attempt ${attempts})`);
        if (attempts < maxAttempts) {
          // Retry after a short delay
          setTimeout(attemptMove, 300);
          return;
        }
        // All attempts exhausted
        console.warn("[chessbot][auto-move] all move attempts failed — resetting state");
        waitingForOpponent = false;
        _skipNextBoardChange = false;
        autoMoveCooldownUntil = 0;
        _autoMoveFailedFen = boardBefore; // prevent re-scheduling for this position
        return;
      }

      // Move was dispatched — verify the board actually changes.
      // Wait long enough for the full async click/drag chain to complete
      // and for Chess.com to process and re-render the board.
      const verifyDelay = bulletMode ? 600 : 1000;
      setTimeout(() => {
        // Read the board to see if it changed (move was accepted by the site)
        const currentFen = boardToFen();
        const currentBoard = currentFen ? currentFen.split(" ")[0] : null;

        if (currentBoard && currentBoard !== boardBefore) {
          // Board changed — move was successful
          return;
        }

        // Board didn't change — move likely failed silently
        if (attempts < maxAttempts) {
          console.warn(`[chessbot][auto-move] board unchanged after attempt ${attempts} — retrying`);
          setTimeout(attemptMove, 200);
        } else {
          console.warn("[chessbot][auto-move] board unchanged after all attempts — resetting state");
          _skipNextBoardChange = false;
          waitingForOpponent = false;
          autoMoveCooldownUntil = 0;
          _autoMoveFailedFen = boardBefore; // prevent re-scheduling for this position
        }
      }, verifyDelay);
    }

    attemptMove();

    // Final safety net: if board hasn't changed after generous timeout, reset
    setTimeout(() => {
      if (_skipNextBoardChange) {
        console.warn("[chessbot][auto-move] move not detected on board after timeout — resetting state");
        _skipNextBoardChange = false;
        waitingForOpponent = false;
        autoMoveCooldownUntil = 0;
        _autoMoveFailedFen = boardBefore; // prevent re-scheduling for this position
      }
    }, bulletMode ? 2000 : 5000);
  }, delay);
}

// ── Toast notifications ──────────────────────────────────────
let _toastEl = null;
let _toastTimer = null;
function showToast(text, duration = 1800) {
  if (!_toastEl) {
    _toastEl = document.createElement("div");
    Object.assign(_toastEl.style, {
      position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)",
      background: "rgba(30,30,30,0.92)", color: "#fff", padding: "8px 18px",
      borderRadius: "8px", fontSize: "14px", fontFamily: "system-ui, sans-serif",
      fontWeight: "500", zIndex: "2147483647", pointerEvents: "none",
      transition: "opacity 0.25s", opacity: "0", whiteSpace: "nowrap",
      boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    });
    document.body.appendChild(_toastEl);
  }
  _toastEl.textContent = text;
  _toastEl.style.opacity = "1";
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { _toastEl.style.opacity = "0"; }, duration);
}

// ── Hotkeys ──────────────────────────────────────────────────
// Alt+A = resume analysis, Alt+S = stop analysis
// Alt+W = set side to white, Alt+Q = set side to black
document.addEventListener("keydown", (e) => {
  if (!e.altKey) return;
  // Use e.code instead of e.key — Alt+key produces Unicode chars on many OS/layouts
  const code = e.code;
  if (code === "KeyA") {
    e.preventDefault();
    if (!enabled) {
      enabled = true;
      console.log("[chessbot] resumed via hotkey (Alt+A)");
      showToast("Analysis resumed");
      readAndSend();
    }
  } else if (code === "KeyS") {
    e.preventDefault();
    if (enabled) {
      enabled = false;
      console.log("[chessbot] stopped via hotkey (Alt+S)");
      showToast("Analysis stopped");
      clearArrow();
    }
  } else if (code === "KeyW") {
    e.preventDefault();
    runEngineFor = "me";
    waitingForOpponent = false;
    lastSentFen = "";
    pendingEval = false;
    console.log("[chessbot] hotkey: analyze for Me (Alt+W)");
    showToast("Analyzing for Me");
    readAndSend();
  } else if (code === "KeyQ") {
    e.preventDefault();
    runEngineFor = "opponent";
    waitingForOpponent = false;
    lastSentFen = "";
    pendingEval = false;
    console.log("[chessbot] hotkey: analyze for Opponent (Alt+Q)");
    showToast("Analyzing for Opponent");
    readAndSend();
  } else if (code === "KeyT") {
    e.preventDefault();
    trainingMode = !trainingMode;
    trainingStage = 0;
    trainingBestMove = null;
    console.log(`[chessbot] training mode: ${trainingMode} (Alt+T)`);
    showToast(`Training mode: ${trainingMode ? "ON" : "OFF"}`);
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ chessbot_trainingMode: trainingMode });
    }
    // Notify server/panel so the toggle stays in sync
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "broadcast", payload: { type: "set_training_mode", value: trainingMode } }));
    }
    resendCurrentPosition();
  } else if (code === "KeyM") {
    e.preventDefault();
    autoMoveEnabled = !autoMoveEnabled;
    console.log(`[chessbot] auto-move: ${autoMoveEnabled} (Alt+M)`);
    showToast(`Auto-move: ${autoMoveEnabled ? "ON" : "OFF"}`);
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ chessbot_autoMove: autoMoveEnabled });
    }
    // Notify server/panel so the toggle stays in sync
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "broadcast", payload: { type: "set_auto_move", value: autoMoveEnabled } }));
    }
    if (!autoMoveEnabled) cancelAutoMove();
  } else if (code === "KeyB") {
    e.preventDefault();
    bulletMode = !bulletMode;
    console.log(`[chessbot] bullet mode: ${bulletMode} (Alt+B)`);
    showToast(`Bullet mode: ${bulletMode ? "ON" : "OFF"}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "broadcast", payload: { type: "set_bullet_mode", value: bulletMode } }));
    }
    if (bulletMode) resendCurrentPosition();
  }
});

// ── Listen for messages from popup ───────────────────────────
if (typeof chrome !== "undefined" && chrome.runtime) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "toggle") {
      enabled = msg.enabled;
      console.log(`[chessbot] ${enabled ? "enabled" : "disabled"}`);
      if (!enabled) clearArrow();
      if (enabled) readAndSend();
    }
    if (msg.type === "set_voice") {
      voiceEnabled = !!msg.enabled;
      console.log(`[chessbot] voice ${voiceEnabled ? "enabled" : "disabled"}`);
    }
    if (msg.type === "set_run_engine_for") {
      const val = msg.value;
      if (["me", "opponent", "both"].includes(val)) {
        runEngineFor = val;
        console.log(`[chessbot] run engine for: ${runEngineFor}`);
        // Re-check if we should analyze the current position
        waitingForOpponent = false;
        lastSentFen = "";
        pendingEval = false;
        readAndSend();
      }
    }
    if (msg.type === "set_display_mode") {
      const val = msg.value;
      if (["arrow", "box", "both"].includes(val)) {
        displayMode = val;
        console.log(`[chessbot] display mode: ${displayMode}`);
        // Re-draw with current data by re-sending position
        resendCurrentPosition();
      }
    }
    if (msg.type === "set_show_opponent_response") {
      showOpponentResponse = !!msg.value;
      console.log(`[chessbot] show opponent response: ${showOpponentResponse}`);
      resendCurrentPosition();
    }
    if (msg.type === "set_voice") {
      voiceEnabled = !!msg.value;
      console.log(`[chessbot] voice: ${voiceEnabled}`);
    }
    if (msg.type === "set_voice_eval") {
      voiceEvalEnabled = !!msg.value;
      console.log(`[chessbot] voice eval: ${voiceEvalEnabled}`);
    }
    if (msg.type === "set_voice_opening") {
      voiceOpeningEnabled = !!msg.value;
      console.log(`[chessbot] voice opening: ${voiceOpeningEnabled}`);
    }
    if (msg.type === "set_voice_speed") {
      voiceSpeed = Number(msg.value) || 1.1;
      console.log(`[chessbot] voice speed: ${voiceSpeed}`);
    }
    if (msg.type === "set_training_mode") {
      trainingMode = !!msg.value;
      trainingStage = 0;
      trainingBestMove = null;
      console.log(`[chessbot] training mode: ${trainingMode}`);
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ chessbot_trainingMode: trainingMode });
      }
      resendCurrentPosition();
    }
    if (msg.type === "set_option") {
      // Relay engine setting to backend
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "set_option", name: msg.name, value: msg.value }));
        console.log(`[chessbot] set_option: ${msg.name} = ${msg.value}`);
        // Re-evaluate with new setting applied
        resendCurrentPosition();
      }
    }
    if (msg.type === "set_depth") {
      currentDepth = Number(msg.value) || 15;
      console.log(`[chessbot] depth set to ${currentDepth}`);
      // Re-evaluate at new depth
      resendCurrentPosition();
    }
    // Relay backend queries from popup (switch_engine/book/syzygy trigger re-eval on response)
    if (["list_files", "get_settings", "switch_engine", "switch_book", "switch_syzygy"].includes(msg.type)) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        const isSwitch = msg.type.startsWith("switch_");
        // Listen for the response and relay back to popup
        const handler = (evt) => {
          try {
            const resp = JSON.parse(evt.data);
            const responseTypes = ["files", "settings", "engine_switched", "book_switched", "syzygy_switched", "error"];
            if (responseTypes.includes(resp.type)) {
              ws.removeEventListener("message", handler);
              sendResponse(resp);
              // Re-evaluate after a successful resource switch
              if (isSwitch && resp.type !== "error") {
                resendCurrentPosition();
              }
            }
          } catch {}
        };
        ws.addEventListener("message", handler);
        // Timeout cleanup
        setTimeout(() => ws.removeEventListener("message", handler), 5000);
        return true; // keep channel open for async response
      } else {
        sendResponse({ type: "error", message: "Not connected to backend" });
        return true;
      }
    }
    if (msg.type === "get_status") {
      sendResponse({
        connected: ws && ws.readyState === WebSocket.OPEN,
        enabled,
        site: SITE,
        lastFen: lastSentFen,
      });
      return true; // keep channel open for async response
    }
    if (msg.type === "get_logs") {
      // Build diagnostic header for debugging
      const board = getBoardElement();
      const iframeCount = document.querySelectorAll("iframe").length;
      const header = [
        "=== CONTENT SCRIPT DIAGNOSTIC INFO ===",
        `Timestamp: ${new Date().toISOString()}`,
        `URL: ${location.href}`,
        `Site: ${SITE || "unknown"}`,
        `Variant: ${detectedVariant || "none (standard)"}`,
        `WS state: ${ws ? ["CONNECTING","OPEN","CLOSING","CLOSED"][ws.readyState] : "null"}`,
        `Board found: ${boardReady}`,
        `Board element: ${board ? board.tagName + (board.shadowRoot ? " (has shadowRoot)" : "") : "null"}`,
        `Iframes on page: ${iframeCount}`,
        `Enabled: ${enabled}`,
        `Last board FEN: ${lastBoardFen || "none"}`,
        `Last sent FEN: ${lastSentFen || "none"}`,
        `Pending eval: ${pendingEval}`,
        `Run engine for: ${runEngineFor}`,
        `Display mode: ${displayMode}`,
        `Depth: ${currentDepth}`,
        `Search limits: movetime=${searchMovetime} nodes=${searchNodes}`,
        `Piece count: ${lastPieceCount}`,
        `Render gen: ${renderGeneration}`,
        `Dragging: ${isDragging}`,
        `Waiting for opponent: ${waitingForOpponent}`,
        `Voice: ${voiceEnabled}`,
        `Auto-move: ${autoMoveEnabled} (delay: ${autoMoveDelayMin}–${autoMoveDelayMax}ms, humanize: ${autoMoveHumanize}, bullet: ${bulletMode})`,
        "=== CONTENT SCRIPT LOGS ===",
      ].join("\n");
      sendResponse({ logs: header + "\n" + logBuffer.join("\n") });
      return true;
    }
    if (msg.type === "get_all_logs") {
      // Fetch server logs via WebSocket, then combine with content script logs
      const board = getBoardElement();
      const iframeCount = document.querySelectorAll("iframe").length;
      const csHeader = [
        "=== CONTENT SCRIPT DIAGNOSTIC INFO ===",
        `Timestamp: ${new Date().toISOString()}`,
        `URL: ${location.href}`,
        `Site: ${SITE || "unknown"}`,
        `Variant: ${detectedVariant || "none (standard)"}`,
        `WS state: ${ws ? ["CONNECTING","OPEN","CLOSING","CLOSED"][ws.readyState] : "null"}`,
        `Board found: ${boardReady}`,
        `Board element: ${board ? board.tagName + (board.shadowRoot ? " (has shadowRoot)" : "") : "null"}`,
        `Iframes on page: ${iframeCount}`,
        `Enabled: ${enabled}`,
        `Last board FEN: ${lastBoardFen || "none"}`,
        `Last sent FEN: ${lastSentFen || "none"}`,
        `Pending eval: ${pendingEval}`,
        `Run engine for: ${runEngineFor}`,
        `Display mode: ${displayMode}`,
        `Depth: ${currentDepth}`,
        `Search limits: movetime=${searchMovetime} nodes=${searchNodes}`,
        `Piece count: ${lastPieceCount}`,
        `Render gen: ${renderGeneration}`,
        `Dragging: ${isDragging}`,
        `Waiting for opponent: ${waitingForOpponent}`,
        `Voice: ${voiceEnabled}`,
        `Auto-move: ${autoMoveEnabled} (delay: ${autoMoveDelayMin}–${autoMoveDelayMax}ms, humanize: ${autoMoveHumanize}, bullet: ${bulletMode})`,
        "=== CONTENT SCRIPT LOGS ===",
      ].join("\n");
      const csLogs = csHeader + "\n" + logBuffer.join("\n");

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        sendResponse({ logs: csLogs + "\n\n=== SERVER LOGS ===\n(WebSocket not connected — server logs unavailable)" });
        return true;
      }

      // Temporarily listen for server_logs response
      const timeout = setTimeout(() => {
        sendResponse({ logs: csLogs + "\n\n=== SERVER LOGS ===\n(Timed out waiting for server logs)" });
      }, 3000);

      const origHandler = ws.onmessage;
      const oneShot = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          if (data.type === "server_logs") {
            clearTimeout(timeout);
            ws.onmessage = origHandler;
            sendResponse({ logs: csLogs + "\n\n" + (data.logs || "(empty)") });
            // Re-process this message in case original handler needs it
            return;
          }
        } catch {}
        // Not our message — pass through to original handler
        if (origHandler) origHandler.call(ws, evt);
      };
      ws.onmessage = oneShot;
      ws.send(JSON.stringify({ type: "get_server_logs" }));
      return true; // keep sendResponse channel open
    }
    if (msg.type === "ping") {
      return true;
    }
  });
}
