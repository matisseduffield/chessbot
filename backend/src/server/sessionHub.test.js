import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
const { SessionHub } = createRequire(import.meta.url)('./sessionHub');
it('attaches a dashboard opened before the first board to that board', () => {
  const messages = [];
  const hub = new SessionHub(
    (ws, msg) => messages.push({ ws, msg }),
    () => ({}),
  );
  const panel = {},
    board = {};
  hub.register(panel, { client: 'panel' });
  hub.register(board, { client: 'extension', sessionId: 'first' });
  expect(panel.sessionId).toBe('first');
  messages.length = 0;
  hub.relay(board, { type: 'bestmove', bestmove: 'e2e4' });
  expect(messages[0]).toMatchObject({
    ws: panel,
    msg: { type: 'bestmove', sessionId: 'first', bestmove: 'e2e4' },
  });
});
it('routes results only to the subscribed board and removes training spoilers', () => {
  const messages = [];
  const hub = new SessionHub(
    (ws, msg) => messages.push({ ws, msg }),
    () => ({ training: true }),
  );
  const a = {},
    b = {},
    panel = {};
  hub.register(a, { client: 'extension', sessionId: 'a' });
  hub.register(b, { client: 'extension', sessionId: 'b' });
  hub.register(panel, { client: 'panel' });
  messages.length = 0;
  hub.relay(a, {
    type: 'bestmove',
    fen: 'position',
    bestmove: 'e2e4',
    lines: [{ move: 'e2e4', pv: ['e2e4'], score: 30 }],
  });
  expect(messages).toHaveLength(1);
  expect(messages[0].ws).toBe(panel);
  expect(messages[0].msg.bestmove).toBeNull();
  expect(messages[0].msg.lines[0].pv).toBeUndefined();
  hub.subscribe(panel, 'b', false);
  hub.focus('a');
  expect(panel.sessionId).toBe('b');
});
