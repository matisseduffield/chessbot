/**
 * Timing utilities for the content script.
 *
 * These are tiny pure implementations to remove scattered inline
 * setTimeout/clearTimeout patterns in content.js. They intentionally
 * don't depend on DOM or chess-specific state.
 */

/**
 * Return a debounced version of `fn` that runs only after `waitMs` of
 * silence. A `.cancel()` method is attached so callers can cancel a
 * pending invocation (e.g. on unmount / disconnect).
 *
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} waitMs
 * @returns {F & { cancel: () => void }}
 */
export function debounce(fn, waitMs) {
  let timer = null;
  const debounced = /** @type {any} */ (
    (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, waitMs);
    }
  );
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

/**
 * Return a leading-edge throttled version of `fn` that fires at most
 * once per `waitMs`. Trailing invocations while throttled are coalesced
 * into a single final call after the window elapses, preserving the
 * last arguments. A `.cancel()` method clears any pending trailing call.
 *
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} waitMs
 * @returns {F & { cancel: () => void }}
 */
export function throttle(fn, waitMs) {
  let lastCallAt = 0;
  let trailingTimer = null;
  let lastArgs = null;

  const throttled = /** @type {any} */ (
    (...args) => {
      const now = Date.now();
      const remaining = waitMs - (now - lastCallAt);
      if (remaining <= 0) {
        if (trailingTimer) {
          clearTimeout(trailingTimer);
          trailingTimer = null;
        }
        lastCallAt = now;
        fn(...args);
      } else {
        lastArgs = args;
        if (!trailingTimer) {
          trailingTimer = setTimeout(() => {
            lastCallAt = Date.now();
            trailingTimer = null;
            const a = lastArgs;
            lastArgs = null;
            if (a) fn(...a);
          }, remaining);
        }
      }
    }
  );
  throttled.cancel = () => {
    if (trailingTimer) clearTimeout(trailingTimer);
    trailingTimer = null;
    lastArgs = null;
  };
  return throttled;
}

/**
 * Resolve after `ms` milliseconds. `await sleep(100)` is more readable
 * than `new Promise((r) => setTimeout(r, 100))` at call sites.
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
