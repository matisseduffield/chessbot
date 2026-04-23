import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeSafeMovetime } = require('./clockCap');

describe('computeSafeMovetime', () => {
  it('returns requested unchanged when no clock info', () => {
    const r = computeSafeMovetime(1500, null);
    expect(r.effectiveMs).toBe(1500);
    expect(r.capped).toBe(false);
  });

  it('caps request under 1/25 of remaining clock', () => {
    // remaining 60s → usable 58.5s → 1/25 = 2340ms
    const r = computeSafeMovetime(5000, 60_000);
    expect(r.capped).toBe(true);
    expect(r.effectiveMs).toBeLessThan(5000);
    expect(r.effectiveMs).toBeGreaterThanOrEqual(2000);
  });

  it('does not cap if request already under budget', () => {
    const r = computeSafeMovetime(500, 60_000);
    expect(r.capped).toBe(false);
    expect(r.effectiveMs).toBe(500);
  });

  it('respects floorMs when clock is tiny', () => {
    const r = computeSafeMovetime(5000, 200);
    expect(r.effectiveMs).toBeGreaterThanOrEqual(100);
  });

  it('derives budget when no request given', () => {
    const r = computeSafeMovetime(null, 30_000);
    expect(r.capped).toBe(true);
    expect(r.effectiveMs).toBeGreaterThan(500);
    expect(r.reason).toBe('no-request-used-clock');
  });

  it('factors increment into allowance', () => {
    const without = computeSafeMovetime(null, 30_000, { incrementMs: 0 });
    const withInc = computeSafeMovetime(null, 30_000, { incrementMs: 3000 });
    expect(withInc.effectiveMs).toBeGreaterThan(without.effectiveMs);
  });

  it('treats zero / negative remaining as no info', () => {
    expect(computeSafeMovetime(1000, 0).effectiveMs).toBe(1000);
    expect(computeSafeMovetime(1000, -5).effectiveMs).toBe(1000);
  });
});
