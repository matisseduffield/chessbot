// Site-adapter contract tests for the PlayStrategy board reader.
// Same pattern as lichessBoardReader.test.js — load checked-in HTML
// fixtures via jsdom, drive the reader, assert the FEN. Catches DOM
// regressions on the live site (class rename, transform shape change)
// before users do.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  playstrategyBoardToFen,
  isPlayStrategyFlipped,
  pieceClassToFenCharP1P2,
} from './playstrategyBoardReader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../../tests/fixtures/playstrategy');

function loadFixture(name) {
  const html = readFileSync(resolve(fixturesDir, name), 'utf8');
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return dom.window.document;
}

const BOARD_RECT = { width: 512, height: 512 };

describe('pieceClassToFenCharP1P2', () => {
  it('maps p1 + piece-type to uppercase FEN char', () => {
    expect(pieceClassToFenCharP1P2('p1 p-piece ally')).toBe('P');
    expect(pieceClassToFenCharP1P2('p1 r-piece ally')).toBe('R');
    expect(pieceClassToFenCharP1P2('p1 k-piece ally')).toBe('K');
  });

  it('maps p2 + piece-type to lowercase FEN char', () => {
    expect(pieceClassToFenCharP1P2('p2 n-piece enemy')).toBe('n');
    expect(pieceClassToFenCharP1P2('p2 q-piece enemy')).toBe('q');
  });

  it('returns null for unrecognised classes', () => {
    expect(pieceClassToFenCharP1P2('weird unknown')).toBeNull();
    expect(pieceClassToFenCharP1P2('p1')).toBeNull();
    expect(pieceClassToFenCharP1P2('')).toBeNull();
    expect(pieceClassToFenCharP1P2(null)).toBeNull();
  });
});

describe('isPlayStrategyFlipped', () => {
  it('returns false for orientation-p1', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><div class="cg-wrap orientation-p1"></div></body></html>`,
    );
    expect(isPlayStrategyFlipped(dom.window.document)).toBe(false);
  });

  it('returns true for orientation-p2', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><div class="cg-wrap orientation-p2"></div></body></html>`,
    );
    expect(isPlayStrategyFlipped(dom.window.document)).toBe(true);
  });

  it('returns true for orientation-black (Chessground compat)', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><div class="cg-wrap orientation-black"></div></body></html>`,
    );
    expect(isPlayStrategyFlipped(dom.window.document)).toBe(true);
  });

  it('falls back to false when no orientation class is present', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><div class="cg-wrap"></div></body></html>`);
    expect(isPlayStrategyFlipped(dom.window.document)).toBe(false);
  });
});

describe('playstrategyBoardToFen', () => {
  it('reads the start position correctly', () => {
    const doc = loadFixture('start.html');
    const fen = playstrategyBoardToFen(doc, { boardRect: BOARD_RECT });
    expect(fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });

  it('returns null when no cg-board element is present', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><div></div></body></html>`);
    expect(playstrategyBoardToFen(dom.window.document, { boardRect: BOARD_RECT })).toBeNull();
  });

  it('returns null when cg-board exists but has no pieces', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div class="cg-wrap orientation-p1"><cg-board></cg-board></div>
       </body></html>`,
    );
    expect(playstrategyBoardToFen(dom.window.document, { boardRect: BOARD_RECT })).toBeNull();
  });

  it('skips ghost pieces (premove preview)', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div class="cg-wrap orientation-p1">
           <cg-board>
             <piece class="p1 k-piece" style="transform: translate(256px, 448px)"></piece>
             <piece class="p1 p-piece ghost" style="transform: translate(192px, 384px)"></piece>
           </cg-board>
         </div>
       </body></html>`,
    );
    const fen = playstrategyBoardToFen(dom.window.document, { boardRect: BOARD_RECT });
    expect(fen).toBe('8/8/8/8/8/8/8/4K3 w - - 0 1');
  });

  it('skips pieces with unrecognised classes', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div class="cg-wrap orientation-p1">
           <cg-board>
             <piece class="p1 k-piece" style="transform: translate(256px, 448px)"></piece>
             <piece class="weird strange" style="transform: translate(0px, 0px)"></piece>
           </cg-board>
         </div>
       </body></html>`,
    );
    const fen = playstrategyBoardToFen(dom.window.document, { boardRect: BOARD_RECT });
    expect(fen).toBe('8/8/8/8/8/8/8/4K3 w - - 0 1');
  });

  it('inverts coordinates correctly when flipped (orientation-p2)', () => {
    // A p1 pawn logically on e4 (file 4, grid-rank 4). With the board
    // rotated 180°, its visual pixel position is ((7-4)*64, (7-4)*64).
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div class="cg-wrap orientation-p2">
           <cg-board>
             <piece class="p1 p-piece" style="transform: translate(192px, 192px)"></piece>
           </cg-board>
         </div>
       </body></html>`,
    );
    const fen = playstrategyBoardToFen(dom.window.document, { boardRect: BOARD_RECT });
    expect(fen).toBe('8/8/8/8/4P3/8/8/8 w - - 0 1');
  });
});
