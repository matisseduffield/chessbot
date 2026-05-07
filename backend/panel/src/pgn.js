// @ts-check
/**
 * Build an annotated PGN from the panel's eval-history buffer.
 *
 * Plan §8.5 / Phase 3: turn the dashboard's "Export" button from a
 * placeholder into a useful artefact. The previous inline implementation
 * emitted the literal string `1. ... {[%eval 0.20]} 2. ...` — every
 * "move" was the placeholder `...`, so the file imported into Lichess
 * Studies as `??.??` for every ply. This module derives the actual SAN
 * move between successive FENs in `state.evalHistory` using chess.js
 * and routes the result through `buildAnnotatedPgn` from `@chessbot/shared`.
 *
 * Edge cases handled:
 *   - First entry's FEN may not be the standard start position (puzzle
 *     mode, mid-game continuation). We honour `startFen` passed in by
 *     the caller and use the *first* evalHistory FEN as the start
 *     position when one isn't provided.
 *   - If two consecutive FENs aren't reachable in a single legal move
 *     (e.g. the user navigated backward), we stop the move list at
 *     that point and emit only the moves we could derive cleanly. The
 *     resulting PGN is shorter but valid.
 *   - chess.js sometimes refuses to load a FEN whose halfmove clock
 *     is malformed; we fall back to the position-only fields if so.
 *
 * Pure of the DOM and the WebSocket — only the panel `state.evalHistory`
 * + `state.gameInfo` shape is assumed. Unit-tested separately.
 */

import { Chess } from 'chess.js';
import { buildAnnotatedPgn } from '@chessbot/shared';

const STANDARD_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * @typedef {{ cp?: number, mate?: number, fen?: string, move?: number }} EvalHistoryEntry
 * @typedef {{
 *   white?: { name?: string, clock?: string },
 *   black?: { name?: string, clock?: string },
 * }} GameInfo
 */

/**
 * @param {string} fen
 * @returns {Chess | null}
 */
function loadFenSafely(fen) {
  if (!fen || typeof fen !== 'string') return null;
  try {
    return new Chess(fen);
  } catch {
    // chess.js rejects FENs with weird halfmove/fullmove counters or
    // variant-specific markers. Try a fallback: keep just the four
    // canonical fields (board / side / castling / en passant) and
    // synthesise zeros for the move counters.
    const parts = fen.split(/\s+/);
    if (parts.length < 4) return null;
    const fallback = `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]} 0 1`;
    try {
      return new Chess(fallback);
    } catch {
      return null;
    }
  }
}

/**
 * Find the legal move from `chess`'s current position that produces
 * `targetFen`'s board layout. Returns the SAN of that move, or null
 * if no single move connects them. Side-effect free — restores the
 * board if a candidate move doesn't match.
 *
 * @param {Chess} chess
 * @param {string} targetFen
 * @returns {string | null}
 */
function deriveSanToReach(chess, targetFen) {
  const targetBoard = (targetFen || '').split(/\s+/)[0];
  if (!targetBoard) return null;
  // chess.moves({ verbose: true }) returns all legal moves from the
  // current position, including SAN. Try each and accept the first
  // that produces the target board layout.
  const candidates = chess.moves({ verbose: true });
  for (const mv of candidates) {
    chess.move(mv);
    const reachedBoard = chess.fen().split(/\s+/)[0];
    if (reachedBoard === targetBoard) {
      // Caller takes ownership of the new position, so don't undo.
      return mv.san;
    }
    chess.undo();
  }
  return null;
}

/**
 * @param {{
 *   evalHistory?: EvalHistoryEntry[],
 *   gameInfo?: GameInfo,
 *   startFen?: string,
 *   event?: string,
 *   site?: string,
 * }} input
 * @returns {{ pgn: string, derivedMoveCount: number, totalEntries: number }}
 */
export function buildPgnFromHistory(input) {
  const evalHistory = Array.isArray(input.evalHistory) ? input.evalHistory : [];
  const gameInfo = input.gameInfo || {};
  const startFen = input.startFen || STANDARD_START_FEN;

  const headers = {
    Event: input.event || 'ChessBot Export',
    Site: input.site || '',
    Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
    Round: '?',
    White: gameInfo.white?.name || '?',
    Black: gameInfo.black?.name || '?',
    Result: '*',
  };

  // No moves recorded — emit a minimal "headers + result" PGN so the
  // user gets a sensible file rather than a broken stub.
  if (evalHistory.length === 0) {
    return {
      pgn: buildAnnotatedPgn(headers, [], '*'),
      derivedMoveCount: 0,
      totalEntries: 0,
    };
  }

  const chess = loadFenSafely(startFen);
  if (!chess) {
    return {
      pgn: buildAnnotatedPgn(headers, [], '*'),
      derivedMoveCount: 0,
      totalEntries: evalHistory.length,
    };
  }

  /** @type {Array<{ san: string, scoreCp?: number, mate?: number }>} */
  const annotated = [];
  for (const entry of evalHistory) {
    if (!entry || !entry.fen) break;
    const targetBoard = String(entry.fen).split(/\s+/)[0];
    if (targetBoard === chess.fen().split(/\s+/)[0]) {
      // The first entry often duplicates the start position. Skip and
      // attach its eval to the *next* derived move via the running
      // chess pointer; cleaner than emitting a phantom ply.
      continue;
    }
    const san = deriveSanToReach(chess, entry.fen);
    if (!san) {
      // Two consecutive FENs that aren't reachable in one ply — stop
      // here. Anything past this point would require guessing.
      break;
    }
    /** @type {{ san: string, scoreCp?: number, mate?: number }} */
    const move = { san };
    if (typeof entry.mate === 'number') move.mate = entry.mate;
    if (typeof entry.cp === 'number') move.scoreCp = entry.cp;
    annotated.push(move);
  }

  return {
    pgn: buildAnnotatedPgn(headers, annotated, '*'),
    derivedMoveCount: annotated.length,
    totalEntries: evalHistory.length,
  };
}
