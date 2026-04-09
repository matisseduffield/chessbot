const path = require("path");
const fs = require("fs");

// Auto-detect the first .bin book in books/
function findFirstBook(dir) {
  try {
    const files = fs.readdirSync(dir);
    const bin = files.find((f) => f.toLowerCase().endsWith(".bin"));
    return bin ? path.join(dir, bin) : null;
  } catch { return null; }
}

const booksDir = process.env.BOOKS_DIR || path.join(__dirname, "..", "books");

module.exports = {
  // ── Directories (for scanning available files) ────────
  engineDir:
    process.env.ENGINE_DIR ||
    path.join(__dirname, "..", "engine"),

  booksDir,

  syzygyDir:
    process.env.SYZYGY_DIR ||
    path.join(__dirname, "..", "syzygy"),

  // ── Engine ────────────────────────────────────────────
  stockfishPath:
    process.env.STOCKFISH_PATH ||
    path.join(__dirname, "..", "engine", "stockfish", "stockfish-windows-x86-64-avx2.exe"),

  fairyStockfishPath:
    process.env.FAIRY_STOCKFISH_PATH ||
    path.join(__dirname, "..", "engine", "fairy-stockfish", "fairy-stockfish_x86-64-bmi2.exe"),

  // ── Opening Book (Polyglot .bin) ──────────────────────
  // Auto-detects the first .bin in books/ if OPENING_BOOK_PATH is not set.
  openingBookPath:
    process.env.OPENING_BOOK_PATH || findFirstBook(booksDir),

  // ── Syzygy Endgame Tablebases ─────────────────────────
  // Set to "" to disable. Separate multiple folders with ";".
  syzygyPath:
    process.env.SYZYGY_PATH ||
    path.join(__dirname, "..", "syzygy"),

  // ── Server ────────────────────────────────────────────
  port: Number(process.env.PORT) || 8080,

  // ── Analysis defaults ─────────────────────────────────
  defaultDepth: 15,
  searchMovetime: null,  // ms — set from panel
  searchNodes: null,     // node count — set from panel
};
