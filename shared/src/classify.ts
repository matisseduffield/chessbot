/**
 * Move quality classifier — flags inaccuracies, mistakes, blunders.
 *
 * Given the engine's evaluation of the position before a move and
 * after the move was played, from the mover's point of view, we tag
 * the move:
 *
 *   delta ∈ [50, 100)   → inaccuracy (?!)
 *   delta ∈ [100, 200)  → mistake    (?)
 *   delta ≥ 200         → blunder    (??)
 *
 * Delta is "how much worse did the mover make their own position", so
 * we subtract from the mover's perspective. Scores are in centipawns
 * from White's perspective. Plan §8.2.
 */

export type MoveTag = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export interface ClassifyInput {
  /** Score (in cp, from White's perspective) before the move. */
  prevScoreCp: number;
  /** Score (in cp, from White's perspective) after the move. */
  newScoreCp: number;
  /** Which side played the move. */
  playerColor: 'w' | 'b';
}

export interface ClassifyResult {
  tag: MoveTag;
  /** How many cp worse the position got for the mover. Never negative. */
  deltaCp: number;
}

const INACCURACY_THRESHOLD = 50;
const MISTAKE_THRESHOLD = 100;
const BLUNDER_THRESHOLD = 200;
const GOOD_THRESHOLD = 10;

function clampMateToCp(cp: number): number {
  if (cp > 10_000) return 10_000;
  if (cp < -10_000) return -10_000;
  return cp;
}

export function classifyMove(input: ClassifyInput): ClassifyResult {
  const prev = clampMateToCp(input.prevScoreCp);
  const next = clampMateToCp(input.newScoreCp);
  const sign = input.playerColor === 'w' ? 1 : -1;
  const moverBefore = sign * prev;
  const moverAfter = sign * next;
  const deltaCp = Math.max(0, moverBefore - moverAfter);

  let tag: MoveTag;
  if (deltaCp >= BLUNDER_THRESHOLD) tag = 'blunder';
  else if (deltaCp >= MISTAKE_THRESHOLD) tag = 'mistake';
  else if (deltaCp >= INACCURACY_THRESHOLD) tag = 'inaccuracy';
  else if (deltaCp <= GOOD_THRESHOLD) tag = 'best';
  else tag = 'good';

  return { tag, deltaCp };
}

export const MOVE_TAG_SYMBOLS: Record<MoveTag, string> = {
  best: '!',
  good: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};
