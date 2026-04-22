/**
 * Selector registry / fallback chain (plan §6.1).
 *
 * Chess.com and Lichess ship DOM changes frequently. Rather than
 * sprinkling `document.querySelector(a) || document.querySelector(b)`
 * chains through content.js, centralise the pattern so:
 *   1) each selector chain has a human-readable key for logging,
 *   2) when a primary selector misses, we log once per key (not per
 *      call) so breakage is visible but not spammy,
 *   3) the helper is pure-ish and unit-testable with a fake `find`.
 */

/**
 * @typedef {(selector: string) => (Element | null)} QueryFn
 */

/**
 * @typedef {(selector: string) => NodeListOf<Element> | Element[]} QueryAllFn
 */

const _warned = new Set();

function _warnOnce(key, msg) {
  if (_warned.has(key)) return;
  _warned.add(key);

  console.warn(`[chessbot] selector registry: ${key} — ${msg}`);
}

/**
 * Try each selector in order, return the first non-null hit.
 *
 * @param {string} key                 — stable name for logging (e.g. "chesscom.player.bottom")
 * @param {string[]} selectors          — primary first, fallbacks after
 * @param {QueryFn} [find]              — override for testing, default `document.querySelector`
 * @returns {Element | null}
 */
export function trySelectors(key, selectors, find) {
  const q = find || ((s) => document.querySelector(s));
  for (const sel of selectors) {
    const hit = q(sel);
    if (hit) return hit;
  }
  _warnOnce(key, `no match for [${selectors.join(', ')}]`);
  return null;
}

/**
 * Try each selector in order, return the first non-empty NodeList
 * (converted to a plain Array) — or `[]` if nothing matches.
 *
 * @param {string} key
 * @param {string[]} selectors
 * @param {QueryAllFn} [findAll]
 * @returns {Element[]}
 */
export function trySelectorsAll(key, selectors, findAll) {
  const q = findAll || ((s) => document.querySelectorAll(s));
  for (const sel of selectors) {
    const hits = q(sel);
    const arr = Array.from(hits || []);
    if (arr.length > 0) return arr;
  }
  _warnOnce(key, `no match for [${selectors.join(', ')}] (list)`);
  return [];
}

/**
 * Reset the warned-keys memo. Exposed for tests only.
 */
export function __resetWarnedForTests() {
  _warned.clear();
}
