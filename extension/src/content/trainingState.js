import { Chess } from 'chess.js';

export function searchDepth(value, fallback = 15) {
  const n = Number(value);
  return value != null && Number.isInteger(n) && n >= 0 && n <= 50 ? n : fallback;
}

// Require one legal transition. Takebacks, opponent replies and animation
// fragments must never count as mistakes. Unsupported rules remain ungraded.
export function assessAttempt({
  before,
  after,
  player,
  variant = 'chess',
  bestmove,
  lines = [],
  strict = false,
}) {
  if (!before || !after || before.split(' ')[1] !== player || after.split(' ')[1] === player)
    return null;
  if (variant !== 'chess') return { playedMove: null, correct: null };
  try {
    const game = new Chess(before);
    const target = after.split(' ')[0];
    let playedMove = null;
    for (const move of game.moves({ verbose: true })) {
      game.move(move);
      const matches = game.fen().split(' ')[0] === target;
      game.undo();
      if (matches) {
        playedMove = move.from + move.to + (move.promotion || '');
        break;
      }
    }
    if (!playedMove) return null;
    const accepted = new Set([bestmove]);
    if (!strict) lines.slice(0, 3).forEach((line) => accepted.add(line.pv?.[0] || line.move));
    return { playedMove, correct: accepted.has(playedMove) };
  } catch {
    return null;
  }
}

export function createTrainingTimers() {
  const timers = new Set();
  let generation = 0;
  return {
    schedule(fn, ms) {
      const g = generation;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (g === generation) fn();
      }, ms);
      timers.add(timer);
    },
    cancel() {
      generation++;
      timers.forEach(clearTimeout);
      timers.clear();
    },
  };
}
