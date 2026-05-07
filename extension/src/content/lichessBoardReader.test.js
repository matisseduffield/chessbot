// Site-adapter contract tests for the Lichess / Chessground board reader.
// Plan §2.1 (P2.G): catch selector-shape regressions without a real
// browser. The fixtures under tests/fixtures/lichess/ are checked-in
// snapshots of the markup the live site emits; if Lichess renames
// `cg-board`, drops the orientation-* class, or changes the piece
// transform format, one of these tests should fail before a user does.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { lichessBoardToFen, isLichessFlipped } from './lichessBoardReader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../../tests/fixtures/lichess');

/** Load a fixture file and return its parsed jsdom Document. */
function loadFixture(name) {
  const html = readFileSync(resolve(fixturesDir, name), 'utf8');
  // Wrap in a minimal HTML scaffold so jsdom returns a usable Document.
  // The fixture is the body content.
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return dom.window.document;
}

// Real Lichess uses 64px squares by default. jsdom doesn't lay out, so
// we pass an explicit boardRect that matches the fixtures' transform
// units and lets translateToSquare math out cleanly.
const BOARD_RECT = { width: 512, height: 512 };

describe('isLichessFlipped', () => {
  it('returns false when .cg-wrap has orientation-white', () => {
    const doc = loadFixture('start.html');
    expect(isLichessFlipped(doc)).toBe(false);
  });

  it('returns true when .cg-wrap has orientation-black', () => {
    const doc = loadFixture('flipped-minimal.html');
    expect(isLichessFlipped(doc)).toBe(true);
  });

  it('returns true when .cg-wrap has the PlayStrategy orientation-p2 class', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><div class="cg-wrap orientation-p2"><cg-board></cg-board></div></body></html>`,
    );
    expect(isLichessFlipped(dom.window.document)).toBe(true);
  });

  it('falls back to false when neither orientation class nor coord labels are present', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><div class="cg-wrap"><cg-board></cg-board></div></body></html>`,
    );
    expect(isLichessFlipped(dom.window.document)).toBe(false);
  });

  it('infers flipped via the rank-1-on-top coord label', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div class="cg-wrap"><cg-board></cg-board></div>
         <coords class="ranks"><coord>1</coord><coord>2</coord></coords>
       </body></html>`,
    );
    expect(isLichessFlipped(dom.window.document)).toBe(true);
  });
});

describe('lichessBoardToFen — full board fixtures', () => {
  it('reads the start position correctly', () => {
    const doc = loadFixture('start.html');
    const fen = lichessBoardToFen(doc, { boardRect: BOARD_RECT });
    expect(fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });

  it('picks up a single move (1. e4)', () => {
    const doc = loadFixture('after-e4.html');
    const fen = lichessBoardToFen(doc, { boardRect: BOARD_RECT });
    // Castling rights are derived from king + rook positions on the
    // home squares (still intact after 1. e4).
    expect(fen).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1');
  });

  it('handles a flipped (orientation-black) board', () => {
    const doc = loadFixture('flipped-minimal.html');
    const fen = lichessBoardToFen(doc, { boardRect: BOARD_RECT });
    // Single white pawn on e4. No castling rights (no kings on home
    // squares in this minimal fixture).
    expect(fen).toBe('8/8/8/8/4P3/8/8/8 w - - 0 1');
  });
});

describe('lichessBoardToFen — error and edge cases', () => {
  it('returns null when no cg-board element is present', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><div></div></body></html>`);
    expect(lichessBoardToFen(dom.window.document, { boardRect: BOARD_RECT })).toBeNull();
  });

  it('returns null when cg-board exists but has no pieces', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div class="cg-wrap orientation-white"><cg-board></cg-board></div>
       </body></html>`,
    );
    expect(lichessBoardToFen(dom.window.document, { boardRect: BOARD_RECT })).toBeNull();
  });

  it('skips ghost pieces (premove preview) instead of placing them', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div class="cg-wrap orientation-white">
           <cg-board>
             <piece class="white king" style="transform: translate(256px, 448px);"></piece>
             <piece class="white pawn ghost" style="transform: translate(192px, 384px);"></piece>
           </cg-board>
         </div>
       </body></html>`,
    );
    const fen = lichessBoardToFen(dom.window.document, { boardRect: BOARD_RECT });
    // Only the king should appear; the ghost-pawn must be ignored.
    expect(fen).toBe('8/8/8/8/8/8/8/4K3 w - - 0 1');
  });

  it('skips pieces whose class lacks a recognisable color or type', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div class="cg-wrap orientation-white">
           <cg-board>
             <piece class="white king" style="transform: translate(256px, 448px);"></piece>
             <piece class="weird unknown-piece" style="transform: translate(0px, 0px);"></piece>
             <piece class="white" style="transform: translate(64px, 0px);"></piece>
           </cg-board>
         </div>
       </body></html>`,
    );
    const fen = lichessBoardToFen(dom.window.document, { boardRect: BOARD_RECT });
    expect(fen).toBe('8/8/8/8/8/8/8/4K3 w - - 0 1');
  });

  it('honours the readPocket hook for drop variants', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div class="cg-wrap orientation-white">
           <cg-board>
             <piece class="white king" style="transform: translate(256px, 448px);"></piece>
           </cg-board>
         </div>
       </body></html>`,
    );
    const fen = lichessBoardToFen(dom.window.document, {
      boardRect: BOARD_RECT,
      readPocket: () => '[Pp]',
    });
    // gridToFenBoard appends the pocket to the rank-1 row before the
    // side-to-move marker. Crazyhouse-shaped output.
    expect(fen).toBe('8/8/8/8/8/8/8/4K3[Pp] w - - 0 1');
  });
});
