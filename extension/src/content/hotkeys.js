// @ts-check
/**
 * Keyboard shortcuts for the in-page overlay.
 *
 * Plan §3 (P3.C): the dashboard already exposes Depth and Multi-PV
 * sliders, but a power user analysing a position on chess.com / lichess
 * doesn't want to alt-tab to the dashboard to bump depth. Plain
 * letter-keys give a one-tap "go deeper" / "show more lines" experience
 * without leaving the page.
 *
 *   d   — cycle search depth (10 → 15 → 20 → 25 → 0/infinite → 10)
 *   m   — cycle Multi-PV (1 → 3 → 5 → 1)
 *
 * Plain letters fire only when the user is NOT typing in a text field
 * — chess sites have search, chat, and PGN inputs we mustn't intercept.
 *
 * The cycle helpers are pure so they can be unit-tested without a
 * keyboard event or a WS round-trip; the page-level wiring is in
 * content.js.
 */

export const DEPTH_CYCLE = /** @type {const} */ ([10, 15, 20, 25, 0]);
export const MULTIPV_CYCLE = /** @type {const} */ ([1, 3, 5]);

/**
 * Pick the next entry in `cycle` after `current`. If `current` isn't in
 * the cycle (e.g. the user set a custom value via the dashboard), snap
 * to the closest cycle entry — the shortcut should be predictable, not
 * surprising.
 *
 * @template {number} T
 * @param {readonly T[]} cycle
 * @param {number} current
 * @returns {T}
 */
export function nextInCycle(cycle, current) {
  const idx = cycle.indexOf(/** @type {T} */ (current));
  if (idx >= 0) return cycle[(idx + 1) % cycle.length];
  // Snap to the closest cycle entry. Falls through to the first
  // entry when the cycle is empty (defensive — never happens with
  // the constants above).
  let bestIdx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < cycle.length; i++) {
    const delta = Math.abs(cycle[i] - current);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  }
  return cycle[bestIdx];
}

/** @param {number} depth */
export function nextDepth(depth) {
  return nextInCycle(DEPTH_CYCLE, depth);
}

/** @param {number} multiPV */
export function nextMultiPV(multiPV) {
  return nextInCycle(MULTIPV_CYCLE, multiPV);
}

/**
 * True when the keyboard event originated outside an input/textarea/
 * contenteditable field. Plain-letter shortcuts must respect this so
 * we don't intercept the user typing "d" in chat.
 *
 * Modifier keys (Ctrl, Meta, Alt) also disable the shortcut so we
 * don't fight Alt+D (Chrome's address bar focus) or Cmd+D (bookmark).
 *
 * @param {KeyboardEvent} ev
 * @returns {boolean}
 */
export function isPlainKeystrokeOk(ev) {
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return false;
  const target = /** @type {Element | null} */ (ev.target);
  if (!target) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  // Check both the IDL `isContentEditable` (real browsers) and the
  // attribute (jsdom doesn't reflect the attribute into the IDL prop).
  const html = /** @type {HTMLElement} */ (target);
  if (html.isContentEditable === true) return false;
  const attr = target.getAttribute && target.getAttribute('contenteditable');
  if (attr === '' || attr === 'true' || attr === 'plaintext-only') return false;
  return true;
}

/**
 * Format a depth value the way the toast displays it. Treats `0` as
 * "infinite analysis" because the dashboard / panel use `0` as the
 * sentinel for unbounded search.
 *
 * @param {number} depth
 * @returns {string}
 */
export function formatDepthForToast(depth) {
  return depth === 0 ? 'depth ∞' : `depth ${depth}`;
}

/**
 * @param {number} multiPV
 * @returns {string}
 */
export function formatMultiPVForToast(multiPV) {
  return `Multi-PV ${multiPV}`;
}
