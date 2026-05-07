import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ADAPTERS,
  adapterForHost,
  adapterForDoc,
  lichessAdapter,
  playstrategyAdapter,
  chesstempoAdapter,
  chesscomAdapter,
} from './siteAdapters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(__dirname, '../../../tests/fixtures');

function loadFixture(site, name) {
  const html = readFileSync(resolve(fixturesRoot, site, name), 'utf8');
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BOARD_RECT = { width: 512, height: 512 };

describe('adapterForHost', () => {
  it('routes lichess.org to lichessAdapter', () => {
    expect(adapterForHost('lichess.org')).toBe(lichessAdapter);
    expect(adapterForHost('www.lichess.org')).toBe(lichessAdapter);
  });

  it('routes playstrategy.org to playstrategyAdapter', () => {
    expect(adapterForHost('playstrategy.org')).toBe(playstrategyAdapter);
  });

  it('routes chesstempo.com to chesstempoAdapter', () => {
    expect(adapterForHost('chesstempo.com')).toBe(chesstempoAdapter);
    expect(adapterForHost('www.chesstempo.com')).toBe(chesstempoAdapter);
  });

  it('routes chess.com to chesscomAdapter', () => {
    expect(adapterForHost('www.chess.com')).toBe(chesscomAdapter);
    expect(adapterForHost('chess.com')).toBe(chesscomAdapter);
  });

  it('returns null for unrecognised hostnames', () => {
    expect(adapterForHost('example.com')).toBeNull();
    expect(adapterForHost('')).toBeNull();
    expect(adapterForHost(null)).toBeNull();
  });

  it('exposes ADAPTERS as a stable list with each site exactly once', () => {
    const sites = ADAPTERS.map((a) => a.site).sort();
    expect(sites).toEqual(['chesscom', 'chesstempo', 'lichess', 'playstrategy']);
  });
});

describe('adapterForDoc', () => {
  it('uses defaultView.location.hostname when available', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
      url: 'https://lichess.org/study/123',
    });
    expect(adapterForDoc(dom.window.document)).toBe(lichessAdapter);
  });

  it('returns null for an unmatched URL', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
      url: 'https://example.com/',
    });
    expect(adapterForDoc(dom.window.document)).toBeNull();
  });
});

describe('uniform contract — every adapter implements the same shape', () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter.site}: has site + hostMatch + detectBoard + extractFen + detectFlip`, () => {
      expect(typeof adapter.site).toBe('string');
      expect(typeof adapter.hostMatch).toBe('function');
      expect(typeof adapter.detectBoard).toBe('function');
      expect(typeof adapter.extractFen).toBe('function');
      expect(typeof adapter.detectFlip).toBe('function');
    });
  }
});

describe('lichessAdapter end-to-end against the fixture', () => {
  it('detectBoard finds <cg-board>', () => {
    const doc = loadFixture('lichess', 'start.html');
    expect(lichessAdapter.detectBoard(doc)).not.toBeNull();
  });

  it('extractFen returns the start position', () => {
    const doc = loadFixture('lichess', 'start.html');
    expect(lichessAdapter.extractFen(doc, { boardRect: BOARD_RECT })).toBe(START_FEN);
  });

  it('detectFlip returns false for orientation-white', () => {
    const doc = loadFixture('lichess', 'start.html');
    expect(lichessAdapter.detectFlip(doc)).toBe(false);
  });
});

describe('playstrategyAdapter end-to-end', () => {
  it('extractFen + detectFlip on the start fixture', () => {
    const doc = loadFixture('playstrategy', 'start.html');
    expect(playstrategyAdapter.extractFen(doc, { boardRect: BOARD_RECT })).toBe(START_FEN);
    expect(playstrategyAdapter.detectFlip(doc)).toBe(false);
  });
});

describe('chesstempoAdapter end-to-end', () => {
  it('extractFen on the start fixture', () => {
    const doc = loadFixture('chesstempo', 'start.html');
    expect(chesstempoAdapter.extractFen(doc)).toBe(START_FEN);
  });

  it('extractFen takes the heading fast-path when present', () => {
    const doc = loadFixture('chesstempo', 'heading-fastpath.html');
    expect(chesstempoAdapter.extractFen(doc)).toBe('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  });
});

describe('chesscomAdapter end-to-end', () => {
  it('detectBoard finds <wc-chess-board>', () => {
    const doc = loadFixture('chesscom', 'start.html');
    expect(chesscomAdapter.detectBoard(doc)).not.toBeNull();
  });

  it('extractFen returns the start position', () => {
    const doc = loadFixture('chesscom', 'start.html');
    expect(chesscomAdapter.extractFen(doc)).toBe(START_FEN);
  });

  it('detectFlip is false for an unflipped board', () => {
    const doc = loadFixture('chesscom', 'start.html');
    expect(chesscomAdapter.detectFlip(doc)).toBe(false);
  });

  it('detectFlip honours cachedPlayerColor option', () => {
    const doc = loadFixture('chesscom', 'start.html');
    expect(chesscomAdapter.detectFlip(doc, { cachedPlayerColor: 'b' })).toBe(true);
  });
});
