import { describe, it, expect } from 'vitest';
import {
  evalCpToY,
  computeEvalGraphPoints,
  computeEvalBar,
  computeWdlPcts,
  formatNodesMetric,
  formatTimeMetric,
  formatNpsMetric,
  pvScoreColor,
  speakablize,
} from './panelRender.js';

describe('evalCpToY', () => {
  const midY = 50;
  it('0cp → midY', () => {
    expect(evalCpToY(0, false, midY)).toBe(50);
  });
  it('+800 (clamped) → 0 (top)', () => {
    expect(evalCpToY(800, false, midY)).toBe(0);
  });
  it('-800 → 2*midY (bottom)', () => {
    expect(evalCpToY(-800, false, midY)).toBe(100);
  });
  it('flipped negates sign', () => {
    expect(evalCpToY(800, true, midY)).toBe(evalCpToY(-800, false, midY));
  });
  it('clamps beyond range', () => {
    expect(evalCpToY(5000, false, midY)).toBe(0);
    expect(evalCpToY(-5000, false, midY)).toBe(100);
  });
});

describe('computeEvalGraphPoints', () => {
  it('empty history → empty points', () => {
    const r = computeEvalGraphPoints([], false, 200, 100);
    expect(r.points).toEqual([]);
    expect(r.midY).toBe(50);
  });
  it('single point → two points spanning width (flat line)', () => {
    const r = computeEvalGraphPoints([{ cp: 0 }], false, 200, 100);
    expect(r.points.length).toBe(2);
    expect(r.points[0].x).toBe(0);
    expect(r.points[1].x).toBe(200);
    expect(r.points[0].y).toBe(r.points[1].y);
  });
  it('spaces N points evenly across width', () => {
    const hist = [{ cp: 0 }, { cp: 100 }, { cp: 200 }];
    const r = computeEvalGraphPoints(hist, false, 200, 100);
    expect(r.points.length).toBe(3);
    expect(r.points[0].x).toBe(0);
    expect(r.points[1].x).toBe(100);
    expect(r.points[2].x).toBe(200);
  });
  it('lastAdjCp follows flipped flag', () => {
    const hist = [{ cp: 300 }, { cp: 500 }];
    expect(computeEvalGraphPoints(hist, false, 100, 50).lastAdjCp).toBe(500);
    expect(computeEvalGraphPoints(hist, true, 100, 50).lastAdjCp).toBe(-500);
  });
});

describe('computeEvalBar', () => {
  it('handles missing line', () => {
    expect(computeEvalBar(null, 'w', false)).toEqual({
      whitePct: 50,
      userScore: {},
    });
  });
  it('mate > 0 (positive for white) → 95%', () => {
    const r = computeEvalBar({ mate: 3 }, 'w', false);
    expect(r.whitePct).toBe(95);
  });
  it('mate < 0 → 5%', () => {
    const r = computeEvalBar({ mate: -3 }, 'w', false);
    expect(r.whitePct).toBe(5);
  });
  it('score converts side-to-move → white perspective', () => {
    // Black to move with +100 cp (black is winning) → white has −100 cp → 40%
    const r = computeEvalBar({ score: 100 }, 'b', false);
    expect(r.whitePct).toBeCloseTo(40);
  });
  it('clamps whitePct to [5, 95]', () => {
    expect(computeEvalBar({ score: 999999 }, 'w', false).whitePct).toBe(95);
    expect(computeEvalBar({ score: -999999 }, 'w', false).whitePct).toBe(5);
  });
  it('flipped: userScore is negated relative to white', () => {
    const r = computeEvalBar({ score: 100 }, 'w', true);
    expect(r.userScore.score).toBe(-100);
  });
  it('flipped + black to move: double flip cancels', () => {
    // black to move, score 100 = black good = white -100; flipped user=black
    // → userScore should be +100 (good for user who is black)
    const r = computeEvalBar({ score: 100 }, 'b', true);
    expect(r.userScore.score).toBe(100);
  });
});

