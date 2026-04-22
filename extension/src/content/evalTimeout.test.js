import { describe, it, expect } from 'vitest';
import { getEvalTimeout } from './evalTimeout.js';

describe('getEvalTimeout', () => {
  it('uses 25s base for depth <= 15', () => {
    expect(getEvalTimeout(10, null)).toBe(25000);
    expect(getEvalTimeout(15, null)).toBe(25000);
    expect(getEvalTimeout(1, null)).toBe(25000);
  });

  it('adds 3s per depth above 15', () => {
    expect(getEvalTimeout(16, null)).toBe(28000);
    expect(getEvalTimeout(20, null)).toBe(40000);
    expect(getEvalTimeout(25, null)).toBe(55000);
  });

  it('caps at 180s', () => {
    expect(getEvalTimeout(100, null)).toBe(180000);
    expect(getEvalTimeout(67, null)).toBe(180000);
  });

  it('depth 0 with no movetime means Infinity', () => {
    expect(getEvalTimeout(0, null)).toBe(Infinity);
    expect(getEvalTimeout(0, undefined)).toBe(Infinity);
    expect(getEvalTimeout(0, 0)).toBe(Infinity);
  });

  it('depth 0 with movetime returns movetime + 15s buffer', () => {
    expect(getEvalTimeout(0, 1500)).toBe(16500);
    expect(getEvalTimeout(0, 30000)).toBe(45000);
  });

  it('large depth with movetime ignores movetime (depth controls budget)', () => {
    // movetime only changes behaviour in the depth=0 branch
    expect(getEvalTimeout(20, 500)).toBe(40000);
  });
});
