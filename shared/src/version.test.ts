import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, isProtocolMismatch } from './version';

describe('PROTOCOL_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('isProtocolMismatch', () => {
  it('returns false for matching versions', () => {
    expect(isProtocolMismatch(1, 1)).toBe(false);
  });

  it('returns true for differing numeric versions', () => {
    expect(isProtocolMismatch(1, 2)).toBe(true);
    expect(isProtocolMismatch(2, 1)).toBe(true);
  });

  it('returns false for non-numeric server values (no signal)', () => {
    expect(isProtocolMismatch(1, undefined)).toBe(false);
    expect(isProtocolMismatch(1, null)).toBe(false);
    expect(isProtocolMismatch(1, '1')).toBe(false);
    expect(isProtocolMismatch(1, '2')).toBe(false);
  });

  it('returns false for non-finite numeric values', () => {
    expect(isProtocolMismatch(1, NaN)).toBe(false);
    expect(isProtocolMismatch(1, Infinity)).toBe(false);
    expect(isProtocolMismatch(1, -Infinity)).toBe(false);
  });
});
