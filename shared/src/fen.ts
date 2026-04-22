/**
 * Pure FEN (Forsyth-Edwards Notation) helpers shared by backend and
 * extension. No I/O, no external dependencies, fully unit-tested.
 *
 * Scope: syntactic operations on the FEN string. Does NOT validate
 * legality (for that, use chess.js). Handles mainstream variants
 * conservatively — e.g. crazyhouse's `[...]` pocket appended to the
 * board part is stripped where appropriate, and 3check's `N+N`
 * counter is injected when missing.
 */

export interface FenParts {
  board: string;
  turn: 'w' | 'b';
  castling: string;
  enPassant: string;
  halfmove: number;
  fullmove: number;
  /** True when the board part contained a `[...]` crazyhouse pocket. */
  hasPocket: boolean;
}

export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Strip a crazyhouse-style `[...]` pocket from the board part of a FEN. */
export function stripCrazyhousePocket(boardPart: string): string {
  return boardPart.replace(/\[.*?\]/, '');
}

/** Return just the piece-placement field (8 ranks). */
export function getBoardPart(fen: string): string {
  if (typeof fen !== 'string') return '';
  return fen.split(' ')[0] || '';
}

/**
 * Return the side to move. Falls back to `'w'` for malformed input so
 * callers never have to guard against `undefined`.
 */
export function getTurn(fen: string): 'w' | 'b' {
  if (typeof fen !== 'string') return 'w';
  const t = fen.split(' ')[1];
  return t === 'b' ? 'b' : 'w';
}

/**
 * Return the EPD (first 4 fields: board, turn, castling, en-passant).
 * Used as a stable opening-book / transposition key.
 */
export function toEpd(fen: string): string {
  if (typeof fen !== 'string') return '';
  return fen.split(' ').slice(0, 4).join(' ');
}

/** Parse a FEN into its fields. Returns null if fundamentally malformed. */
export function parseFen(fen: string): FenParts | null {
  if (typeof fen !== 'string') return null;
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const rawBoard = parts[0];
  const hasPocket = /\[.*?\]/.test(rawBoard);
  const board = stripCrazyhousePocket(rawBoard);
  const turn = parts[1] === 'b' ? 'b' : 'w';
  const castling = parts[2] ?? '-';
  const enPassant = parts[3] ?? '-';
  const halfmove = Number.parseInt(parts[4] ?? '0', 10) || 0;
  const fullmove = Number.parseInt(parts[5] ?? '1', 10) || 1;
  return { board, turn, castling, enPassant, halfmove, fullmove, hasPocket };
}

/**
 * Lightweight FEN validation. Checks:
 * - at least a board + turn field
 * - board has 1..16 ranks after stripping a crazyhouse pocket
 *
 * Does NOT enforce legal piece counts, legal en-passant, or that ranks
 * sum to 8 files — that is the engine/chess.js responsibility.
 */
export function validateFen(fen: string): { valid: true } | { valid: false; reason: string } {
  if (typeof fen !== 'string' || !fen.trim()) {
    return { valid: false, reason: 'empty' };
  }
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 2) return { valid: false, reason: 'missing turn field' };
  const board = stripCrazyhousePocket(parts[0]);
  const rankCount = board.split('/').length;
  if (rankCount < 1 || rankCount > 16) {
    return { valid: false, reason: `unexpected rank count: ${rankCount}` };
  }
  if (parts[1] !== 'w' && parts[1] !== 'b') {
    return { valid: false, reason: `invalid turn: ${parts[1]}` };
  }
  return { valid: true };
}

/**
 * For 3-check, fairy-stockfish expects a check-counter field between
 * en-passant and halfmove. If a standard 6-field FEN is passed, inject
 * the default `3+3` counter so the engine doesn't misread halfmove as
 * the counter. Returns the FEN unchanged if it already has a counter.
 */
export function injectThreeCheckCounters(fen: string, defaultCounter = '3+3'): string {
  if (typeof fen !== 'string') return fen;
  const parts = fen.trim().split(/\s+/);
  if (parts.length !== 6) return fen;
  // Heuristic: if field 4 looks like `N+N`, counter already present.
  if (/^\d+\+\d+$/.test(parts[4])) return fen;
  parts.splice(4, 0, defaultCounter);
  return parts.join(' ');
}

/** True when the FEN represents the standard chess starting position. */
export function isStandardStart(fen: string): boolean {
  if (typeof fen !== 'string') return false;
  return toEpd(fen) === toEpd(STARTING_FEN);
}
