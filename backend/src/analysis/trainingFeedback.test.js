import { it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const { trainingFeedback } = createRequire(import.meta.url)('./trainingFeedback');
const attempt = {
  before: 'board w - - 0 1',
  after: 'board b - - 0 1',
  player: 'w',
  variant: 'chess',
};
it('compares scores from the player perspective rather than alternating turn scores', async () => {
  const engine = {
    evaluate: vi
      .fn()
      .mockResolvedValueOnce({ lines: [{ score: 100, depth: 12, pv: ['e2e4'] }] })
      .mockResolvedValueOnce({ lines: [{ score: -40, depth: 11 }] }),
  };
  const result = await trainingFeedback(engine, attempt, () => false);
  expect(result.lossCp).toBe(60);
  expect(result.beforeDepth).toBe(12);
});
it('does not turn mate into centipawn loss', async () => {
  const engine = { evaluate: vi.fn().mockResolvedValue({ lines: [{ mate: 2, depth: 15 }] }) };
  const result = await trainingFeedback(engine, attempt, () => false);
  expect(result.mateTransition).toBe(true);
  expect(result.lossCp).toBeUndefined();
});
it('does not continue after live analysis preempts feedback', async () => {
  let cancelled = false;
  const engine = {
    evaluate: vi.fn().mockImplementation(async () => {
      cancelled = true;
      return { lines: [] };
    }),
  };
  expect((await trainingFeedback(engine, attempt, () => cancelled)).status).toBe('unavailable');
  expect(engine.evaluate).toHaveBeenCalledTimes(1);
});
