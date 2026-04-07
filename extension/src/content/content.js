/* ─────────────────────────────────────────────────────────────
   Chess Analysis Helper — Content Script
   Reads the board from chess.com / lichess.org, sends FEN to
   the local Stockfish backend, and draws best-move arrows.
   ───────────────────────────────────────────────────────────── */

const WS_URL = "ws://localhost:8080";

// ── State ────────────────────────────────────────────────────
let ws = null;
let lastBoardFen = ""; // piece-placement part only (before first space)
let lastSentFen = "";  // full FEN last sent for analysis
let enabled = true;
let observer = null;
let debounceTimer = null;
let pendingEval = false; // true while waiting for a bestmove response
let evalSentAt = 0;     // timestamp when last eval was sent — for client-side timeout
const EVAL_TIMEOUT_MS = 25000; // 25s client-side timeout for eval responses
let lastPieceCount = 0;  // to detect animation mid-flight (piece count changes)
let initialReadDone = false; // guard against duplicate initialRead calls
let pendingInitialFen = null; // FEN read before WS was ready, to send on connect
let currentDepth = 15; // analysis depth, updated from popup settings
let isDragging = false; // true while user is dragging a piece
let waitingForOpponent = false; // true after our move, until board changes again
let renderGeneration = 0;
let dragHandlersAttached = false; // prevent duplicate drag listeners on reconnect // increments on each board change — prevents stale overlays
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

function detectSite() {
  const host = location.hostname;
  if (host.includes("chess.com")) return "chesscom";
  if (host.includes("lichess")) return "lichess";
  return null;
}

/** Detect chess variant from URL path. Returns key like "atomic", "chess960", etc. or null. */
function detectVariant() {
  const path = location.pathname.toLowerCase();
  if (SITE === "lichess") {
    // Lichess: /atomic/..., /crazyhouse/..., /chess960/..., /kingOfTheHill/..., /threeCheck/..., /antichess/..., /horde/..., /racingKings/...
    if (path.includes("/atomic")) return "atomic";
    if (path.includes("/crazyhouse")) return "crazyhouse";
    if (path.includes("/chess960")) return "chess960";
    if (path.includes("/kingofthehill")) return "kingofthehill";
    if (path.includes("/threecheck") || path.includes("/three-check")) return "3check";
    if (path.includes("/antichess")) return "antichess";
    if (path.includes("/horde")) return "horde";
    if (path.includes("/racingkings") || path.includes("/racing-kings")) return "racingkings";
  }
  if (SITE === "chesscom") {
    // Chess.com: /variants/chess960, /variants/atomic, etc. Also /play/chess960, /live/chess960
    if (path.includes("chess960") || path.includes("960")) return "chess960";
    if (path.includes("atomic")) return "atomic";
    if (path.includes("crazyhouse")) return "crazyhouse";
    if (path.includes("kingofthehill") || path.includes("king-of-the-hill")) return "kingofthehill";
    if (path.includes("3check") || path.includes("threecheck") || path.includes("three-check")) return "3check";
    if (path.includes("antichess")) return "antichess";
    if (path.includes("horde")) return "horde";
    if (path.includes("racingkings") || path.includes("racing-kings")) return "racingkings";
  }
  return null;
}

/** Detect if the current page is a puzzle/training page. */
function isPuzzlePage() {
  const path = location.pathname.toLowerCase();
  if (SITE === "chesscom") {
    return path.includes("/puzzles") || path.includes("/puzzle") || path.includes("/lessons");
  }
  if (SITE === "lichess") {
    return path.startsWith("/training") || path.startsWith("/streak") || path.startsWith("/storm");
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
  }

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
  if (detectedVariant) console.log(`[chessbot] detected variant: ${detectedVariant}`);
  connectWS();
  findBoard();
}

