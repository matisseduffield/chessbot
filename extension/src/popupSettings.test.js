import { describe, it, expect, vi } from 'vitest';
import {
  loadPopupSettings,
  savePopupSettings,
  subscribePopupSettings,
  popupSettingsSchema,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
} from './popupSettings.js';

/** Build a chrome.storage.local-shaped fake driven by an in-memory record. */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  /** @type {Set<(changes: any, area: string) => void>} */
  const listeners = new Set();
  return {
    data,
    get(keys, cb) {
      const out = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      cb(out);
    },
    set(items, cb) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: v };
        data[k] = v;
      }
      // Fire listeners async-ish to mimic chrome's event loop.
      queueMicrotask(() => {
        for (const fn of listeners) fn(changes, 'local');
      });
      if (cb) cb();
    },
    onChanged: {
      addListener(fn) {
        listeners.add(fn);
      },
      removeListener(fn) {
        listeners.delete(fn);
      },
    },
  };
}

describe('popupSettingsSchema', () => {
  it('parses an empty object into DEFAULT_SETTINGS', () => {
    expect(popupSettingsSchema.parse({})).toEqual(DEFAULT_SETTINGS);
  });

  it('rejects an unknown displayMode value', () => {
    const r = popupSettingsSchema.safeParse({ displayMode: 'rainbow' });
    expect(r.success).toBe(false);
  });

  it('accepts valid full settings', () => {
    const r = popupSettingsSchema.parse({ enabled: false, displayMode: 'arrow' });
    expect(r).toEqual({ enabled: false, displayMode: 'arrow', flipOverride: 'auto' });
  });

  it('parses an explicit flipOverride value', () => {
    const r = popupSettingsSchema.parse({ flipOverride: 'b' });
    expect(r.flipOverride).toBe('b');
  });

  it('rejects an unknown flipOverride value', () => {
    const r = popupSettingsSchema.safeParse({ flipOverride: 'rainbow' });
    expect(r.success).toBe(false);
  });
});

describe('loadPopupSettings', () => {
  it('returns defaults when storage is empty', async () => {
    const storage = fakeStorage();
    const { settings, repaired } = await loadPopupSettings(storage);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(repaired).toEqual([]);
  });

  it('returns defaults when chrome.storage is missing entirely', async () => {
    const { settings, repaired } = await loadPopupSettings(null);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(repaired).toEqual([]);
  });

  it('reads valid persisted settings unchanged', async () => {
    const storage = fakeStorage({
      [STORAGE_KEYS.enabled]: false,
      [STORAGE_KEYS.displayMode]: 'arrow',
    });
    const { settings, repaired } = await loadPopupSettings(storage);
    expect(settings).toEqual({ enabled: false, displayMode: 'arrow', flipOverride: 'auto' });
    expect(repaired).toEqual([]);
  });

  it('repairs an enabled field that has a non-boolean (string from a buggy older version)', async () => {
    const storage = fakeStorage({ [STORAGE_KEYS.enabled]: 'yes' });
    const { settings, repaired } = await loadPopupSettings(storage);
    expect(settings.enabled).toBe(DEFAULT_SETTINGS.enabled);
    expect(repaired).toContain('enabled');
  });

  it('repairs an unknown displayMode without dropping the rest of the settings', async () => {
    const storage = fakeStorage({
      [STORAGE_KEYS.enabled]: false,
      [STORAGE_KEYS.displayMode]: 'rainbow',
    });
    const { settings, repaired } = await loadPopupSettings(storage);
    expect(settings.enabled).toBe(false);
    expect(settings.displayMode).toBe(DEFAULT_SETTINGS.displayMode);
    expect(repaired).toEqual(['displayMode']);
  });

  it('does not mark a missing key as repaired (schema default applies cleanly)', async () => {
    const storage = fakeStorage({ [STORAGE_KEYS.enabled]: true });
    const { settings, repaired } = await loadPopupSettings(storage);
    expect(settings).toEqual({ enabled: true, displayMode: 'both', flipOverride: 'auto' });
    expect(repaired).toEqual([]);
  });

  it('reads a persisted flipOverride value', async () => {
    const storage = fakeStorage({ [STORAGE_KEYS.flipOverride]: 'b' });
    const { settings, repaired } = await loadPopupSettings(storage);
    expect(settings.flipOverride).toBe('b');
    expect(repaired).toEqual([]);
  });

  it('repairs an unknown flipOverride value to "auto"', async () => {
    const storage = fakeStorage({ [STORAGE_KEYS.flipOverride]: 'nope' });
    const { settings, repaired } = await loadPopupSettings(storage);
    expect(settings.flipOverride).toBe('auto');
    expect(repaired).toContain('flipOverride');
  });
});

