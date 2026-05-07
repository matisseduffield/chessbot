import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  chesscomBoardToFen,
  isChesscomFlipped,
  pieceClassToFenCharCC,
  parseChesscomSquareClass,
} from './chesscomBoardReader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../../tests/fixtures/chesscom');

function loadFixture(name) {
  const html = readFileSync(resolve(fixturesDir, name), 'utf8');
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return dom.window.document;
}

describe('pieceClassToFenCharCC', () => {
  it('decodes white pieces to uppercase', () => {
    expect(pieceClassToFenCharCC('piece wp square-52')).toBe('P');
    expect(pieceClassToFenCharCC('piece wk square-51')).toBe('K');
    expect(pieceClassToFenCharCC('piece wq square-41')).toBe('Q');
  });

  it('decodes black pieces to lowercase', () => {
    expect(pieceClassToFenCharCC('piece bn square-78')).toBe('n');
    expect(pieceClassToFenCharCC('piece br square-18')).toBe('r');
  });

  it('returns null for classes without a wb-letter token', () => {
    expect(pieceClassToFenCharCC('piece square-11')).toBeNull();
    expect(pieceClassToFenCharCC('piece highlight')).toBeNull();
    expect(pieceClassToFenCharCC('')).toBeNull();
    expect(pieceClassToFenCharCC(null)).toBeNull();
  });

  it('does not match wb-letter substrings of unrelated tokens', () => {
    // "swapped" contains 'wp' but not as a whole token.
    expect(pieceClassToFenCharCC('class="swapped"')).toBeNull();
  });
});

describe('parseChesscomSquareClass', () => {
  it('decodes square-XY into zero-indexed file/rank', () => {
    expect(parseChesscomSquareClass('piece wp square-11')).toEqual({ file: 0, rank: 0 });
    expect(parseChesscomSquareClass('piece bk square-58')).toEqual({ file: 4, rank: 7 });
    expect(parseChesscomSquareClass('piece wr square-88')).toEqual({ file: 7, rank: 7 });
  });

  it('returns null when no square-XY token is present', () => {
    expect(parseChesscomSquareClass('piece wp')).toBeNull();
    expect(parseChesscomSquareClass('square-only')).toBeNull();
    expect(parseChesscomSquareClass('')).toBeNull();
  });
});

describe('isChesscomFlipped', () => {
  it('returns true when cachedPlayerColor is "b"', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><wc-chess-board></wc-chess-board></body></html>`,
    );
    const board = dom.window.document.querySelector('wc-chess-board');
    expect(isChesscomFlipped(board, { cachedPlayerColor: 'b' })).toBe(true);
  });

  it('returns false when cachedPlayerColor is "w" (overrides everything else)', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <wc-chess-board class="flipped"></wc-chess-board>
       </body></html>`,
    );
    const board = dom.window.document.querySelector('wc-chess-board');
    expect(isChesscomFlipped(board, { cachedPlayerColor: 'w' })).toBe(false);
  });

  it('returns true for the "flipped" class', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><wc-chess-board class="flipped"></wc-chess-board></body></html>`,
    );
    const board = dom.window.document.querySelector('wc-chess-board');
    expect(isChesscomFlipped(board)).toBe(true);
  });

  it('returns true for the "flipped" attribute', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><wc-chess-board flipped></wc-chess-board></body></html>`,
    );
    const board = dom.window.document.querySelector('wc-chess-board');
    expect(isChesscomFlipped(board)).toBe(true);
  });

  it('returns true when an ancestor has the flipped class', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <div class="board-wrapper flipped">
          <wc-chess-board></wc-chess-board>
        </div>
       </body></html>`,
    );
    const board = dom.window.document.querySelector('wc-chess-board');
    expect(isChesscomFlipped(board)).toBe(true);
  });

  it('returns true when coordinate labels start with "h"', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <wc-chess-board></wc-chess-board>
        <div class="coordinates-row">hgfedcba</div>
       </body></html>`,
    );
    const board = dom.window.document.querySelector('wc-chess-board');
    expect(isChesscomFlipped(board)).toBe(true);
  });

  it('returns false when no flip signal is present', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><wc-chess-board></wc-chess-board></body></html>`,
    );
    const board = dom.window.document.querySelector('wc-chess-board');
    expect(isChesscomFlipped(board)).toBe(false);
  });
});

describe('chesscomBoardToFen', () => {
  it('reads the start position from the fixture', () => {
    const doc = loadFixture('start.html');
    expect(chesscomBoardToFen(doc)).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
  });

  it('returns null when no board element is present', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><div></div></body></html>`);
    expect(chesscomBoardToFen(dom.window.document)).toBeNull();
  });

  it('returns null when the board is empty', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><wc-chess-board></wc-chess-board></body></html>`,
    );
    expect(chesscomBoardToFen(dom.window.document)).toBeNull();
  });

  it('skips ghost pieces (premove preview)', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><wc-chess-board>
        <div class="piece wk square-51"></div>
        <div class="piece wp ghost square-52"></div>
       </wc-chess-board></body></html>`,
    );
    // wk on e1 + ghost wp ignored. Below threshold (placed < 2) → null.
    expect(chesscomBoardToFen(dom.window.document)).toBeNull();
  });

  it('reads a position with 2+ pieces past the placed threshold', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><wc-chess-board>
        <div class="piece wk square-51"></div>
        <div class="piece bk square-58"></div>
       </wc-chess-board></body></html>`,
    );
    // K on e1 + k on e8. No castling rights (no rooks).
    expect(chesscomBoardToFen(dom.window.document)).toBe('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  });

  it('skips pieces missing either the wb-letter or square-XY token', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><wc-chess-board>
        <div class="piece wk square-51"></div>
        <div class="piece bk square-58"></div>
        <div class="piece wp"></div>          <!-- no square -->
        <div class="piece square-44"></div>   <!-- no piece type -->
       </wc-chess-board></body></html>`,
    );
    expect(chesscomBoardToFen(dom.window.document)).toBe('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  });
});
