const fs = require("fs");
const { Polyglot } = require("chess-openings");

class OpeningBook {
  constructor(bookPath) {
    // Support single path (string) or multiple paths (array)
    if (Array.isArray(bookPath)) {
      this.bookPaths = bookPath.filter(Boolean);
      this.bookPath = this.bookPaths[0] || "";
    } else {
      this.bookPath = bookPath || "";
      this.bookPaths = this.bookPath ? [this.bookPath] : [];
    }
    this.books = []; // array of { path, book } objects
    this.enabled = false;
  }

  /** Open all book files. Silently skips files that don't exist. */
  async init() {
    this.books = [];
    for (const p of this.bookPaths) {
      if (!p || !fs.existsSync(p)) {
        console.log(`[book] no opening book found at "${p}" – skipped`);
        continue;
      }
      try {
        const b = new Polyglot(p);
        await b.open();
        this.books.push({ path: p, book: b });
        console.log(`[book] loaded opening book: ${p}`);
      } catch (err) {
        console.error(`[book] failed to load book "${p}": ${err.message}`);
      }
    }
    this.enabled = this.books.length > 0;
    if (!this.enabled) {
      console.log("[book] no books loaded – disabled");
    }
  }

  /**
   * Look up a FEN in all loaded books.
   * Merges continuations across books by summing weights.
   * Returns the best move (UCI string) or null if not found.
   */
  async lookup(fen) {
    if (!this.enabled || this.books.length === 0) return null;

    const merged = {}; // move → total weight

    for (const { book, path } of this.books) {
      try {
        const entry = await book.lookup(fen);
        if (!entry) continue;
        for (const c of entry.continuations()) {
          merged[c.move] = (merged[c.move] || 0) + c.weight;
        }
      } catch (err) {
        console.error(`[book] lookup error in "${path}": ${err.message}`);
      }
    }

    if (Object.keys(merged).length === 0) return null;

    // Pick the move with the highest combined weight
    const best = Object.entries(merged).sort((a, b) => b[1] - a[1])[0];
    console.log(
      `[book] hit: ${best[0]}  (candidates: ${Object.entries(merged)
        .sort((a, b) => b[1] - a[1])
        .map(([m, w]) => `${m}(w=${w})`)
        .join(", ")})`
    );
    return best[0];
  }

  async close() {
    for (const { book, path } of this.books) {
      try {
        await book.close();
        console.log(`[book] closed: ${path}`);
      } catch {}
    }
    this.books = [];
    this.enabled = false;
  }
}

module.exports = OpeningBook;