function findBoard() {
  boardReady = false;
  initialReadDone = false;
  pendingInitialFen = null;
  waitingForOpponent = false;
  _initialStableAttempts = 0;
  _variantColorMap = null;
  _variantColorMapKey = null;
  lastKnownTurn = null;
  chesscomBoardToFen._diagLogged = false;
  waitForBoard().then((boardEl) => {
    const rect = (SITE === "chesscom") ? getVisualBoardRect(boardEl) : boardEl.getBoundingClientRect();
    console.log(`[chessbot] board found: <${boardEl.tagName}> class="${(boardEl.className || '').toString().substring(0, 60)}" visual=${Math.round(rect.width)}x${Math.round(rect.height)} pieces=${boardEl.querySelectorAll(".piece").length}`);
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

  // Determine whose turn it is using all available methods
  const turn = inferTurn("", boardPart);
  const playerColor = getPlayerColor();

  console.log(`[chessbot] initial load — turn=${turn} player=${playerColor} pieces=${pieceCount}`);

  if (!turn) {
    // Can't determine turn — for initial load, assume it's the player's turn
    console.log("[chessbot] turn unknown on initial load — assuming player's turn");
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

  const parts = fen.split(" ");
  parts[1] = turn || playerColor; // use detected turn, or player color as fallback
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
        }
        pendingInitialFen = null;
      }
    } else if (lastSentFen && enabled) {
      // Reconnected — resend last position for continuity
      console.log(`[chessbot] reconnected — resending last position`);
      pendingEval = true;
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
        console.error(`[chessbot] server error: ${msg.message}`);
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
      if (msg.type === "set_training_mode") {
        trainingMode = !!msg.value;
        trainingStage = 0;
        trainingBestMove = null;
        console.log(`[chessbot] training mode: ${trainingMode}`);
        resendCurrentPosition();
        return;
      }
      if (msg.type === "set_display_mode") {        if (["arrow", "box", "both"].includes(msg.value)) {
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
          console.warn("[chessbot] received null bestmove (engine timeout?)");
          return;
        }
        // Ignore stale responses for positions we didn't request
        if (msg.fen && lastSentFen) {
          const responseBoardPart = msg.fen.split(" ")[0];
          const sentBoardPart = lastSentFen.split(" ")[0];
          if (responseBoardPart !== sentBoardPart) {
            console.log("[chessbot] ignoring stale bestmove (board changed)");
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
        if (trainingMode && !msg.streaming) {
          // Training mode: store best move, show progressive hint
          trainingBestMove = msg.bestmove;
          trainingStage = 0;
          trainingLastFen = msg.fen || lastSentFen;
          drawTrainingHint(msg.bestmove, bestLine, source);
          drawEvalBar(bestLine, source, msg.tablebase);
        } else if (lines.length > 1) {
          drawMultiPV(lines, source);
          drawEvalBar(bestLine, source, msg.tablebase);
        } else {
          drawSingleMove(msg.bestmove, bestLine, source);
          drawEvalBar(bestLine, source, msg.tablebase);
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
    setTimeout(connectWS, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 1.5, 30000); // exponential backoff, max 30s
  };

  ws.onerror = (e) => {
    console.error(`[chessbot] WebSocket error (readyState=${ws.readyState})`);
  }; // onclose will fire next
}

function sendFen(fen) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn(`[chessbot] sendFen skipped — WS not open (state=${ws ? ws.readyState : "null"})`);
    return false;
  }
  const msg = { type: "fen", fen, depth: currentDepth };
  if (searchMovetime) msg.movetime = searchMovetime;
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
  if (SITE === "lichess") {
    return document.querySelector("cg-board");
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

function observeBoard(boardEl) {
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
      return false;
    });
    if (dominated) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(readAndSend, 400);
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
  // Only attach once to avoid duplicate listeners on SPA reconnect
  if (!dragHandlersAttached) {
    dragHandlersAttached = true;
    const dragTarget = boardEl.shadowRoot || boardEl;
    dragTarget.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      isDragging = true;
    }, true);
    document.addEventListener("mouseup", (e) => {
      if (!isDragging) return;
      isDragging = false;
      setTimeout(() => { if (enabled && boardReady) readAndSend(); }, 150);
    }, true);
    dragTarget.addEventListener("touchstart", () => { isDragging = true; }, true);
    document.addEventListener("touchend", () => {
      if (!isDragging) return;
      isDragging = false;
      setTimeout(() => { if (enabled && boardReady) readAndSend(); }, 150);
    }, true);
  }

  // Polling fallback — check every 800ms regardless of observer
  pollTimer = setInterval(() => {
    if (!enabled || !boardReady) return;
    try {
      // Verify the board element is still in the DOM (SPA navigation)
      const currentBoard = getBoardElement();
      if (!currentBoard) {
        console.log("[chessbot] board disappeared (navigation?), searching again");
        boardReady = false;
        if (observer) observer.disconnect();
        clearInterval(pollTimer);
        clearArrow();
        lastBoardFen = "";
        lastSentFen = "";
        lastPieceCount = 0;
        findBoard();
        return;
      }
      readAndSend();
    } catch (err) {
      console.error("[chessbot] poll error:", err);
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
  if (SITE === "lichess") {
    const board = document.querySelector("cg-board");
    if (!board) return false;
    // Lichess marks premoved squares and ghost pieces
    if (board.querySelector("piece.ghost, square.premove, .premove")) return true;
    return false;
  }
  return false;
}

function countPieces(boardFen) {
  let n = 0;
  for (const ch of boardFen) {
    if (ch !== "/" && (ch < "1" || ch > "8")) n++;
  }
  return n;
}

function readAndSend() {
  if (!boardReady) return;
  if (isDragging) return; // user is holding a piece — wait for drop

  // Client-side eval timeout: if we've been waiting too long for a response,
  // reset state so we can re-analyze on the next board change
  if (pendingEval && evalSentAt && currentDepth !== 0 && (Date.now() - evalSentAt > EVAL_TIMEOUT_MS)) {
    console.log(`[chessbot] eval timeout (${EVAL_TIMEOUT_MS}ms) — resetting state`);
    pendingEval = false;
    lastSentFen = "";
  }

  const fen = boardToFen();
  if (!fen) return; // no board or pieces yet — silent skip

  const boardPart = fen.split(" ")[0];

  // Board hasn't changed — skip
  if (boardPart === lastBoardFen) {
    // If we're waiting for the opponent, don't re-analyze the same position
    if (waitingForOpponent || lastSentFen) return;
  } else {
    // Board actually changed — clear the opponent-wait flag
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

  // Detect new game: piece count jumped back to 32 (or close) from fewer,
  // OR the board reset to the starting position. Reset cached player color
  // so we re-detect which side we're playing.
  const isStartPos = boardPart === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
  if ((prevBoard && pieceCount === 32 && countPieces(prevBoard) < 30) || isStartPos) {
    console.log("[chessbot] new game detected — resetting state");
    waitingForOpponent = false;
    lastSentFen = "";
    lastKnownTurn = null;
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
      console.log("[chessbot] turn unknown — skipping this cycle");
      return;
    }
  }

  // Effective turn: use detected turn, alternation fallback, or "w" for starting position
  const effectiveTurn = turn || lastKnownTurn || "w";
  if (turn) lastKnownTurn = turn;

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
  // Fallback: sort numerically, lower = white
  keys.sort((a, b) => parseInt(a) - parseInt(b));
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

  for (const piece of pieces) {
    const classes = typeof piece.className === "string" ? piece.className : (piece.getAttribute("class") || "");

    // Skip ghost/premove pieces — chess.com adds these for premove visualization
    if (/\bghost\b/.test(classes)) continue;
    // Also skip pieces with very low opacity (premove ghosts are semi-transparent)
    const opacity = parseFloat(getComputedStyle(piece).opacity);
    if (opacity < 0.5) continue;

    // Get piece type — Method A: class like "bb", "wp", "bk", etc.
    let fenChar;
    const pieceMatch = classes.match(/\b([wb][prnbqk])\b/);
    if (pieceMatch) {
      const color = pieceMatch[1][0]; // 'w' or 'b'
      const type = pieceMatch[1][1]; // p, r, n, b, q, k
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
      fenChar = isWhite ? type.toUpperCase() : type.toLowerCase();
    }

    // Primary: use visual position via getBoundingClientRect (always up-to-date)
    const pieceRect = piece.getBoundingClientRect();
    if (pieceRect.width > 0 && squareW > 0) {
      const cx = pieceRect.left + pieceRect.width / 2 - boardRect.left;
      const cy = pieceRect.top + pieceRect.height / 2 - boardRect.top;
      // Skip pieces outside the board area (bank/captured/off-board pieces)
      if (cx < -5 || cx > boardRect.width + 5 || cy < -5 || cy > boardRect.height + 5) continue;
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
  const fen = gridToFenBoard(grid);
  // Validate king counts (only in the board portion, before castling rights)
  const boardPart = fen.split(" ")[0];
  const whiteKings = (boardPart.match(/K/g) || []).length;
  const blackKings = (boardPart.match(/k/g) || []).length;
  // In atomic chess kings can be destroyed, so allow 0; otherwise require exactly 1
  const isAtomic = detectedVariant === "atomic";
  const validW = isAtomic ? whiteKings <= 1 : whiteKings === 1;
  const validB = isAtomic ? blackKings <= 1 : blackKings === 1;
  if (!validW || !validB) {
    console.log(`[chessbot] invalid FEN: K=${whiteKings} k=${blackKings} — ${fen.substring(0, 60)}`);
    _variantColorMap = null; // force re-build of color map
    return null;
  }
  return fen;
}

function isChesscomFlipped(board) {
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

  // Method 5: Coordinate labels — both in regular DOM and shadow DOM
  const searchRoots = [document];
  if (root) searchRoots.push(root);
  for (const sr of searchRoots) {
    const coords = sr.querySelectorAll(
      ".coordinates-row, .coords-row, .coords-files, coords-files, [class*='coord']"
    );
    for (const c of coords) {
      const txt = c.textContent.trim();
      if (txt.startsWith("h")) return true;
      if (txt.startsWith("a")) return false;
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
        const dcAvg0 = dcGroups[dcKeys[0]].sumY / dcGroups[dcKeys[0]].count;
        const dcAvg1 = dcGroups[dcKeys[1]].sumY / dcGroups[dcKeys[1]].count;
        // Sort keys numerically; assume lower data-color value = white
        dcKeys.sort((a, b) => parseInt(a) - parseInt(b));
        const assumedWhiteAvg = dcGroups[dcKeys[0]].sumY / dcGroups[dcKeys[0]].count;
        const assumedBlackAvg = dcGroups[dcKeys[1]].sumY / dcGroups[dcKeys[1]].count;
        // If assumed-white has lower avgY → white at top → flipped
        return assumedWhiteAvg < assumedBlackAvg;
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
  // Method 0: variant pages — only pieces inside the actual pieces container
  // (excludes banks, playerboxes, and other non-board pieces)
  const piecesContainer = board.querySelector("[class*='TheBoard-pieces'], [class*='Pieces-layer']");
  if (piecesContainer) {
    let pieces = piecesContainer.querySelectorAll(".piece");
    if (pieces.length >= 2) return filterGhostPieces(pieces);
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

  return gridToFenBoard(grid);
}

function isLichessFlipped() {
  // Method 1: orientation class on cg-wrap
  const cgWrap = document.querySelector(".cg-wrap");
  if (cgWrap) {
    if (cgWrap.classList.contains("orientation-black")) return true;
    if (cgWrap.classList.contains("orientation-white")) return false;
  }
  // Method 2: check coordinate labels — if rank 1 is at top, board is flipped
  const ranks = document.querySelector("coords.ranks coord:first-child");
  if (ranks && ranks.textContent.trim() === "1") return true;
  return false;
}

// ── Turn detection (multiple methods, prioritized) ───────────

function inferTurn(prevBoardFen, currentBoardFen) {
  // Method 1: diff the two positions to see which color just moved
  if (prevBoardFen && prevBoardFen !== currentBoardFen) {
    const movedColor = detectWhoMoved(prevBoardFen, currentBoardFen);
    if (movedColor) {
      return movedColor === "w" ? "b" : "w";
    }
  }

  // Method 2: read the move list from the DOM (works mid-game, on refresh, etc.)
  const moveListTurn = detectTurnFromMoveList();
  if (moveListTurn) return moveListTurn;

  // Method 3: last-move highlight squares (chess.com highlights the move just played)
  const highlightTurn = detectTurnFromHighlights();
  if (highlightTurn) return highlightTurn;

  // Method 4: clock-based detection (whose clock is ticking)
  const clockTurn = detectTurnFromClocks();
  if (clockTurn) return clockTurn;

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
  }

  if (SITE === "lichess") {
    // Lichess: moves are in <move> or <m2> elements, or .moves kwdb elements
    const moves = document.querySelectorAll("move, m2, .moves kwdb");
    if (moves.length > 0) {
      const lastPly = moves.length;
      return lastPly % 2 === 0 ? "w" : "b";
    }
    // Alternative: l-moves container
    const plies = document.querySelectorAll("l4x move, .tview2 move");
    if (plies.length > 0) {
      return plies.length % 2 === 0 ? "w" : "b";
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

  if (SITE === "lichess") {
    // Lichess: last-move squares have class "last-move"
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
  let whiteAppeared = 0;
  let blackAppeared = 0;
  let whiteDisappeared = 0;
  let blackDisappeared = 0;

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = prev[r][f];
      const c = curr[r][f];
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
  const rows = boardFen.split("/");
  for (const row of rows) {
    const rank = [];
    for (const ch of row) {
      if (ch >= "1" && ch <= "8") {
        for (let i = 0; i < parseInt(ch, 10); i++) rank.push(null);
      } else {
        rank.push(ch);
      }
    }
    grid.push(rank);
  }
  return grid;
}

function detectTurnFromClocks() {
  if (SITE === "lichess") {
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
  }
  return null; // couldn't determine — let caller decide
}

function getPlayerColor() {
  // Always detect from current board state — no caching.
  // Chess.com flips the board AFTER rendering the start position,
  // so caching during transitions produces stale values.
  let color = "w";
  if (SITE === "lichess") {
    color = isLichessFlipped() ? "b" : "w";
  } else if (SITE === "chesscom") {
    const board = getBoardElement();
    color = board && isChesscomFlipped(board) ? "b" : "w";
  }
  return color;
}

// ── FEN helpers ──────────────────────────────────────────────

function gridToFenBoard(grid) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = "";
    let empty = 0;
    for (let f = 0; f < 8; f++) {
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
  // Derive castling rights from king/rook positions
  // grid[0] = rank 8 (top), grid[7] = rank 1 (bottom)
  let castling = "";
  if (grid[7][4] === "K") { // white king on e1
    if (grid[7][7] === "R") castling += "K";
    if (grid[7][0] === "R") castling += "Q";
  }
  if (grid[0][4] === "k") { // black king on e8
    if (grid[0][7] === "r") castling += "k";
    if (grid[0][0] === "r") castling += "q";
  }
  if (!castling) castling = "-";
  return rows.join("/") + " w " + castling + " - 0 1";
}

function boardToFen() {
  if (SITE === "chesscom") return chesscomBoardToFen();
  if (SITE === "lichess") return lichessBoardToFen();
  return null;
}

// ── Arrow overlay ────────────────────────────────────────────

function uciToSquares(uci) {
  // e.g. "e2e4" → { from: {file:4, rank:1}, to: {file:4, rank:3} }
  return {
    from: { file: uci.charCodeAt(0) - 97, rank: parseInt(uci[1], 10) - 1 },
    to:   { file: uci.charCodeAt(2) - 97, rank: parseInt(uci[3], 10) - 1 },
  };
}

/** Clear move arrows and eval badges, but keep the eval bar. */
function clearMoveIndicators() {
  // Check both document and shadow root for our overlay elements
  const roots = [document];
  const board = getBoardElement();
  if (board && board.shadowRoot) roots.push(board.shadowRoot);
  for (const root of roots) {
    const existing = root.getElementById("chessbot-arrow-svg");
    if (existing) existing.remove();
    const bg = root.getElementById("chessbot-bg-svg");
    if (bg) bg.remove();
    root.querySelectorAll(".chessbot-eval-badge").forEach((el) => el.remove());
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

function getBoardGeometry() {
  const board = getBoardElement();
  if (!board) return null;
  const rect = (SITE === "chesscom") ? getVisualBoardRect(board) : board.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const sqSize = rect.width / 8;
  const flipped =
    (SITE === "chesscom" && isChesscomFlipped(board)) ||
    (SITE === "lichess" && isLichessFlipped());
  return { board, rect, sqSize, flipped };
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
  if (!uci || uci.length < 4) return;
  const geo = getBoardGeometry();
  if (!geo) return;
  const { board, rect, sqSize, flipped } = geo;
  const { from, to } = uciToSquares(uci);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "chessbot-arrow-svg";
  svg.setAttribute("width", rect.width);
  svg.setAttribute("height", rect.height);
  svg.style.cssText = `position:absolute;top:0;left:0;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:1000;cursor:pointer;`;
  // Allow clicks to advance stage
  svg.style.pointerEvents = "all";

  const hintColor = "rgba(168,85,247,0.5)"; // purple
  const zoneColor = "rgba(168,85,247,0.2)";
  const fromPos = squareTopLeft(from.file, from.rank, sqSize, flipped);

  if (trainingStage >= 0) {
    // Stage 0: Source square highlight
    const sq = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    sq.setAttribute("x", fromPos.x);
    sq.setAttribute("y", fromPos.y);
    sq.setAttribute("width", sqSize);
    sq.setAttribute("height", sqSize);
    sq.setAttribute("fill", hintColor);
    sq.setAttribute("rx", "3");
    svg.appendChild(sq);

    // "?" label on source square
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", fromPos.x + sqSize / 2);
    label.setAttribute("y", fromPos.y + sqSize / 2 + 6);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", Math.max(14, sqSize * 0.35));
    label.setAttribute("font-weight", "900");
    label.setAttribute("fill", "rgba(255,255,255,0.9)");
    label.setAttribute("font-family", "monospace");
    label.textContent = "?";
    svg.appendChild(label);
  }

  if (trainingStage >= 1) {
    // Stage 1: Highlight destination file (column)
    const toPos = squareTopLeft(to.file, to.rank, sqSize, flipped);
    for (let r = 0; r < 8; r++) {
      const pos = squareTopLeft(to.file, r, sqSize, flipped);
      const zone = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      zone.setAttribute("x", pos.x);
      zone.setAttribute("y", pos.y);
      zone.setAttribute("width", sqSize);
      zone.setAttribute("height", sqSize);
      zone.setAttribute("fill", zoneColor);
      svg.appendChild(zone);
    }
  }

  if (trainingStage >= 2) {
    // Stage 2: Full reveal — draw the actual move
    clearArrow();
    drawSingleMove(uci, bestLine, source);
    return;
  }

  // Score badge
  const scoreBadge = document.createElementNS("http://www.w3.org/2000/svg", "text");
  scoreBadge.setAttribute("x", rect.width - 4);
  scoreBadge.setAttribute("y", 16);
  scoreBadge.setAttribute("text-anchor", "end");
  scoreBadge.setAttribute("font-size", "11");
  scoreBadge.setAttribute("font-weight", "700");
  scoreBadge.setAttribute("fill", "rgba(168,85,247,0.9)");
  scoreBadge.setAttribute("font-family", "'Inter', sans-serif");
  scoreBadge.textContent = `${trainingCorrect}/${trainingTotal}`;
  svg.appendChild(scoreBadge);

  // Click handler to advance stages
  svg.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    trainingStage++;
    drawTrainingHint(uci, bestLine, source);
  });

  const { target: parent, dx, dy } = getOverlayTarget(board);
  if (!parent) return;
  svg.style.left = `${dx}px`;
  svg.style.top = `${dy}px`;
  parent.appendChild(svg);
}

/** Check if the user's move matched the engine's suggestion */
function checkTrainingAccuracy(currentFen) {
  if (!trainingMode || !trainingBestMove || !trainingLastFen) return;
  // Only check if the position changed from the training hint position
  const currentBoard = currentFen.split(" ")[0];
  const trainingBoard = trainingLastFen.split(" ")[0];
  if (currentBoard === trainingBoard) return; // same position, no move made

  trainingTotal++;
  // We can't directly know what move the user played, but if they played
  // the best move, the resulting position will match what we'd get from the hint FEN
  // Instead, just show the score badge — accuracy tracking is approximate
  trainingBestMove = null;
  trainingLastFen = "";
  trainingStage = 0;
}

// ── Single best move: green squares (our move) + red squares (opponent response) ──

function drawSingleMove(uci, bestLine, source) {
  clearArrow();
  if (!uci || uci.length < 4) return;
  const geo = getBoardGeometry();
  if (!geo) { console.log("[chessbot] drawSingleMove: no board geometry"); return; }
  const { board, rect, sqSize, flipped } = geo;
  console.log(`[chessbot] drawing move ${uci} on board ${rect.width}x${rect.height} sq=${sqSize} flipped=${flipped}`);
  const { from, to } = uciToSquares(uci);
  const isBook = source === "book" || source === "lichess";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "chessbot-arrow-svg";
  svg.setAttribute("width", rect.width);
  svg.setAttribute("height", rect.height);
  svg.style.cssText = `position:absolute;top:0;left:0;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:1000;`;

  const moveColor = source === "lichess" ? "rgba(66,133,244,0.95)" : isBook ? "rgba(212,160,23,0.9)" : "rgba(16,185,129,0.9)";
  const boxColorFrom = source === "lichess" ? "rgba(66,133,244,0.4)" : isBook ? "rgba(212,160,23,0.4)" : "rgba(16,185,129,0.4)";
  const boxColorTo   = source === "lichess" ? "rgba(66,133,244,0.5)" : isBook ? "rgba(212,160,23,0.5)" : "rgba(16,185,129,0.5)";

  // Background SVG for fills (behind pieces)
  const bgSvg = (displayMode === "box" || displayMode === "both") ? getOrCreateBgSvg(board, rect) : null;

  // Box highlights (drawn first so they sit behind arrows)
  if (displayMode === "box" || displayMode === "both") {
    drawSquareHighlight(svg, from.file, from.rank, sqSize, flipped, boxColorFrom, "from", bgSvg);
    drawSquareHighlight(svg, to.file, to.rank, sqSize, flipped, boxColorTo, "to", bgSvg);
  }

  // Arrow
  if (displayMode === "arrow" || displayMode === "both") {
    drawArrowOnBoard(svg, from.file, from.rank, to.file, to.rank, sqSize, flipped, moveColor);
  }

  // Red opponent response
  if (showOpponentResponse && bestLine && bestLine.pv && bestLine.pv.length >= 2) {
    const response = bestLine.pv[1];
    if (response && response.length >= 4) {
      const resp = uciToSquares(response);
      if (displayMode === "box" || displayMode === "both") {
        drawSquareHighlight(svg, resp.from.file, resp.from.rank, sqSize, flipped, "rgba(231,76,60,0.4)", "from", bgSvg);
        drawSquareHighlight(svg, resp.to.file, resp.to.rank, sqSize, flipped, "rgba(231,76,60,0.5)", "to", bgSvg);
      }
      if (displayMode === "arrow" || displayMode === "both") {
        drawArrowOnBoard(svg, resp.from.file, resp.from.rank, resp.to.file, resp.to.rank, sqSize, flipped, "hsla(350,100%,50%,0.7)", 0.7);
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
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", dst.x);
    bg.setAttribute("y", dst.y + sqSize - badgeH);
    bg.setAttribute("width", sqSize);
    bg.setAttribute("height", badgeH);
    bg.setAttribute("fill", "rgba(0,0,0,0.6)");
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
    text.textContent = scoreText;
    svg.appendChild(text);
  }

  injectOverlay(board, svg);
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
    return `M${Math.abs(line.mate)}`;
  }
  if (line.score !== undefined && line.score !== null) {
    const val = line.score / 100;
    return (val >= 0 ? "+" : "") + val.toFixed(1);
  }
  return "?";
}

function drawMultiPV(lines) {
  clearArrow();
  const geo = getBoardGeometry();
  if (!geo) return;
  const { board, rect, sqSize, flipped } = geo;

  // Create an SVG layer for arrows
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "chessbot-arrow-svg";
  svg.setAttribute("width", rect.width);
  svg.setAttribute("height", rect.height);
  svg.style.cssText = `position:absolute;top:0;left:0;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:1000;`;

  // Background SVG for fills (behind pieces)
  const bgSvg = (displayMode === "box" || displayMode === "both") ? getOrCreateBgSvg(board, rect) : null;

  // Draw highlights + arrows for each PV line
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.move || line.move.length < 4) continue;
    const { from, to } = uciToSquares(line.move);
    const color = EVAL_COLORS[i] || EVAL_COLORS[EVAL_COLORS.length - 1];
    const opacity = i === 0 ? 0.9 : 0.6;
    // Box highlights first (behind arrows)
    if (displayMode === "box" || displayMode === "both") {
      const boxAlpha = i === 0 ? 0.5 : 0.35;
      const hexToRgba = (hex, a) => {
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        return `rgba(${r},${g},${b},${a})`;
      };
      const bc = color.startsWith("#") ? hexToRgba(color, boxAlpha) : color.replace(")", `,${boxAlpha})`).replace("rgb(", "rgba(");
      drawSquareHighlight(svg, from.file, from.rank, sqSize, flipped, bc, "from", bgSvg);
      drawSquareHighlight(svg, to.file, to.rank, sqSize, flipped, bc, "to", bgSvg);
    }
    if (displayMode === "arrow" || displayMode === "both") {
      drawArrowOnBoard(svg, from.file, from.rank, to.file, to.rank, sqSize, flipped, color, opacity);
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

    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", dst.x);
    bg.setAttribute("y", dst.y + slot * badgeH);
    bg.setAttribute("width", sqSize);
    bg.setAttribute("height", badgeH);
    bg.setAttribute("fill", color);
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

  injectOverlay(board, svg);
}

// ── Inject SVG overlay into board container ──────────────────

/** Return the overlay parent and the pixel offset of the board within it.
 *  On lichess we inject directly into cg-board to avoid offset issues
 *  (cg-board → cg-container → cg-wrap introduces fractional pixel drift). */
function getOverlayTarget(board) {
  if (SITE === "lichess") {
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
                  (SITE === "lichess" && isLichessFlipped());

  // Build the eval bar container
  const container = document.createElement("div");
  container.id = "chessbot-eval-bar";
  container.style.cssText = `
    position: absolute;
    left: ${dx - 28}px;
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

  // On lichess, we inject into cg-board directly. Both cg-board and its
  // ancestor cg-wrap may clip overflow. Override so the eval bar (left:-28px)
  // and WDL bar (bottom:-22px) are visible.
  if (SITE === "lichess") {
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

// ── Hotkeys ──────────────────────────────────────────────────
// Alt+A = resume analysis, Alt+S = stop analysis
// Alt+W = set side to white, Alt+Q = set side to black
document.addEventListener("keydown", (e) => {
  if (!e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "a") {
    e.preventDefault();
    if (!enabled) {
      enabled = true;
      console.log("[chessbot] resumed via hotkey (Alt+A)");
      readAndSend();
    }
  } else if (key === "s") {
    e.preventDefault();
    if (enabled) {
      enabled = false;
      console.log("[chessbot] stopped via hotkey (Alt+S)");
      clearArrow();
    }
  } else if (key === "w") {
    e.preventDefault();
    runEngineFor = "me";
    waitingForOpponent = false;
    lastSentFen = "";
    pendingEval = false;
    console.log("[chessbot] hotkey: analyze for Me (Alt+W)");
    readAndSend();
  } else if (key === "q") {
    e.preventDefault();
    runEngineFor = "opponent";
    waitingForOpponent = false;
    lastSentFen = "";
    pendingEval = false;
    console.log("[chessbot] hotkey: analyze for Opponent (Alt+Q)");
    readAndSend();
  } else if (key === "t") {
    e.preventDefault();
    trainingMode = !trainingMode;
    trainingStage = 0;
    trainingBestMove = null;
    console.log(`[chessbot] training mode: ${trainingMode} (Alt+T)`);
    resendCurrentPosition();
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
