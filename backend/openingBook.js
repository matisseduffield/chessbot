const fs = require("fs");
const { Polyglot } = require("chess-openings");

class OpeningBook {
  constructor(bookPath) {
    this.bookPath = bookPath;
    this.book = null;
    this.enabled = false;
  }

  /** Open the book file. Silently disables itself if the file doesn't exist. */
  async init() {
    if (!this.bookPath || !fs.existsSync(this.bookPath)) {
      console.log(`[book] no opening book found at "${this.bookPath}" – disabled`);
      return;
    }

    try {
      this.book = new Polyglot(this.bookPath);
      await this.book.open();
      this.enabled = true;
      console.log(`[book] loaded opening book: ${this.bookPath}`);
    } catch (err) {
      console.error(`[book] failed to load book: ${err.message}`);
      this.book = null;
    }
  }

  /**
   * Look up a FEN in the opening book.
   * Returns a UCI move string (e.g. "e2e4") or null if not found.
   */
  async lookup(fen) {
    if (!this.enabled || !this.book) return null;

    try {
      const entry = await this.book.lookup(fen);
      if (!entry) return null;

      const bestMove = entry.getBestMove();
      if (bestMove) {
        console.log(
          `[book] hit: ${bestMove}  (candidates: ${entry
            .continuations()
            .map((c) => `${c.move}(w=${c.weight})`)
            .join(", ")})`
        );
      }
      return bestMove || null;
    } catch (err) {
      console.error(`[book] lookup error: ${err.message}`);
      return null;
    }
  }

  async close() {
    if (this.book) {
      await this.book.close();
      console.log("[book] closed");
    }
  }
}

module.exports = OpeningBook;
