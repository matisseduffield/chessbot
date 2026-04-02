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
let lastPieceCount = 0;  // to detect animation mid-flight (piece count changes)

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
  waitForBoard().then((boardEl) => {
    console.log("[chessbot] board found, starting observer");
    boardReady = true;
    observeBoard(boardEl);
    // On initial load, do a forced read (no previous board to diff)
    // Use a short delay for chess.com's pieces to fully render
    setTimeout(() => initialRead(), 500);
  });
}

/** First read after finding the board — forces analysis regardless of diff. */
function initialRead() {
  if (!boardReady || !enabled) return;
  const fen = boardToFen();
  if (!fen) {
    // Pieces not rendered yet, try again shortly
    setTimeout(() => initialRead(), 500);
    return;
  }

  const boardPart = fen.split(" ")[0];
  const pieceCount = countPieces(boardPart);
  lastBoardFen = boardPart;
  lastPieceCount = pieceCount;

  // Determine whose turn it is using all available methods
  const turn = inferTurn("", boardPart);

  console.log(`[chessbot] initial load — turn=${turn} pieces=${pieceCount}`);

  const parts = fen.split(" ");
  parts[1] = turn;
  const correctedFen = parts.join(" ");
  lastSentFen = correctedFen;
  pendingEval = true;
  console.log(`[chessbot] → initial FEN: ${correctedFen}`);
  sendFen(correctedFen);
}

// ── WebSocket ────────────────────────────────────────────────
function connectWS() {
  if (ws && ws.readyState <= 1) return; // CONNECTING or OPEN

  ws = new WebSocket(WS_URL);

  ws.onopen = () => console.log("[chessbot] connected to backend");

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === "bestmove" && msg.bestmove) {
        // Ignore stale responses for positions that no longer match the board
        if (msg.fen) {
          const responseBoardPart = msg.fen.split(" ")[0];
          if (responseBoardPart !== lastBoardFen) {
            console.log("[chessbot] ignoring stale bestmove (board changed)");
            return;
          }
        }
        console.log(`[chessbot] bestmove: ${msg.bestmove} (${msg.source})`);
        pendingEval = false;
        const lines = msg.lines || [];
        const bestLine = lines[0] || null;
        if (lines.length > 1) {
          drawMultiPV(lines);
        } else {
          drawSingleMove(msg.bestmove, bestLine);
        }
        drawEvalBar(bestLine);
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
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "fen", fen }));
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
    return document.querySelector("wc-chess-board, chess-board, .board");
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

function countPieces(boardFen) {
  let n = 0;
  for (const ch of boardFen) {
    if (ch !== "/" && (ch < "1" || ch > "8")) n++;
  }
  return n;
}

function readAndSend() {
  if (!boardReady) return;
  const fen = boardToFen();
  if (!fen) return; // no board or pieces yet — silent skip

  const boardPart = fen.split(" ")[0];

  // Board hasn't changed — nothing happened, skip
  if (boardPart === lastBoardFen) return;

  // Animation guard: if piece count suddenly dropped by more than 1, a piece
  // may be mid-flight (temporarily off both squares). Wait for next poll.
  const pieceCount = countPieces(boardPart);
  if (lastPieceCount > 0 && pieceCount < lastPieceCount - 1) {
    console.log(`[chessbot] piece count dropped ${lastPieceCount}→${pieceCount}, likely mid-animation — skipping`);
    return;
  }

  console.log(`[chessbot] board change detected (pieces=${pieceCount})`);
  const prevBoard = lastBoardFen;
  lastBoardFen = boardPart;
  lastPieceCount = pieceCount;

  // Determine whose turn it is by diffing board positions
  const turn = inferTurn(prevBoard, boardPart);

  console.log(`[chessbot] turn=${turn}`);

  // Build FEN with correct side-to-move
  const parts = fen.split(" ");
  parts[1] = turn;
  const correctedFen = parts.join(" ");

  if (correctedFen === lastSentFen) return;
  lastSentFen = correctedFen;
  pendingEval = true;
  console.log(`[chessbot] → FEN: ${correctedFen}`);
  clearArrow();
  sendFen(correctedFen);
}

