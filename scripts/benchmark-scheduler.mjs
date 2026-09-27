import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const { EngineScheduler } = createRequire(import.meta.url)('../backend/src/engine/scheduler');
let release;
let searches = 0;
const scheduler = new EngineScheduler(() => {});
const owner = scheduler.submit({
  key: Symbol('settings'),
  sessionId: 'fixture',
  priority: 0,
  run: () =>
    new Promise((resolve) => {
      release = resolve;
    }),
});
const start = performance.now();
const jobs = Array.from({ length: 1000 }, () =>
  scheduler.submit({
    key: 'fen:fixture',
    sessionId: 'fixture',
    replace: true,
    run: async () => {
      searches++;
    },
  }),
);
const retained = scheduler.queue.length;
release();
await owner;
const outcomes = await Promise.all(jobs);
console.log(
  JSON.stringify(
    {
      requests: jobs.length,
      retainedWhileBusy: retained,
      cancelledBeforeSearch: outcomes.filter((x) => x?.cancelled).length,
      searches,
      schedulerElapsedMs: Number((performance.now() - start).toFixed(2)),
    },
    null,
    2,
  ),
);
