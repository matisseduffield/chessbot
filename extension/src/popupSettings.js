// @ts-check
/**
 * Popup settings — Zod schema, persistence, and migration.
 *
 * Plan §3 (P3.B): the popup persists `enabled` (boolean) and
 * `displayMode` (one of arrow/box/both) via chrome.storage.local. The
 * previous version trusted whatever it found in storage; if a buggy
 * older version, a different extension, or a hand-edited storage entry
 * wrote a string where we expected a boolean, the popup happily
 * propagated the bad value to the content script and the displayMode
 * radio rendered with no active button.
 *
 * This module turns that into a structured contract:
 *   - One Zod schema describes the persisted shape.
 *   - load() returns validated settings + reports which fields were
 *     repaired so the popup can heal storage on first run.
 *   - save() validates before writing so we never persist garbage.
 *   - subscribe() wraps chrome.storage.onChanged for cross-tab sync.
 *
 * Adding a new persisted setting is a one-place change: extend the
 * schema, the load() repair logic falls through automatically.
 */

import { z } from 'zod';

export const DISPLAY_MODES = /** @type {const} */ (['arrow', 'box', 'both']);

export const popupSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  displayMode: z.enum(DISPLAY_MODES).default('both'),
});

/** @typedef {z.infer<typeof popupSettingsSchema>} PopupSettings */

export const STORAGE_KEYS = /** @type {const} */ ({
  enabled: 'chessbot_popup_enabled',
  displayMode: 'chessbot_popup_displayMode',
});

/**
 * Default settings — also used as the fallback when chrome.storage
 * isn't available (e.g. in tests or when the extension isn't installed
 * but the popup is rendered standalone for development).
 * @type {PopupSettings}
 */
export const DEFAULT_SETTINGS = popupSettingsSchema.parse({});

/**
 * @typedef {{
 *   get(keys: string[], cb: (out: Record<string, unknown>) => void): void,
 *   set(items: Record<string, unknown>, cb?: () => void): void,
 *   onChanged?: { addListener(fn: (changes: any, area: string) => void): void, removeListener(fn: any): void },
 * }} StorageLike
 */

/**
 * Reads settings from a chrome.storage.local-shaped object, validates
 * them with the Zod schema, and returns:
 *   - `settings` — guaranteed to match the schema (defaults applied).
 *   - `repaired` — list of keys that were missing or invalid; the
 *     caller can decide whether to write the repaired values back.
 *
 * @param {StorageLike | null | undefined} storage
 * @returns {Promise<{ settings: PopupSettings, repaired: string[] }>}
 */
export function loadPopupSettings(storage) {
  return new Promise((resolve) => {
    if (!storage || typeof storage.get !== 'function') {
      resolve({ settings: { ...DEFAULT_SETTINGS }, repaired: [] });
      return;
    }
    storage.get(Object.values(STORAGE_KEYS), (raw) => {
      const candidate = {
        enabled: raw?.[STORAGE_KEYS.enabled],
        displayMode: raw?.[STORAGE_KEYS.displayMode],
      };
      const parsed = popupSettingsSchema.safeParse(candidate);
      if (parsed.success) {
        resolve({ settings: parsed.data, repaired: [] });
        return;
      }
      // Field-by-field repair: anything that fails its individual
      // schema falls back to the default. Track what we touched so
      // the popup can write the repaired value back.
      /** @type {string[]} */
      const repaired = [];
      /** @type {PopupSettings} */
      const settings = { ...DEFAULT_SETTINGS };
      const enabledOk = z.boolean().safeParse(candidate.enabled);
      if (enabledOk.success) settings.enabled = enabledOk.data;
      else if (candidate.enabled !== undefined) repaired.push('enabled');
      const modeOk = z.enum(DISPLAY_MODES).safeParse(candidate.displayMode);
      if (modeOk.success) settings.displayMode = modeOk.data;
      else if (candidate.displayMode !== undefined) repaired.push('displayMode');
      resolve({ settings, repaired });
    });
  });
}

/**
 * Validates `partial` against the schema (each provided field must be
 * valid; missing fields are left untouched in storage) and writes the
 * validated subset to chrome.storage.local. Returns `{ ok: true }` on
 * success or `{ ok: false, error }` if validation fails — caller can
 * surface the failure rather than silently writing bad state.
 *
 * @param {StorageLike | null | undefined} storage
 * @param {Partial<PopupSettings>} partial
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export function savePopupSettings(storage, partial) {
  return new Promise((resolve) => {
    /** @type {Record<string, unknown>} */
    const toWrite = {};
    if ('enabled' in partial) {
      const r = z.boolean().safeParse(partial.enabled);
      if (!r.success) {
        resolve({ ok: false, error: 'enabled must be a boolean' });
        return;
      }
      toWrite[STORAGE_KEYS.enabled] = r.data;
    }
    if ('displayMode' in partial) {
      const r = z.enum(DISPLAY_MODES).safeParse(partial.displayMode);
      if (!r.success) {
        resolve({
          ok: false,
          error: `displayMode must be one of ${DISPLAY_MODES.join(', ')}`,
        });
        return;
      }
      toWrite[STORAGE_KEYS.displayMode] = r.data;
    }
    if (Object.keys(toWrite).length === 0) {
      resolve({ ok: true });
      return;
    }
    if (!storage || typeof storage.set !== 'function') {
      // Best-effort: succeed silently when storage isn't available.
      resolve({ ok: true });
      return;
    }
    storage.set(toWrite, () => resolve({ ok: true }));
  });
}

/**
 * Subscribe to cross-tab settings changes via chrome.storage.onChanged.
 * The callback receives the new validated settings — invalid changes
 * are dropped to keep the popup state consistent.
 *
 * Returns a disposer that unhooks the listener.
 *
 * @param {StorageLike | null | undefined} storage
 * @param {(next: Partial<PopupSettings>) => void} fn
 * @returns {() => void}
 */
export function subscribePopupSettings(storage, fn) {
  if (!storage || !storage.onChanged) return () => {};
  /** @param {any} changes */
  const listener = (changes, area) => {
    if (area && area !== 'local') return;
    /** @type {Partial<PopupSettings>} */
    const out = {};
    if (STORAGE_KEYS.enabled in changes) {
      const r = z.boolean().safeParse(changes[STORAGE_KEYS.enabled].newValue);
      if (r.success) out.enabled = r.data;
    }
    if (STORAGE_KEYS.displayMode in changes) {
      const r = z.enum(DISPLAY_MODES).safeParse(changes[STORAGE_KEYS.displayMode].newValue);
      if (r.success) out.displayMode = r.data;
    }
    if (Object.keys(out).length > 0) fn(out);
  };
  storage.onChanged.addListener(listener);
  return () => storage.onChanged?.removeListener(listener);
}
