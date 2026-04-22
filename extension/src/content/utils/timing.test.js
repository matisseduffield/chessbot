import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce, throttle, sleep } from './timing.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('debounce', () => {
  it('fires once after the quiet window', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d('a');
    d('b');
    d('c');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('cancel() prevents pending invocation', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d('a');
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('throttle', () => {
  it('fires immediately on first call (leading edge)', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t('a');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('coalesces calls within window into one trailing call', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t('a');
    vi.advanceTimersByTime(40);
    t('b');
    t('c');
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('c');
  });

  it('allows leading fire again after full window with no calls', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t('a');
    vi.advanceTimersByTime(200);
    t('b');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('b');
  });

  it('cancel() drops pending trailing call', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t('a');
    t('b');
    t.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('sleep', () => {
  it('resolves after ms', async () => {
    const p = sleep(50);
    vi.advanceTimersByTime(50);
    await expect(p).resolves.toBeUndefined();
  });
});