// ── Chess.com board reader ───────────────────────────────────

function chesscomBoardToFen() {
  const board = document.querySelector("wc-chess-board, chess-board, .board");
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
  // Chess.com adds "flipped" class when playing as black
  if (board.classList.contains("flipped")) return true;
  // Also check via attribute (some versions use this)
  if (board.getAttribute("flipped") !== null) return true;
  // Check for coordinates: if file 'a' is on the right, board is flipped
  const coords = document.querySelector(".coordinates-row, .coords-row");
  if (coords && coords.textContent.trim().startsWith("h")) return true;
  return false;
}

/** Try every known way to find chess.com piece elements. */
function findChesscomPieces(board) {
  // Method 1: direct children/descendants with .piece class
  let pieces = board.querySelectorAll(".piece");
  if (pieces.length >= 2) return pieces;

  // Method 2: shadow root
  if (board.shadowRoot) {
    pieces = board.shadowRoot.querySelectorAll(".piece");
    if (pieces.length >= 2) return pieces;
  }

  // Method 3: global search (pieces may be siblings, not children)
  pieces = document.querySelectorAll(".piece");
  if (pieces.length >= 2) return pieces;

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

  // Last resort: assume it's our turn (better to show a suggestion than nothing)
  const fallback = getPlayerColor();
  console.log(`[chessbot] turn detection uncertain, assuming player's turn: ${fallback}`);
  return fallback;
}

/** Read the move list panel to determine whose turn it is.
 *  If the last move in the list was made by black, it's white's turn (and vice versa). */
function detectTurnFromMoveList() {
  if (SITE === "chesscom") {
    // Chess.com move list: each row has a white move and optionally a black move
    // The last move node tells us who moved last
    const moveNodes = document.querySelectorAll(
      ".main-line-ply, [data-ply], .move-text-component, move-list-ply"
    );
    if (moveNodes.length > 0) {
      const lastPly = moveNodes.length; // ply count: 1=white, 2=black, 3=white...
      return lastPly % 2 === 0 ? "w" : "b"; // even plies = black just moved → white's turn
    }

    // Alternative: look for vertical move list with numbered rows
    const rows = document.querySelectorAll(
      ".move-list .move, [class*='move-list'] [class*='move']"
    );
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const text = lastRow.textContent.trim();
      // If the row has two moves (white and black), black moved last → white's turn
      // If only one move shown, white moved last → black's turn
      const parts = text.replace(/^\d+\.?\s*/, "").trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] && !parts[1].match(/^[\d.]+$/)) {
        return "w"; // black completed the row
      }
      return "b"; // only white's move in the last row
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
  if (SITE === "lichess") return isLichessFlipped() ? "b" : "w";
  if (SITE === "chesscom") {
    const board = getBoardElement();
    return board && isChesscomFlipped(board) ? "b" : "w";
  }
  return "w";
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

function clearArrow() {
  const existing = document.getElementById("chessbot-arrow-svg");
  if (existing) existing.remove();
  // Also clear HTML eval badges
  document.querySelectorAll(".chessbot-eval-badge").forEach((el) => el.remove());
  // Clear eval bar
  const bar = document.getElementById("chessbot-eval-bar");
  if (bar) bar.remove();
}

// ── Board geometry helpers ───────────────────────────────────

