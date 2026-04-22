import { describe, it, expect } from 'vitest';
import { assignPlayersByOrientation } from './gameInfo.js';

describe('assignPlayersByOrientation', () => {
  it('non-flipped board: bottom = white, top = black', () => {
    const out = assignPlayersByOrientation({
      topName: 'Opponent',
      bottomName: 'Me',
      topClock: '0:59',
      bottomClock: '1:00',
      flipped: false,
    });
    expect(out).toEqual({
      white: { name: 'Me', clock: '1:00' },
      black: { name: 'Opponent', clock: '0:59' },
      flipped: false,
    });
  });

  it('flipped board: bottom = black, top = white', () => {
    const out = assignPlayersByOrientation({
      topName: 'Opp',
      bottomName: 'Me',
      topClock: '3:00',
      bottomClock: '2:59',
      flipped: true,
    });
    expect(out).toEqual({
      white: { name: 'Opp', clock: '3:00' },
      black: { name: 'Me', clock: '2:59' },
      flipped: true,
    });
  });

  it('coerces missing strings to empty', () => {
    const out = assignPlayersByOrientation({
      topName: '',
      bottomName: '',
      topClock: undefined,
      bottomClock: null,
      flipped: false,
    });
    expect(out.white).toEqual({ name: '', clock: '' });
    expect(out.black).toEqual({ name: '', clock: '' });
  });
});
