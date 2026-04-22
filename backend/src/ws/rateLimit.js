'use strict';
// @ts-check

/**
 * Per-connection fixed-window rate limiter (improvement-plan §11).
 *
 * @param {{
 *   max?: number,
 *   windowMs?: number,
 *   setIntervalImpl?: typeof setInterval,
 *   clearIntervalImpl?: typeof clearInterval,
 * }} [opts]
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
  if (timer && typeof /** @type {any} */ (timer).unref === 'function') {
    /** @type {any} */ (timer).unref();
  }

  return {
    /** @returns {{ ok: true } | { ok: false, firstHit: boolean }} */
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
