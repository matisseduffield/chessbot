import { describe, it, expect } from 'vitest';
import { turnFromRunningClock } from './turnDetect.js';

describe('turnFromRunningClock', () => {
  it("bottom clock, not flipped → white's turn", () => {
    expect(turnFromRunningClock(true, false)).toBe('w');
  });
  it("top clock, not flipped → black's turn", () => {
    expect(turnFromRunningClock(false, false)).toBe('b');
  });
  it("bottom clock, flipped → black's turn", () => {
    expect(turnFromRunningClock(true, true)).toBe('b');
  });
  it("top clock, flipped → white's turn", () => {
    expect(turnFromRunningClock(false, true)).toBe('w');
  });
});
