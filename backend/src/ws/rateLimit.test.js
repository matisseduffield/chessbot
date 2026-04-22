import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require2 = createRequire(import.meta.url);
const { createRateLimiter } = require2('./rateLimit.js');

describe('createRateLimiter', () => {
  it('allows messages up to max then rejects', () => {
    const rl = createRateLimiter({
      max: 3,
      windowMs: 1000,
      setIntervalImpl: () => null,
      clearIntervalImpl: () => {},
    });
    expect(rl.hit().ok).toBe(true);
    expect(rl.hit().ok).toBe(true);
    expect(rl.hit().ok).toBe(true);
    expect(rl.hit()).toEqual({ ok: false, firstHit: true });
    expect(rl.hit()).toEqual({ ok: false, firstHit: false });
  });

  it('resets on window tick', () => {
    let tickFn = null;
    const rl = createRateLimiter({
      max: 1,
      setIntervalImpl: (fn) => {
        tickFn = fn;
        return { unref: () => {} };
      },
      clearIntervalImpl: () => {},
    });
    expect(rl.hit().ok).toBe(true);
    expect(rl.hit().ok).toBe(false);
    tickFn();
    expect(rl.hit().ok).toBe(true);
  });

  it('stop() clears its interval', () => {
    const handle = { id: 'h', unref: () => {} };
    const clearSpy = vi.fn();
    const rl = createRateLimiter({ setIntervalImpl: () => handle, clearIntervalImpl: clearSpy });
    rl.stop();
    expect(clearSpy).toHaveBeenCalledWith(handle);
  });
});
