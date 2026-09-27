import { it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const { EngineScheduler } = createRequire(import.meta.url)('./scheduler');
it('serializes switches with searches and replaces queued positions', async () => {
  let release;
  const order = [];
  const scheduler = new EngineScheduler(vi.fn());
  const first = scheduler.submit({
    key: 'control',
    priority: 0,
    run: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  const stale = scheduler.submit({ key: 'a', replace: true, run: () => order.push('stale') });
  const fresh = scheduler.submit({ key: 'a', replace: true, run: () => order.push('fresh') });
  expect(await stale).toEqual({ cancelled: true });
  release();
  await first;
  await fresh;
  expect(order).toEqual(['fresh']);
});
it('preempts review work but waits for its owner to release the engine', async () => {
  let release;
  let interrupted = false;
  const order = [];
  const scheduler = new EngineScheduler(() => {
    interrupted = true;
    release();
  });
  const review = scheduler.submit({
    key: 'review',
    priority: 3,
    run: async (cancelled) => {
      await new Promise((r) => {
        release = r;
      });
      order.push(cancelled() ? 'cancelled' : 'bad');
    },
  });
  const live = scheduler.submit({ key: 'live', priority: 1, run: () => order.push('live') });
  await Promise.all([review, live]);
  expect(interrupted).toBe(true);
  expect(order).toEqual(['cancelled', 'live']);
});
it('cancels only the named session', async () => {
  let release;
  const scheduler = new EngineScheduler(() => release());
  const a = scheduler.submit({
    key: 'a',
    sessionId: 'a',
    run: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  const b = scheduler.submit({ key: 'b', sessionId: 'b', run: () => 42 });
  scheduler.cancel('a');
  await a;
  expect(await b).toBe(42);
});