function getBoardGeometry() {
  const board = getBoardElement();
  if (!board) return null;
  const rect = board.getBoundingClientRect();
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

// ── Single best move: source highlight + red destination outline ──

function drawSingleMove(uci, bestLine) {
  clearArrow();
  if (!uci || uci.length < 4) return;
  const geo = getBoardGeometry();
  if (!geo) return;
  const { board, rect, sqSize, flipped } = geo;
  const { from, to } = uciToSquares(uci);

  const src = squareTopLeft(from.file, from.rank, sqSize, flipped);
  const dst = squareTopLeft(to.file, to.rank, sqSize, flipped);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "chessbot-arrow-svg";
  svg.setAttribute("width", rect.width);
  svg.setAttribute("height", rect.height);
  svg.style.cssText = `position:absolute;top:0;left:0;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:1000;`;

  // Source square — subtle blue outline
  const pad = 2;
  const srcRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  srcRect.setAttribute("x", src.x + pad);
  srcRect.setAttribute("y", src.y + pad);
  srcRect.setAttribute("width", sqSize - pad * 2);
  srcRect.setAttribute("height", sqSize - pad * 2);
  srcRect.setAttribute("fill", "rgba(52,152,219,0.15)");
  srcRect.setAttribute("stroke", "#3498db");
  srcRect.setAttribute("stroke-width", "2.5");
  srcRect.setAttribute("rx", "2");
  srcRect.setAttribute("opacity", "0.9");
  svg.appendChild(srcRect);

  // Destination square — red outline
  const dstRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  dstRect.setAttribute("x", dst.x + pad);
  dstRect.setAttribute("y", dst.y + pad);
  dstRect.setAttribute("width", sqSize - pad * 2);
  dstRect.setAttribute("height", sqSize - pad * 2);
  dstRect.setAttribute("fill", "rgba(231,76,60,0.12)");
  dstRect.setAttribute("stroke", "#e74c3c");
  dstRect.setAttribute("stroke-width", "3");
  dstRect.setAttribute("rx", "2");
  dstRect.setAttribute("opacity", "0.9");
  svg.appendChild(dstRect);

  // Eval score badge on destination square
  if (bestLine) {
    const scoreText = formatScore(bestLine);
    const fontSize = Math.max(9, sqSize * 0.18);
    const badgeH = sqSize * 0.32;
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", dst.x + sqSize / 2);
    text.setAttribute("y", dst.y + sqSize - 4);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", fontSize);
    text.setAttribute("font-weight", "800");
    text.setAttribute("font-family", "monospace");
    text.setAttribute("fill", "#fff");
    text.textContent = scoreText;

    // Background for readability
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", dst.x);
    bg.setAttribute("y", dst.y + sqSize - badgeH);
    bg.setAttribute("width", sqSize);
    bg.setAttribute("height", badgeH);
    bg.setAttribute("fill", "rgba(0,0,0,0.6)");
    bg.setAttribute("rx", "2");
    svg.appendChild(bg);
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

  const parent = board.closest(".board-layout-component, .cg-wrap, .board") || board.parentElement;
  if (!parent) return;
  const pos = getComputedStyle(parent).position;
  if (pos === "static") parent.style.position = "relative";

  // Create an SVG layer for source square outlines
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "chessbot-arrow-svg";
  svg.setAttribute("width", rect.width);
  svg.setAttribute("height", rect.height);
  svg.style.cssText = `position:absolute;top:0;left:0;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:1000;`;

  const pad = 2;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.move || line.move.length < 4) continue;

    const { from, to } = uciToSquares(line.move);
    const src = squareTopLeft(from.file, from.rank, sqSize, flipped);
    const dst = squareTopLeft(to.file, to.rank, sqSize, flipped);
    const color = EVAL_COLORS[i] || EVAL_COLORS[EVAL_COLORS.length - 1];
    const scoreText = formatScore(line);

    // Source square outline — same color as the eval badge
    const srcRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    srcRect.setAttribute("x", src.x + pad);
    srcRect.setAttribute("y", src.y + pad);
    srcRect.setAttribute("width", sqSize - pad * 2);
    srcRect.setAttribute("height", sqSize - pad * 2);
    srcRect.setAttribute("fill", "none");
    srcRect.setAttribute("stroke", color);
    srcRect.setAttribute("stroke-width", "3");
    srcRect.setAttribute("rx", "2");
    srcRect.setAttribute("opacity", "0.9");
    svg.appendChild(srcRect);

    // Destination eval badge
    const badge = document.createElement("div");
    badge.className = "chessbot-eval-badge";
    const fontSize = Math.max(10, sqSize * 0.22);
    badge.style.cssText = `
      position: absolute;
      left: ${dst.x}px;
      top: ${dst.y}px;
      width: ${sqSize}px;
      height: ${sqSize * 0.36}px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${color};
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      font-size: ${fontSize}px;
      font-weight: 800;
      pointer-events: none;
      z-index: 1001;
      border-radius: 0 0 3px 3px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.4);
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    `;
    badge.textContent = scoreText;
    parent.appendChild(badge);
  }

  injectOverlay(board, svg);
}

