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
let voiceEnabled = false; // TTS — toggled from popup
let lastSpokenMove = ""; // prevent repeating the same announcement
let runEngineFor = "me"; // "me" | "opponent" | "both" — which turns to analyze
let searchMovetime = null; // null = disabled, else ms
let searchNodes = null; // null = disabled, else node count

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

if (!SITE) {
  // Not a supported site — bail out
  console.log("[chessbot] unsupported site, content script inactive");
} else {
  console.log(`[chessbot] detected site: ${SITE}`);
  init();
}

// ── Initialisation ───────────────────────────────────────────
let boardReady = false;

function init() {
  connectWS();
  findBoard();
}

function findBoard() {
  boardReady = false;
  initialReadDone = false;
  pendingInitialFen = null;
  waitingForOpponent = false;
  _initialStableAttempts = 0;
  waitForBoard().then((boardEl) => {
    console.log("[chessbot] board found, starting observer");
    boardReady = true;
    observeBoard(boardEl);
    // Read the board immediately — initialRead handles null/retry internally
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
    console.log("[chessbot] connected to backend");
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
      if (msg.type === "bestmove" && msg.bestmove) {
        // Ignore stale responses for positions we didn't request
        if (msg.fen && lastSentFen) {
          const responseBoardPart = msg.fen.split(" ")[0];
          const sentBoardPart = lastSentFen.split(" ")[0];
          if (responseBoardPart !== sentBoardPart) {
            console.log("[chessbot] ignoring stale bestmove (board changed)");
            pendingEval = false;
            return;
          }
        }
        console.log(`[chessbot] bestmove: ${msg.bestmove} (${msg.source})`);
        pendingEval = false;
        // Voice announce
        if (voiceEnabled) speakMove(msg);
        const source = msg.source || "engine";
        const lines = msg.lines || [];
        const bestLine = lines[0] || null;
        if (lines.length > 1) {
          drawMultiPV(lines, source);
        } else {
          drawSingleMove(msg.bestmove, bestLine, source);
        }
        drawEvalBar(bestLine, source);
      }
    } catch { /* ignore malformed */ }
  };

  ws.onclose = () => {
    console.log("[chessbot] disconnected — retrying in 3s");
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {}; // onclose will fire next
}

function sendFen(fen) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const msg = { type: "fen", fen, depth: currentDepth };
  if (searchMovetime) msg.movetime = searchMovetime;
  if (searchNodes) msg.nodes = searchNodes;
  ws.send(JSON.stringify(msg));
  return true;
}

// ── Board DOM → FEN ──────────────────────────────────────────

/** Wait for the board element to appear (polling). */
function waitForBoard() {
  return new Promise((resolve) => {
    const check = () => {
      const el = getBoardElement();
      if (el) return resolve(el);
      setTimeout(check, 500);
    };
    check();
  });
}

