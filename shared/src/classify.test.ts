import { describe, it, expect } from 'vitest';
import { classifyMove, MOVE_TAG_SYMBOLS } from './classify';

describe('classifyMove', () => {
  it('tags a white blunder (+200 → -100 = 300 cp drop)', () => {
    const r = classifyMove({ prevScoreCp: 200, newScoreCp: -100, playerColor: 'w' });
    expect(r.tag).toBe('blunder');
    expect(r.deltaCp).toBe(300);
  });

  it('tags a black blunder (-300 → +100 = 400 cp drop for black)', () => {
    const r = classifyMove({ prevScoreCp: -300, newScoreCp: 100, playerColor: 'b' });
    expect(r.tag).toBe('blunder');
    expect(r.deltaCp).toBe(400);
  });

  it('tags a mistake at 150 cp drop', () => {
    const r = classifyMove({ prevScoreCp: 100, newScoreCp: -50, playerColor: 'w' });
    expect(r.tag).toBe('mistake');
    expect(r.deltaCp).toBe(150);
  });

  it('tags inaccuracy at 60 cp drop', () => {
    const r = classifyMove({ prevScoreCp: 100, newScoreCp: 40, playerColor: 'w' });
    expect(r.tag).toBe('inaccuracy');
    expect(r.deltaCp).toBe(60);
  });

  it('tags a small slip as "good"', () => {
    const r = classifyMove({ prevScoreCp: 50, newScoreCp: 20, playerColor: 'w' });
    expect(r.tag).toBe('good');
  });

  it('tags no-op / improvement as "best"', () => {
    const r = classifyMove({ prevScoreCp: 50, newScoreCp: 80, playerColor: 'w' });
    expect(r.tag).toBe('best');
    expect(r.deltaCp).toBe(0);
  });

  it('clamps mate scores so they do not explode the delta', () => {
    const r = classifyMove({ prevScoreCp: 100_000, newScoreCp: 0, playerColor: 'w' });
    expect(r.tag).toBe('blunder');
    expect(r.deltaCp).toBe(10_000);
  });

  it('has stable symbol mapping', () => {
    expect(MOVE_TAG_SYMBOLS.blunder).toBe('??');
    expect(MOVE_TAG_SYMBOLS.mistake).toBe('?');
    expect(MOVE_TAG_SYMBOLS.inaccuracy).toBe('?!');
    expect(MOVE_TAG_SYMBOLS.best).toBe('!');
    expect(MOVE_TAG_SYMBOLS.good).toBe('');
  });
});
