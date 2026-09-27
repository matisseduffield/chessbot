'use strict';
const { randomUUID } = require('node:crypto');
/** @typedef {Record<string, any>} Frame */
/** @typedef {{role?:string,sessionId?:string|null,followFocus?:boolean,context?:{sessionId?:string,requestId?:string}}} Client */
/** @typedef {{id:string,site:string,variant?:string,training?:boolean,revealedFen?:string|null,lastResult?:Frame,[key:string]:any}} Session */

class SessionHub {
  /** @param {(client:Client,frame:Frame)=>void} send @param {()=>Record<string,any>} makeState */
  constructor(send, makeState) {
    this.send = send;
    this.makeState = makeState;
    this.sessions = new Map();
    this.clients = new Set();
    this.focused = null;
  }
  /** @type {Map<string,Session>} */ sessions;
  /** @type {Set<Client>} */ clients;
  /** @type {string|null} */ focused;
  /** @param {Client} ws @param {Frame} msg */
  register(ws, msg) {
    ws.role = msg.client;
    this.clients.add(ws);
    if (ws.role === 'extension') {
      const id = msg.sessionId || randomUUID();
      if (!this.sessions.has(id))
        this.sessions.set(id, { id, site: msg.site || 'unknown', ...this.makeState() });
      ws.sessionId = id;
      if (!this.focused) {
        this.focused = id;
        for (const panel of this.clients)
          if (panel.role === 'panel' && panel.followFocus) panel.sessionId = id;
      }
    } else {
      ws.followFocus = true;
      ws.sessionId = this.focused;
    }
    this.publish();
  }
  /** @param {string} id */
  focus(id) {
    if (!this.sessions.has(id)) return;
    this.focused = id;
    for (const ws of this.clients) if (ws.role === 'panel' && ws.followFocus) ws.sessionId = id;
    this.publish();
  }
  /** @param {Client} ws @param {string} id @param {boolean} follow */
  subscribe(ws, id, follow = true) {
    if (ws.role !== 'panel') return;
    ws.followFocus = follow;
    ws.sessionId = follow ? this.focused : id;
    this.publish();
  }
  /** @param {Client} ws */
  state(ws) {
    return ws.sessionId ? this.sessions.get(ws.sessionId) : undefined;
  }
  publish() {
    const online = new Set(
      [...this.clients].filter((w) => w.role === 'extension').map((w) => w.sessionId),
    );
    for (const ws of this.clients)
      if (ws.role === 'panel') {
        this.send(ws, {
          type: 'sessions',
          selectedSessionId: ws.sessionId,
          followFocus: ws.followFocus,
          sessions: [...this.sessions.values()]
            .filter((s) => online.has(s.id))
            .map((s) => ({ id: s.id, site: s.site, variant: s.variant })),
        });
        const session = this.state(ws);
        if (session?.gameInfo) this.send(ws, { ...session.gameInfo, sessionId: session.id });
        if (session?.lastResult) this.send(ws, this.forPanel(session, session.lastResult));
      }
  }
  /** @param {Client} sender @param {Frame} message */
  relay(sender, message) {
    const sessionId = message.sessionId ?? sender.context?.sessionId ?? sender.sessionId;
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    const frame = {
      ...message,
      sessionId,
      requestId: message.requestId ?? sender.context?.requestId,
    };
    if (message.type === 'bestmove' && session) session.lastResult = frame;
    for (const ws of this.clients) {
      if (ws === sender || ws.sessionId !== sessionId) continue;
      // Engine data only goes back to its owner and subscribed dashboards.
      if (['bestmove', 'eval_progress', 'game_info'].includes(message.type) && ws.role !== 'panel')
        continue;
      this.send(ws, ws.role === 'panel' ? this.forPanel(session, frame) : frame);
    }
  }
  /** @param {Session|undefined} session @param {Frame} frame */
  forPanel(session, frame) {
    if (frame.type !== 'bestmove' || !session?.training || session.revealedFen === frame.fen)
      return frame;
    return {
      ...frame,
      bestmove: null,
      ponder: null,
      trainingHidden: true,
      lines: (frame.lines || [])
        .slice(0, 1)
        .map((/** @type {Frame} */ { score, mate, wdl, depth }) => ({ score, mate, wdl, depth })),
    };
  }
  /** @param {Client} ws */
  remove(ws) {
    this.clients.delete(ws);
    if (![...this.clients].some((w) => w.role === 'extension' && w.sessionId === this.focused)) {
      this.focused = [...this.clients].find((w) => w.role === 'extension')?.sessionId || null;
      for (const panel of this.clients)
        if (panel.role === 'panel' && panel.followFocus) panel.sessionId = this.focused;
    }
    // Retain a bounded reconnect window, not an unbounded browser history.
    if (this.sessions.size > 50)
      for (const [id] of this.sessions) {
        if (![...this.clients].some((w) => w.sessionId === id)) {
          this.sessions
            .get(id)
            ?.book?.close()
            ?.catch(() => {});
          this.sessions.delete(id);
          break;
        }
      }
    this.publish();
  }
}
module.exports = { SessionHub };
