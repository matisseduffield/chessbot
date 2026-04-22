import { describe, it, expect, beforeEach, vi } from 'vitest';
import { trySelectors, trySelectorsAll, __resetWarnedForTests } from './selectorRegistry.js';

beforeEach(() => {
  __resetWarnedForTests();
  vi.restoreAllMocks();
});

describe('trySelectors', () => {
  it('returns the primary match when present', () => {
    const fake = { tagName: 'DIV' };
    const find = vi.fn((sel) => (sel === '.primary' ? fake : null));
    const out = trySelectors('k', ['.primary', '.fallback'], find);
    expect(out).toBe(fake);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('falls through to a later selector', () => {
    const fallback = { tagName: 'SPAN' };
    const find = vi.fn((sel) => (sel === '.fallback' ? fallback : null));
    const out = trySelectors('k', ['.primary', '.middle', '.fallback'], find);
    expect(out).toBe(fallback);
    expect(find).toHaveBeenCalledTimes(3);
  });

  it('returns null and warns once when nothing matches', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const find = vi.fn(() => null);
    expect(trySelectors('k.missing', ['.a', '.b'], find)).toBe(null);
    expect(trySelectors('k.missing', ['.a', '.b'], find)).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('trySelectorsAll', () => {
  it('returns first non-empty list', () => {
    const findAll = vi.fn((sel) => {
      if (sel === '.first') return [];
      if (sel === '.second') return [{ tagName: 'DIV' }, { tagName: 'DIV' }];
      return [];
    });
    const out = trySelectorsAll('k', ['.first', '.second', '.third'], findAll);
    expect(out).toHaveLength(2);
    expect(findAll).toHaveBeenCalledTimes(2);
  });

  it('returns [] and warns once when everything is empty', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const findAll = vi.fn(() => []);
    expect(trySelectorsAll('k.empty', ['.a'], findAll)).toEqual([]);
    expect(trySelectorsAll('k.empty', ['.a'], findAll)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('accepts a NodeList-like return', () => {
    const nodeList = { length: 2, 0: { tagName: 'P' }, 1: { tagName: 'P' } };
    Array.prototype[Symbol.iterator].call([]); // sanity
    const findAll = () => nodeList;
    // Array.from(nodeList) requires length + indexed items
    const out = trySelectorsAll('k', ['.x'], findAll);
    expect(out).toHaveLength(2);
  });
});