describe('computeWdlPcts', () => {
  it('null wdl returns null', () => {
    expect(computeWdlPcts(null, 'w', false)).toBeNull();
  });
  it('zero total returns null', () => {
    expect(computeWdlPcts({ win: 0, draw: 0, loss: 0 }, 'w', false)).toBeNull();
  });
  it('white to move, not flipped: win=win loss=loss', () => {
    const r = computeWdlPcts({ win: 500, draw: 300, loss: 200 }, 'w', false);
    expect(r.w).toBe(500);
    expect(r.l).toBe(200);
    expect(r.wPct).toBe(50);
  });
  it('black to move: win and loss swap for white-perspective', () => {
    // wdl is from side-to-move (black); from user (unflipped white) side,
    // black's win = white's loss.
    const r = computeWdlPcts({ win: 500, draw: 300, loss: 200 }, 'b', false);
    expect(r.w).toBe(200);
    expect(r.l).toBe(500);
  });
  it('flipped (user=black) re-swaps', () => {
    const r = computeWdlPcts({ win: 500, draw: 300, loss: 200 }, 'w', true);
    expect(r.w).toBe(200);
    expect(r.l).toBe(500);
  });
});

describe('formatNodesMetric', () => {
  it('millions', () => {
    expect(formatNodesMetric(1_200_000)).toBe('1.2M nodes');
  });
  it('thousands', () => {
    expect(formatNodesMetric(12_400)).toBe('12K nodes');
  });
  it('small', () => {
    expect(formatNodesMetric(500)).toBe('500 nodes');
  });
  it('0 / falsy', () => {
    expect(formatNodesMetric(0)).toBe('0 nodes');
    expect(formatNodesMetric(null)).toBe('');
    expect(formatNodesMetric(undefined)).toBe('');
  });
});

describe('formatTimeMetric', () => {
  it('seconds', () => {
    expect(formatTimeMetric(1234)).toBe('1.2s');
  });
  it('ms', () => {
    expect(formatTimeMetric(500)).toBe('500ms');
  });
  it('empty for null', () => {
    expect(formatTimeMetric(null)).toBe('');
  });
});

describe('formatNpsMetric', () => {
  it('millions', () => {
    expect(formatNpsMetric(2_500_000)).toBe('2.5M nps');
  });
  it('thousands', () => {
    expect(formatNpsMetric(50_000)).toBe('50K nps');
  });
  it('empty for null', () => {
    expect(formatNpsMetric(null)).toBe('');
  });
});

describe('pvScoreColor', () => {
  it('positive score → green', () => {
    expect(pvScoreColor({ score: 50 })).toBe('var(--green)');
  });
  it('negative score → red', () => {
    expect(pvScoreColor({ score: -50 })).toBe('var(--red)');
  });
  it('positive mate → green', () => {
    expect(pvScoreColor({ mate: 3 })).toBe('var(--green)');
  });
  it('negative mate → red', () => {
    expect(pvScoreColor({ mate: -3 })).toBe('var(--red)');
  });
  it('no score info → green (default optimistic)', () => {
    expect(pvScoreColor({})).toBe('var(--green)');
  });
});

describe('speakablize', () => {
  it('replaces + with check', () => {
    expect(speakablize('Qh7+')).toBe('Qh7 check');
  });
  it('replaces # with checkmate', () => {
    expect(speakablize('Qh7#')).toBe('Qh7 checkmate');
  });
  it('short castles', () => {
    expect(speakablize('O-O')).toBe('king side castle');
  });
  it('long castles', () => {
    expect(speakablize('O-O-O')).toBe('queen side castle');
  });
  it('leaves regular moves alone', () => {
    expect(speakablize('Nf3')).toBe('Nf3');
  });
  it('empty / nullish safe', () => {
    expect(speakablize('')).toBe('');
    expect(speakablize(null)).toBe('');
    expect(speakablize(undefined)).toBe('');
  });
});