describe('savePopupSettings', () => {
  it('writes only the provided keys, leaving others untouched', async () => {
    const storage = fakeStorage({
      [STORAGE_KEYS.enabled]: true,
      [STORAGE_KEYS.displayMode]: 'box',
    });
    const r = await savePopupSettings(storage, { enabled: false });
    expect(r.ok).toBe(true);
    expect(storage.data[STORAGE_KEYS.enabled]).toBe(false);
    expect(storage.data[STORAGE_KEYS.displayMode]).toBe('box');
  });

  it('rejects an invalid enabled value without writing', async () => {
    const storage = fakeStorage();
    const r = await savePopupSettings(storage, { enabled: 'yes' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/enabled/);
    expect(storage.data[STORAGE_KEYS.enabled]).toBeUndefined();
  });

  it('rejects an invalid displayMode without writing', async () => {
    const storage = fakeStorage();
    const r = await savePopupSettings(storage, { displayMode: 'rainbow' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/displayMode/);
    expect(storage.data[STORAGE_KEYS.displayMode]).toBeUndefined();
  });

  it('writes a valid flipOverride value', async () => {
    const storage = fakeStorage();
    const r = await savePopupSettings(storage, { flipOverride: 'b' });
    expect(r.ok).toBe(true);
    expect(storage.data[STORAGE_KEYS.flipOverride]).toBe('b');
  });

  it('rejects an invalid flipOverride without writing', async () => {
    const storage = fakeStorage();
    const r = await savePopupSettings(storage, { flipOverride: 'rainbow' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/flipOverride/);
    expect(storage.data[STORAGE_KEYS.flipOverride]).toBeUndefined();
  });

  it('is a no-op when partial is empty', async () => {
    const storage = fakeStorage();
    const r = await savePopupSettings(storage, {});
    expect(r.ok).toBe(true);
    expect(Object.keys(storage.data)).toEqual([]);
  });

  it('succeeds silently when storage is unavailable', async () => {
    const r = await savePopupSettings(null, { enabled: true });
    expect(r.ok).toBe(true);
  });
});

describe('subscribePopupSettings', () => {
  it('forwards validated cross-tab changes', async () => {
    const storage = fakeStorage();
    const fn = vi.fn();
    const dispose = subscribePopupSettings(storage, fn);
    await savePopupSettings(storage, { enabled: false, displayMode: 'arrow' });
    // Wait one microtask for the listener to fire.
    await Promise.resolve();
    expect(fn).toHaveBeenCalledWith({ enabled: false, displayMode: 'arrow' });
    dispose();
  });

  it('drops invalid change values', async () => {
    const storage = fakeStorage();
    const fn = vi.fn();
    subscribePopupSettings(storage, fn);
    storage.set({ [STORAGE_KEYS.enabled]: 'yes' });
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();
  });

  it('disposer unhooks the listener', async () => {
    const storage = fakeStorage();
    const fn = vi.fn();
    const dispose = subscribePopupSettings(storage, fn);
    dispose();
    await savePopupSettings(storage, { enabled: false });
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns a no-op disposer when storage is missing', () => {
    const dispose = subscribePopupSettings(null, () => {});
    expect(typeof dispose).toBe('function');
    expect(() => dispose()).not.toThrow();
  });
});
