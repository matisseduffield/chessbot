import { describe, it, expect, vi } from 'vitest';
import { getJSON, setJSON, getRaw, setRaw, withCard } from './panelStore.js';

/** A controllable fake of the localStorage interface. */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
    },
    setItem(k, v) {
      data[k] = String(v);
    },
    removeItem(k) {
      delete data[k];
    },
  };
}

/** Throws on every call — simulates disabled / private-mode storage. */
const throwingStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

describe('getJSON', () => {
  it('returns the fallback when the key is missing', () => {
    expect(getJSON('nope', { x: 1 }, fakeStorage())).toEqual({ x: 1 });
  });

  it('returns the fallback when the value is corrupt JSON', () => {
    const s = fakeStorage({ key: '{not valid' });
    expect(getJSON('key', { x: 1 }, s)).toEqual({ x: 1 });
  });

  it('parses valid JSON', () => {
    const s = fakeStorage({ key: '{"a":1,"b":[true]}' });
    expect(getJSON('key', null, s)).toEqual({ a: 1, b: [true] });
  });

  it('returns the fallback when storage.getItem throws', () => {
    expect(getJSON('key', 'fallback', throwingStorage)).toBe('fallback');
  });
});

describe('setJSON', () => {
  it('writes JSON-stringified value and returns true', () => {
    const s = fakeStorage();
    expect(setJSON('k', { a: 1 }, s)).toBe(true);
    expect(s.data.k).toBe('{"a":1}');
  });

  it('returns false when the storage layer throws', () => {
    expect(setJSON('k', { a: 1 }, throwingStorage)).toBe(false);
  });
});

describe('getRaw / setRaw', () => {
  it('round-trips a string value', () => {
    const s = fakeStorage();
    setRaw('k', 'value', s);
    expect(getRaw('k', 'fallback', s)).toBe('value');
  });

  it('returns the fallback for a missing key', () => {
    expect(getRaw('missing', 'fallback', fakeStorage())).toBe('fallback');
  });

  it('returns the fallback when storage throws', () => {
    expect(getRaw('k', 'fallback', throwingStorage)).toBe('fallback');
  });

  it('setRaw returns false when storage throws', () => {
    expect(setRaw('k', 'v', throwingStorage)).toBe(false);
  });
});

describe('withCard', () => {
  it('returns the function result on success', () => {
    expect(withCard('card', () => 42)).toBe(42);
  });

  it('catches the error, returns the fallback, and reports via the log hook', () => {
    const log = vi.fn();
    const r = withCard(
      'eval-graph',
      () => {
        throw new Error('boom');
      },
      { fallback: null, log },
    );
    expect(r).toBe(null);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][1]).toBe('eval-graph');
  });

  it('returns undefined when no fallback is provided and the body throws', () => {
    const r = withCard(
      'pv',
      () => {
        throw new Error('x');
      },
      { log: () => {} },
    );
    expect(r).toBeUndefined();
  });

  it('uses console.error as the default log if the body throws', () => {
    const orig = console.error;
    const calls = [];
    // @ts-ignore — silencing for the test
    console.error = (...args) => calls.push(args);
    try {
      withCard('default-log', () => {
        throw new Error('whoops');
      });
    } finally {
      console.error = orig;
    }
    expect(calls.length).toBe(1);
    expect(String(calls[0][0])).toMatch(/card "default-log" render failed/);
  });
});