// ── Inject SVG overlay into board container ──────────────────

function injectOverlay(board, svg) {
  const parent = board.closest(".board-layout-component, .cg-wrap, .board") || board.parentElement;
  if (parent) {
    const pos = getComputedStyle(parent).position;
    if (pos === "static") parent.style.position = "relative";
    parent.appendChild(svg);
  } else {
    board.appendChild(svg);
  }
}

// ── Eval bar + WDL display ───────────────────────────────────

function drawEvalBar(bestLine) {
  // Remove existing
  const old = document.getElementById("chessbot-eval-bar");
  if (old) old.remove();

  if (!bestLine) return;

  const board = getBoardElement();
  if (!board) return;

  const parent = board.closest(".board-layout-component, .cg-wrap, .board") || board.parentElement;
  if (!parent) return;

  const rect = board.getBoundingClientRect();
  const playerColor = getPlayerColor();

  // Calculate white's advantage percentage (0-100)
  let whitePct = 50;
  if (bestLine.mate !== undefined && bestLine.mate !== null) {
    // For the player's perspective: positive mate = good for side to move
    // We set the FEN with the player's color as side to move
    whitePct = bestLine.mate > 0 ? (playerColor === "w" ? 98 : 2) : (playerColor === "w" ? 2 : 98);
  } else if (bestLine.score !== undefined && bestLine.score !== null) {
    // Score is from the side-to-move perspective (which is the player's color)
    const cpFromWhite = playerColor === "w" ? bestLine.score : -bestLine.score;
    whitePct = Math.min(98, Math.max(2, 50 + cpFromWhite / 10));
  }

  const blackPct = 100 - whitePct;
  const flipped = (SITE === "chesscom" && board && isChesscomFlipped(board)) ||
                  (SITE === "lichess" && isLichessFlipped());

  // Build the eval bar container
  const container = document.createElement("div");
  container.id = "chessbot-eval-bar";
  container.style.cssText = `
    position: absolute;
    left: -28px;
    top: 0;
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

  // Top section (white if not flipped, black if flipped)
  const topColor = flipped ? "#333" : "#f0f0f0";
  const botColor = flipped ? "#f0f0f0" : "#333";
  const topPct = flipped ? blackPct : whitePct;

  const topDiv = document.createElement("div");
  topDiv.style.cssText = `background:${topColor};height:${100 - topPct}%;transition:height 0.5s ease;`;
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
    ${isWhiteAdvantage === !flipped
      ? `bottom: 2px; color: #333;`
      : `top: 2px; color: #ccc;`}
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

  const parentPos = getComputedStyle(parent).position;
  if (parentPos === "static") parent.style.position = "relative";
  parent.appendChild(container);
}

// ── Listen for messages from popup ───────────────────────────
if (typeof chrome !== "undefined" && chrome.runtime) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "toggle") {
      enabled = msg.enabled;
      console.log(`[chessbot] ${enabled ? "enabled" : "disabled"}`);
      if (!enabled) clearArrow();
      if (enabled) readAndSend();
    }
    if (msg.type === "set_option") {
      // Relay engine setting to backend
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "set_option", name: msg.name, value: msg.value }));
        console.log(`[chessbot] set_option: ${msg.name} = ${msg.value}`);
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
    if (msg.type === "ping") {
      return true;
    }
  });
}
