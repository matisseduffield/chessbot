// @ts-check
/**
 * Site-adapter interface — the contract every per-site board reader
 * implements, plus a registry that picks the right adapter by hostname.
 *
 * Plan §3 (P3.E): the previous design had one big `boardToFen()` in
 * content.js that switched on `SITE` and called inline per-site
 * readers. That made it impossible to test any single site's reader
 * end-to-end without running the whole content script.
 *
 * Phase 2 + 3 extracted four readers into their own modules:
 *   - lichessBoardReader.js     — Lichess (Chessground)
 *   - playstrategyBoardReader.js — PlayStrategy (Chessground)
 *   - chesstempoBoardReader.js   — ChessTempo
 *   - chesscomBoardReader.js     — chess.com (primary path)
 *
 * This module gives them a uniform interface so the dispatcher in
 * content.js can be a one-line lookup, and so future migrations
 * (e.g. swapping Chessground for a new lichess board layout) only
 * touch the adapter registration.
 *
 * Contract:
 *   adapter.site         — the canonical site key (`'chesscom'`, ...)
 *   adapter.detectBoard(doc)
 *                        — returns the board Element or null.
 *   adapter.extractFen(doc, opts)
 *                        — returns the FEN board portion or null.
 *   adapter.detectFlip(doc, opts)
 *                        — returns boolean (true means rendered with
 *                          black at bottom).
 *
 * The `observe` half of the original plan (`{detectBoard, extractFen,
 * detectFlip, observe}`) deliberately isn't in the v1 interface. The
 * MutationObserver setup in content.js is tangled with module-global
 * state (variant detection, debounce timers, drag-stuck detection)
 * that doesn't belong inside per-site adapters. Splitting it out is
 * its own follow-up.
 */

import {
  lichessBoardToFen,
  isLichessFlipped,
  detectLichessFlipConfidence,
} from './lichessBoardReader.js';
import {
  playstrategyBoardToFen,
  isPlayStrategyFlipped,
  detectPlayStrategyFlipConfidence,
} from './playstrategyBoardReader.js';
import {
  chesstempoBoardToFen,
  isChessTempoFlipped,
  detectChessTempoFlipConfidence,
} from './chesstempoBoardReader.js';
import {
  chesscomBoardToFen,
  isChesscomFlipped,
  detectChesscomFlipConfidence,
} from './chesscomBoardReader.js';

/**
 * @typedef {'flipped' | 'unflipped' | 'unknown'} FlipConfidence
 *
 * @typedef {'chesscom' | 'lichess' | 'playstrategy' | 'chesstempo'} SiteKey
 *
 * @typedef {{
 *   site: SiteKey,
 *   hostMatch: (hostname: string) => boolean,
 *   detectBoard: (doc: Document) => Element | null,
 *   extractFen: (doc: Document, opts?: any) => string | null,
 *   detectFlip: (doc: Document, opts?: any) => boolean,
 *   detectFlipConfidence: (doc: Document, opts?: any) => FlipConfidence,
 * }} SiteAdapter
 */

/** @type {SiteAdapter} */
export const lichessAdapter = {
  site: 'lichess',
  hostMatch: (h) => h.includes('lichess'),
  detectBoard: (doc) => doc.querySelector('cg-board'),
  extractFen: (doc, opts) => lichessBoardToFen(doc, opts),
  detectFlip: (doc) => isLichessFlipped(doc),
  detectFlipConfidence: (doc) => detectLichessFlipConfidence(doc),
};

/** @type {SiteAdapter} */
export const playstrategyAdapter = {
  site: 'playstrategy',
  hostMatch: (h) => h.includes('playstrategy'),
  detectBoard: (doc) => doc.querySelector('cg-board'),
  extractFen: (doc, opts) => playstrategyBoardToFen(doc, opts),
  detectFlip: (doc) => isPlayStrategyFlipped(doc),
  detectFlipConfidence: (doc) => detectPlayStrategyFlipConfidence(doc),
};

/** @type {SiteAdapter} */
export const chesstempoAdapter = {
  site: 'chesstempo',
  hostMatch: (h) => h.includes('chesstempo'),
  detectBoard: (doc) => doc.querySelector('chess-board'),
  extractFen: (doc, opts) => chesstempoBoardToFen(doc, opts),
  detectFlip: (doc) => isChessTempoFlipped(doc),
  detectFlipConfidence: (doc) => detectChessTempoFlipConfidence(doc),
};

/** @type {SiteAdapter} */
export const chesscomAdapter = {
  site: 'chesscom',
  hostMatch: (h) => h.includes('chess.com'),
  detectBoard: (doc) =>
    doc.querySelector('wc-chess-board') ||
    doc.querySelector('chess-board') ||
    doc.querySelector('[class*="board"][class*="chess"]'),
  extractFen: (doc, opts) => chesscomBoardToFen(doc, opts),
  detectFlip: (doc, opts) => {
    const board =
      doc.querySelector('wc-chess-board') ||
      doc.querySelector('chess-board') ||
      doc.querySelector('[class*="board"][class*="chess"]');
    if (!board) return false;
    return isChesscomFlipped(board, { ...(opts || {}), doc });
  },
  detectFlipConfidence: (doc, opts) => {
    const board =
      doc.querySelector('wc-chess-board') ||
      doc.querySelector('chess-board') ||
      doc.querySelector('[class*="board"][class*="chess"]');
    if (!board) return 'unknown';
    return detectChesscomFlipConfidence(board, { ...(opts || {}), doc });
  },
};

/** Registration order is the lookup order — keep most-specific first. */
export const ADAPTERS = [chesscomAdapter, lichessAdapter, playstrategyAdapter, chesstempoAdapter];

/**
 * Pick the adapter for a hostname, or null if none match. Pure — the
 * production caller passes `location.hostname`, tests can pass any
 * string they like.
 *
 * @param {string} hostname
 * @returns {SiteAdapter | null}
 */
export function adapterForHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return null;
  for (const a of ADAPTERS) {
    if (a.hostMatch(hostname)) return a;
  }
  return null;
}

/**
 * Pick the adapter from a Document — uses `document.location.hostname`
 * when available. Falls back to `null` for documents that don't carry
 * a location (jsdom + custom URL).
 *
 * @param {Document} doc
 * @returns {SiteAdapter | null}
 */
export function adapterForDoc(doc) {
  const host = doc?.defaultView?.location?.hostname || doc?.location?.hostname || '';
  return adapterForHost(host);
}
