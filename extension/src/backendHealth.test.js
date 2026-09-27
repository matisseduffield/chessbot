import { it, expect, vi, afterEach } from 'vitest';
import { watchBackendHealth } from './backendHealth.js';
afterEach(() => vi.useRealTimers());
it('distinguishes a reachable server from a ready engine without opening sockets', async () => {
  vi.useFakeTimers();
  const fetchFn = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok', engine: { ready: false } }),
    })
    .mockResolvedValue({ ok: true, json: async () => ({ status: 'ok', engine: { ready: true } }) });
  const status = vi.fn(),
    stop = watchBackendHealth(status, { fetchFn });
  await vi.advanceTimersByTimeAsync(0);
  expect(status).toHaveBeenLastCalledWith('starting');
  await vi.advanceTimersByTimeAsync(5000);
  expect(status).toHaveBeenLastCalledWith('ready');
  stop();
  await vi.advanceTimersByTimeAsync(20000);
  expect(fetchFn).toHaveBeenCalledTimes(2);
});
it('aborts a hanging check and never notifies after disposal', async () => {
  vi.useFakeTimers();
  let signal;
  const fetchFn = vi.fn((_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  });
  const status = vi.fn(),
    stop = watchBackendHealth(status, { fetchFn });
  await vi.advanceTimersByTimeAsync(2500);
  expect(signal.aborted).toBe(true);
  expect(status).toHaveBeenLastCalledWith('offline');
  await vi.advanceTimersByTimeAsync(5000);
  stop();
  status.mockClear();
  await vi.advanceTimersByTimeAsync(10000);
  expect(status).not.toHaveBeenCalled();
  expect(fetchFn).toHaveBeenCalledTimes(2);
});
