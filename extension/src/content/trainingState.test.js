import { describe, it, expect, vi } from 'vitest';
import { Chess } from 'chess.js';
import { assessAttempt, searchDepth, createTrainingTimers } from './trainingState.js';
describe('training transitions', () => {
  const game = new Chess();
  const before = game.fen();
  game.move('e4');
  const after = game.fen();
  const input = {
    before,
    after,
    player: 'w',
    bestmove: 'd2d4',
    lines: [{ move: 'd2d4' }, { pv: ['e2e4'] }],
  };
  it('retains infinite depth and rejects invalid depths', () => {
    expect(searchDepth(0)).toBe(0);
    expect(searchDepth('garbage')).toBe(15);
  });
  it('accepts alternatives only in non-strict training', () => {
    expect(assessAttempt(input)).toEqual({ playedMove: 'e2e4', correct: true });
    expect(assessAttempt({ ...input, strict: true }).correct).toBe(false);
  });
  it('does not score opponent moves, takebacks or animation fragments', () => {
    expect(assessAttempt({ ...input, player: 'b' })).toBeNull();
    expect(assessAttempt({ ...input, before: after, after: before })).toBeNull();
    expect(assessAttempt({ ...input, after: before })).toBeNull();
  });
  it('does not apply orthodox rules to variant feedback', () => {
    expect(assessAttempt({ ...input, variant: 'atomic' }).correct).toBeNull();
  });
  it('cancels nested reveals after a board change', () => {
    vi.useFakeTimers();
    const timers = createTrainingTimers();
    const fn = vi.fn();
    timers.schedule(() => timers.schedule(fn, 2500), 600);
    vi.advanceTimersByTime(600);
    timers.cancel();
    vi.runAllTimers();
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
