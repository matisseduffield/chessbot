const path = require("path");

module.exports = {
  // ── Engine ────────────────────────────────────────────
  stockfishPath:
    process.env.STOCKFISH_PATH ||
    path.join(__dirname, "..", "engine", "stockfish", "stockfish-windows-x86-64-avx2.exe"),

  // ── Opening Book (Polyglot .bin) ──────────────────────
  // Set to "" or remove the file to disable book lookups.
  openingBookPath:
    process.env.OPENING_BOOK_PATH ||
    path.join(__dirname, "..", "books", "book.bin"),

  // ── Syzygy Endgame Tablebases ─────────────────────────
  // Set to "" to disable. Separate multiple folders with ";".
  syzygyPath:
    process.env.SYZYGY_PATH ||
    path.join(__dirname, "..", "syzygy"),

  // ── Server ────────────────────────────────────────────
  port: Number(process.env.PORT) || 8080,

  // ── Analysis defaults ─────────────────────────────────
  defaultDepth: 15,
};
