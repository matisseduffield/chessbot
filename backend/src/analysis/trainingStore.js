'use strict';
const fs = require('node:fs');
const path = require('node:path');
/** @typedef {{id:string,correct:boolean|null,assisted:boolean,sessionId?:string,feedback?:import('./trainingFeedback').Feedback,[key:string]:unknown}} Attempt */
/** @typedef {{correct:number,total:number,streak:number,assisted:number,unassisted:number}} Stats */
class TrainingStore {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    /** @type {{version:number,attempts:Attempt[],stats:Record<string,Stats>}} */
    this.data = { version: 1, attempts: [], stats: {} };
    this.writes = Promise.resolve();
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (loaded.version === 1 && Array.isArray(loaded.attempts)) {
        this.data.attempts = loaded.attempts
          .filter((/** @type {Attempt} */ a) => a && typeof a.id === 'string')
          .slice(-500);
        for (const attempt of this.data.attempts)
          if (attempt.feedback?.status === 'pending') {
            attempt.feedback = {
              status: 'unavailable',
              reason: 'Backend restarted before feedback completed',
            };
          }
        this.data.stats = loaded.stats && typeof loaded.stats === 'object' ? loaded.stats : {};
      }
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
        console.warn('[training] unreadable history; starting empty');
    }
  }
  /** @param {string} sessionId */
  stats(sessionId) {
    return {
      ...(this.data.stats[sessionId] || {
        correct: 0,
        total: 0,
        streak: 0,
        assisted: 0,
        unassisted: 0,
      }),
    };
  }
  /** @param {string} sessionId @param {Attempt} attempt */
  add(sessionId, attempt) {
    if (this.data.attempts.some((a) => a.id === attempt.id)) return false;
    this.data.attempts.push({ ...attempt, sessionId, feedback: { status: 'pending' } });
    this.data.attempts = this.data.attempts.slice(-500);
    const stats = this.stats(sessionId);
    if (attempt.correct !== null) {
      stats.total++;
      if (attempt.correct) {
        stats.correct++;
        stats.streak++;
      } else stats.streak = 0;
      stats[attempt.assisted ? 'assisted' : 'unassisted']++;
    }
    this.data.stats[sessionId] = stats;
    const keys = Object.keys(this.data.stats);
    if (keys.length > 50) delete this.data.stats[keys[0]];
    return true;
  }
  /** @param {string} id @param {import('./trainingFeedback').Feedback} feedback */
  update(id, feedback) {
    const a = this.data.attempts.find((a) => a.id === id);
    if (a) a.feedback = feedback;
  }
  /** @param {string} id */
  delete(id) {
    this.data.attempts = this.data.attempts.filter((a) => a.id !== id);
  }
  clear() {
    this.data.attempts = [];
  }
  /** @param {string} sessionId */
  reset(sessionId) {
    delete this.data.stats[sessionId];
  }
  history() {
    return this.data.attempts.slice().reverse();
  }
  save() {
    const snapshot = JSON.stringify(this.data);
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        await fs.promises.writeFile(this.file + '.tmp', snapshot, 'utf8');
        await fs.promises.rename(this.file + '.tmp', this.file);
      });
    return this.writes;
  }
}
module.exports = { TrainingStore };
