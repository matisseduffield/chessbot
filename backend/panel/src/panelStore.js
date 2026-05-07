// @ts-check
/**
 * Panel-side persistence + error-boundary helpers.
 *
 * Plan §3 (P3): the dashboard's `index.html` reads and writes
 * localStorage in 14+ places, all with the same hand-rolled
 * try/catch (or worse, no try/catch at all). A single corrupt JSON
 * entry would currently throw `SyntaxError` mid-render and break
 * whatever card was unlucky enough to dereference it.
 *
 * This module gives the panel one place to:
 *   - Read JSON safely with a typed fallback (`getJSON`).
 *   - Write JSON without leaking quota / disabled-storage errors
 *     (`setJSON`).
 *   - Wrap a card-render function in a try/catch shell so one
 *     card's exception doesn't poison the whole dashboard
 *     (`withCard`).
 *
 * Pure of DOM and test-friendly: helpers accept an optional
 * `storage` argument (defaulting to `globalThis.localStorage`) so
 * jsdom tests can drive them with a fake.
 */

/**
 * @typedef {{
 *   getItem(key: string): string | null,
 *   setItem(key: string, value: string): void,
 *   removeItem?(key: string): void,
 * }} StorageLike
 */

/**
 * Resolve the storage to use. Falls back to a no-op when
 * `localStorage` is unavailable (e.g. some embedded browsers, or
 * during SSR / tests).
 *
 * @param {StorageLike | null | undefined} explicit
 * @returns {StorageLike}
 */
function resolveStorage(explicit) {
  if (explicit) return explicit;
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
    return /** @type {StorageLike} */ (globalThis.localStorage);
  }
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

/**
 * Read a JSON-encoded value from localStorage, returning `fallback`
 * for any of: missing key, corrupt JSON, storage threw on read.
 *
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @param {StorageLike} [storage]
 * @returns {T}
 */
export function getJSON(key, fallback, storage) {
  const s = resolveStorage(storage);
  let raw;
  try {
    raw = s.getItem(key);
  } catch {
    return fallback;
  }
  if (raw === null || raw === undefined) return fallback;
  try {
    return /** @type {T} */ (JSON.parse(raw));
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON-encoded value. Swallows storage errors (full quota,
 * private-browsing where setItem throws, etc.) — callers shouldn't
 * have to wrap every persistence call in try/catch.
 *
 * Returns `true` on success so callers can decide whether to surface
 * a "couldn't save your settings" hint when they care.
 *
 * @param {string} key
 * @param {unknown} value
 * @param {StorageLike} [storage]
 * @returns {boolean}
 */
export function setJSON(key, value, storage) {
  const s = resolveStorage(storage);
  try {
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Raw string-level helpers — used for the few localStorage entries
 * that store a non-JSON primitive (e.g. a hex colour string, a
 * decimal width). Same error-swallowing contract as the JSON
 * variants.
 *
 * @param {string} key
 * @param {string} fallback
 * @param {StorageLike} [storage]
 */
export function getRaw(key, fallback, storage) {
  const s = resolveStorage(storage);
  try {
    const v = s.getItem(key);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * @param {string} key
 * @param {string} value
 * @param {StorageLike} [storage]
 * @returns {boolean}
 */
export function setRaw(key, value, storage) {
  const s = resolveStorage(storage);
  try {
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a card-render function inside an error boundary. If it
 * throws, log the error with the card's name and return
 * `fallback` (default `undefined`). Other cards keep rendering.
 *
 * Use sparingly — always-throwing renders should be fixed, not
 * silenced. The boundary is a defence against unexpected null
 * derefs in malformed engine messages, not a substitute for
 * input validation.
 *
 * @template T
 * @param {string} name
 * @param {() => T} fn
 * @param {{ fallback?: T, log?: (err: unknown, name: string) => void }} [opts]
 * @returns {T | undefined}
 */
export function withCard(name, fn, opts = {}) {
  const log =
    opts.log ||
    ((err, n) => {
      console.error(`[panel] card "${n}" render failed:`, err);
    });
  try {
    return fn();
  } catch (err) {
    log(err, name);
    return opts.fallback;
  }
}
