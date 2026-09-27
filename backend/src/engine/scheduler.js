'use strict';

// One owner for all native-engine operations, including settings and switches.
// A pending position replaces older work for that session; control jobs retain order.
/** @typedef {{key:string|symbol, sessionId:string, priority?:number, replace?:boolean, run:(cancelled:()=>boolean)=>Promise<unknown>}} Request */
/** @typedef {Request & {priority:number,cancelled:boolean,resolve:(value:unknown)=>void,reject:(error:unknown)=>void}} Job */
class EngineScheduler {
  /** @param {()=>unknown} abort */
  constructor(abort) {
    this.abort = abort;
    this.queue = [];
    this.active = null;
    this.closed = false;
    this.stopping = Promise.resolve();
  }
  /** @type {Job[]} */ queue;
  /** @type {Job|null} */ active;
  /** @param {Request} request */
  submit({ key, sessionId, priority = 1, replace = false, run }) {
    if (this.closed) return Promise.resolve({ cancelled: true });
    if (replace) this.cancelQueued((job) => job.key === key);
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ key, sessionId, priority, run, resolve, reject, cancelled: false });
    });
    if (
      this.active &&
      !this.active.cancelled &&
      (priority < this.active.priority || (replace && key === this.active.key))
    ) {
      this.active.cancelled = true;
      this.stopping = Promise.resolve(this.abort()).then(
        () => {},
        () => {},
      );
    }
    this.pump();
    return promise;
  }
  /** @param {(job:Job)=>boolean} predicate */
  cancelQueued(predicate) {
    this.queue = this.queue.filter((job) => {
      if (!predicate(job)) return true;
      job.cancelled = true;
      job.resolve({ cancelled: true });
      return false;
    });
  }
  /** @param {string} sessionId */
  cancel(sessionId) {
    this.cancelQueued((job) => job.sessionId === sessionId);
    if (this.active?.sessionId === sessionId && !this.active.cancelled) {
      this.active.cancelled = true;
      this.stopping = Promise.resolve(this.abort()).then(
        () => {},
        () => {},
      );
    }
  }
  /** Cancel analysis without losing a queued settings acknowledgement. @param {string} sessionId */
  cancelAnalysis(sessionId) {
    this.cancelQueued((job) => job.sessionId === sessionId && typeof job.key === 'string');
    if (
      this.active?.sessionId === sessionId &&
      typeof this.active.key === 'string' &&
      !this.active.cancelled
    ) {
      this.active.cancelled = true;
      this.stopping = Promise.resolve(this.abort()).then(
        () => {},
        () => {},
      );
    }
  }
  async pump() {
    if (this.active || !this.queue.length) return;
    this.queue.sort((a, b) => a.priority - b.priority);
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    try {
      job.resolve(await job.run(() => job.cancelled));
    } catch (error) {
      job.reject(error);
    } finally {
      await this.stopping;
      this.active = null;
      this.pump();
    }
  }
  close() {
    this.closed = true;
    this.cancelQueued(() => true);
    if (this.active) {
      this.active.cancelled = true;
      return this.abort();
    }
  }
}
module.exports = { EngineScheduler };