function getBoardElement() {
  if (SITE === "chesscom") {
    // Prefer the web component (which has shadowRoot) over the outer .board div
    return document.querySelector("wc-chess-board") ||
           document.querySelector("chess-board") ||
           document.querySelector(".board");
  }
  if (SITE === "lichess") {
    return document.querySelector("cg-board");
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
      if (t.closest && t.closest("#chessbot-arrow-svg, #chessbot-eval-bar, .chessbot-eval-badge")) return true;
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
    const board = document.querySelector("wc-chess-board") ||
                  document.querySelector("chess-board") ||
                  document.querySelector(".board");
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
  if (pendingEval && evalSentAt && (Date.now() - evalSentAt > EVAL_TIMEOUT_MS)) {
    console.warn(`[chessbot] eval timeout (${EVAL_TIMEOUT_MS}ms) — resetting state`);
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

  // Animation guard: if piece count dropped by more than 2, a piece is likely
  // mid-flight (temporarily off both squares). Threshold of 2 allows en passant
  // (which legitimately removes 2 pieces from view: captured pawn + moving pawn
  // in transit). A drop of 3+ is almost certainly animation.
  const pieceCount = countPieces(boardPart);
  if (lastPieceCount > 0 && pieceCount < lastPieceCount - 2) {
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

  // Detect new game: piece count jumped back to 32 (or close) from fewer,
  // OR the board reset to the starting position. Reset cached player color
  // so we re-detect which side we're playing.
  const isStartPos = boardPart === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
  if ((prevBoard && pieceCount === 32 && countPieces(prevBoard) < 30) || isStartPos) {
    console.log("[chessbot] new game detected — resetting state");
    waitingForOpponent = false;
    lastSentFen = "";
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
    } else {
      console.log("[chessbot] turn unknown — skipping this cycle");
      return;
    }
  }

  // Effective turn: use detected turn, or "w" for starting position
  const effectiveTurn = turn || "w";

  // Only show move suggestions based on runEngineFor setting
  const isMyTurn = effectiveTurn === playerColor;
  const shouldAnalyze =
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

function chesscomBoardToFen() {
  const board = document.querySelector("wc-chess-board") ||
                document.querySelector("chess-board") ||
                document.querySelector(".board");
  if (!board) return null;

  // Chess.com renders pieces in various ways depending on version.
  // Try every known method to find them.
  let pieces = findChesscomPieces(board);
  if (!pieces || !pieces.length) return null;

  const boardRect = board.getBoundingClientRect();
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

    // Get piece type from class like "bb", "wp", "bk", etc.
    const pieceMatch = classes.match(/\b([wb][prnbqk])\b/);
    if (!pieceMatch) continue;

    const color = pieceMatch[1][0]; // 'w' or 'b'
    const type = pieceMatch[1][1]; // p, r, n, b, q, k
    const fenChar = color === "w" ? type.toUpperCase() : type.toLowerCase();

    // Primary: use visual position via getBoundingClientRect (always up-to-date)
    const pieceRect = piece.getBoundingClientRect();
    if (pieceRect.width > 0 && squareW > 0) {
      const cx = pieceRect.left + pieceRect.width / 2 - boardRect.left;
      const cy = pieceRect.top + pieceRect.height / 2 - boardRect.top;
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

  if (found < 2) return null;
  return gridToFenBoard(grid);
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
    const boardRect = board.getBoundingClientRect();
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
        const pieces = findChesscomPieces(hl.closest("wc-chess-board, chess-board, .board") || document);
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
  // We can only infer piece placement from the DOM — default to white to move
  return rows.join("/") + " w KQkq - 0 1";
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
  const rect = board.getBoundingClientRect();
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

// ── Single best move: green squares (our move) + red squares (opponent response) ──

function drawSingleMove(uci, bestLine, source) {
  clearArrow();
  if (!uci || uci.length < 4) return;
  const geo = getBoardGeometry();
  if (!geo) { console.log("[chessbot] drawSingleMove: no board geometry"); return; }
  const { board, rect, sqSize, flipped } = geo;
  console.log(`[chessbot] drawing move ${uci} on board ${rect.width}x${rect.height} sq=${sqSize} flipped=${flipped}`);
  const { from, to } = uciToSquares(uci);
  const isBook = source === "book";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "chessbot-arrow-svg";
  svg.setAttribute("width", rect.width);
  svg.setAttribute("height", rect.height);
  svg.style.cssText = `position:absolute;top:0;left:0;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:1000;`;

  // Green arrow for our best move (gold for book)
  const moveColor = isBook ? "rgba(212,160,23,0.9)" : "hsla(145,100%,50%,0.85)";
  drawArrowOnBoard(svg, from.file, from.rank, to.file, to.rank, sqSize, flipped, moveColor);

  // Red arrow for opponent's predicted response
  if (bestLine && bestLine.pv && bestLine.pv.length >= 2) {
    const response = bestLine.pv[1];
    if (response && response.length >= 4) {
      const resp = uciToSquares(response);
      drawArrowOnBoard(svg, resp.from.file, resp.from.rank, resp.to.file, resp.to.rank, sqSize, flipped, "hsla(350,100%,50%,0.7)", 0.7);
    }
  }

  // Badge on destination square — "OB" for book, eval score for engine
  const dst = squareTopLeft(to.file, to.rank, sqSize, flipped);
  const badgeH = sqSize * 0.28;
  const fontSize = Math.max(9, sqSize * 0.17);
  if (isBook) {
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", dst.x);
    bg.setAttribute("y", dst.y + sqSize - badgeH);
    bg.setAttribute("width", sqSize);
    bg.setAttribute("height", badgeH);
    bg.setAttribute("fill", "rgba(160,120,0,0.85)");
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
    text.textContent = "OB";
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

  // Draw arrows for each PV line (best = most opaque, others fade)
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.move || line.move.length < 4) continue;
    const { from, to } = uciToSquares(line.move);
    const color = EVAL_COLORS[i] || EVAL_COLORS[EVAL_COLORS.length - 1];
    const opacity = i === 0 ? 0.9 : 0.6;
    drawArrowOnBoard(svg, from.file, from.rank, to.file, to.rank, sqSize, flipped, color, opacity);
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
    // Inject straight into cg-board — pieces are positioned relative to it
    const pos = getComputedStyle(board).position;
    if (pos === "static") board.style.position = "relative";
    return { target: board, dx: 0, dy: 0 };
  }
  // Chess.com: wc-chess-board is a web component — inject into its shadow root
  // so the overlay renders on top of the board pieces.
  if (board.shadowRoot) {
    return { target: board.shadowRoot, dx: 0, dy: 0 };
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

function drawEvalBar(bestLine, source) {
  // Remove existing
  const old = document.getElementById("chessbot-eval-bar");
  if (old) old.remove();

  const isBook = source === "book";
  if (!bestLine && !isBook) return;

  const board = getBoardElement();
  if (!board) return;

  const { target: parent, dx, dy } = getOverlayTarget(board);
  if (!parent) return;

  const rect = board.getBoundingClientRect();
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
    // Show gold "OB" bar for opening book moves
    const bookBar = document.createElement("div");
    bookBar.style.cssText = `background:linear-gradient(180deg,#d4a017,#b8860b);flex:1;display:flex;align-items:center;justify-content:center;`;
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
    label.textContent = "OB";
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

  // Prefer SAN from first line for natural speech
  const lines = msg.lines || [];
  let text = move;
  if (lines.length && lines[0].san && lines[0].san.length) {
    text = lines[0].san[0];
  }
  text = text.replace(/\+/g, " check").replace(/#/g, " checkmate")
    .replace(/^O-O-O$/i, "queen side castle").replace(/^O-O$/i, "king side castle");

  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 1.1;
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
      sendResponse({ logs: logBuffer.join("\n") });
      return true;
    }
    if (msg.type === "ping") {
      return true;
    }
  });
}
