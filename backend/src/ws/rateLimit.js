'use strict';

/**
 * Per-connection fixed-window rate limiter (improvement-plan §11).
 */
function createRateLimiter({
  max = 300,
  windowMs = 10_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let count = 0;
  let warned = false;
  const timer = setIntervalImpl(() => {
    count = 0;
    warned = false;
  }, windowMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    hit() {
      count++;
      if (count <= max) return { ok: true };
      const firstHit = !warned;
      warned = true;
      return { ok: false, firstHit };
    },
    get count() {
      return count;
    },
    stop() {
      clearIntervalImpl(timer);
    },
  };
}

module.exports = { createRateLimiter };
