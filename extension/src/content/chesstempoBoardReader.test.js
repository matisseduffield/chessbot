// Site-adapter contract tests for the ChessTempo board reader.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  chesstempoBoardToFen,
  isChessTempoFlipped,
  pieceClassToFenCharCT,
  percentToSquare,
  extractFenFromHeading,
} from './chesstempoBoardReader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../../tests/fixtures/chesstempo');

function loadFixture(name) {
  const html = readFileSync(resolve(fixturesDir, name), 'utf8');
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return dom.window.document;
}

describe('pieceClassToFenCharCT', () => {
  it('decodes white pieces to uppercase', () => {
    expect(pieceClassToFenCharCT('ct-pieceClass ct-piece-whiteking')).toBe('K');
    expect(pieceClassToFenCharCT('ct-pieceClass ct-piece-whiterook')).toBe('R');
    expect(pieceClassToFenCharCT('ct-pieceClass ct-piece-whitepawn')).toBe('P');
  });

  it('decodes black pieces to lowercase', () => {
    expect(pieceClassToFenCharCT('ct-pieceClass ct-piece-blackqueen')).toBe('q');
    expect(pieceClassToFenCharCT('ct-pieceClass ct-piece-blackknight')).toBe('n');
  });

  it('returns null for unrecognised classes', () => {
    expect(pieceClassToFenCharCT('ct-pieceClass')).toBeNull();
    expect(pieceClassToFenCharCT('weird')).toBeNull();
    expect(pieceClassToFenCharCT('')).toBeNull();
    expect(pieceClassToFenCharCT(null)).toBeNull();
  });
});

describe('percentToSquare', () => {
  it('maps percentage offsets to squares', () => {
    // a8 — top-left
    expect(percentToSquare(0, 0, false)).toEqual({ file: 0, rank: 0 });
    // h1 — bottom-right
    expect(percentToSquare(87.5, 87.5, false)).toEqual({ file: 7, rank: 7 });
    // e4 (file 4, FEN-rank 4)
    expect(percentToSquare(50, 50, false)).toEqual({ file: 4, rank: 4 });
  });

  it('inverts file + rank when flipped', () => {
    expect(percentToSquare(0, 0, true)).toEqual({ file: 7, rank: 7 });
    expect(percentToSquare(87.5, 87.5, true)).toEqual({ file: 0, rank: 0 });
  });

  it('returns null for NaN inputs', () => {
    expect(percentToSquare(NaN, 0, false)).toBeNull();
    expect(percentToSquare(0, NaN, false)).toBeNull();
  });

  it('returns null for out-of-range coords', () => {
    expect(percentToSquare(120, 0, false)).toBeNull();
    expect(percentToSquare(0, -20, false)).toBeNull();
  });
});

describe('extractFenFromHeading', () => {
  it('returns the FEN string from an h2 inside chess-board', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><chess-board>
        <h2>FEN: 8/8/8/8/4k3/8/8/4K3 w - - 0 1</h2>
       </chess-board></body></html>`,
    );
    expect(extractFenFromHeading(dom.window.document)).toBe('8/8/8/8/4k3/8/8/4K3 w - - 0 1');
  });

  it('returns null when no FEN heading is present', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><chess-board><h2>Some other heading</h2></chess-board></body></html>`,
    );
    expect(extractFenFromHeading(dom.window.document)).toBeNull();
  });
});

describe('isChessTempoFlipped', () => {
  it('returns false when file coords start with "a"', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><chess-board><div class="ct-board-inner-holder">
         <div class="ct-file-coord">a</div>
       </div></chess-board></body></html>`,
    );
    expect(isChessTempoFlipped(dom.window.document)).toBe(false);
  });

  it('returns true when file coords start with "h"', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><chess-board><div class="ct-board-inner-holder">
         <div class="ct-file-coord">h</div>
       </div></chess-board></body></html>`,
    );
    expect(isChessTempoFlipped(dom.window.document)).toBe(true);
  });

  it('returns true when rank coords start with "1"', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><chess-board>
         <div class="ct-rank-coord">1</div>
       </chess-board></body></html>`,
    );
    expect(isChessTempoFlipped(dom.window.document)).toBe(true);
  });

  it('falls back to false when no coordinate signal is present', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><chess-board></chess-board></body></html>`);
    expect(isChessTempoFlipped(dom.window.document)).toBe(false);
  });
});

describe('chesstempoBoardToFen', () => {
  it('takes the heading fast-path when present', () => {
    const doc = loadFixture('heading-fastpath.html');
    const fen = chesstempoBoardToFen(doc);
    expect(fen).toBe('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  });

  it('reads the start position from piece elements', () => {
    const doc = loadFixture('start.html');
    const fen = chesstempoBoardToFen(doc);
    expect(fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });

  it('returns null when no chess-board element is present', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><div></div></body></html>`);
    expect(chesstempoBoardToFen(dom.window.document)).toBeNull();
  });

  it('returns null when chess-board is empty (no heading, no pieces)', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><chess-board></chess-board></body></html>`);
    expect(chesstempoBoardToFen(dom.window.document)).toBeNull();
  });

  it('skips pieces whose class lacks a recognisable color/type', () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><chess-board>
        <div class="ct-pieceClass ct-piece-whiteking" style="left: 50%; top: 87.5%"></div>
        <div class="ct-pieceClass weird-class" style="left: 0%; top: 0%"></div>
       </chess-board></body></html>`,
    );
    const fen = chesstempoBoardToFen(dom.window.document);
    expect(fen).toBe('8/8/8/8/8/8/8/4K3 w - - 0 1');
  });
});
