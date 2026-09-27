import { it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { createSessionUI } from './sessionUI';
let ui;
afterEach(() => ui?.disconnect());
function setup() {
  const doc = new JSDOM(
    '<section data-section-id="position"></section><section data-section-id="training"><input id="chk-training-mode" type="checkbox"></section>',
  ).window.document;
  const sent = [];
  const state = {
    currentData: { fen: 'live', bestmove: 'e2e4', lines: [{ pv: ['e2e4'], score: 10 }] },
    ws: { readyState: 1, send: (data) => sent.push(JSON.parse(data)) },
  };
  ui = createSessionUI({ state, doc, render: vi.fn(), toast: vi.fn(), saveSettings: vi.fn() });
  ui.connect(state.ws);
  return { doc, state, sent };
}
it('previews the original position locally and restores the newest live result', () => {
  const { doc, state, sent } = setup();
  state.boardFlipped = true;
  ui.consume({
    type: 'training_history',
    attempts: [
      {
        id: '1',
        before: 'original',
        correct: false,
        player: 'w',
        recommendation: 'd2d4',
        timestamp: 1,
        feedback: { continuation: ['d2d4'] },
      },
    ],
  });
  sent.length = 0;
  [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Review position').click();
  expect(state.currentData.fen).toBe('original');
  expect(state.boardFlipped).toBe(false);
  expect(sent).toEqual([]);
  expect(ui.consume({ type: 'bestmove', fen: 'new live' })).toBe(true);
  doc.getElementById('return-live').click();
  expect(state.currentData.fen).toBe('new live');
  expect(state.boardFlipped).toBe(true);
  expect(sent).toEqual([]);
});
it('clears stale answers immediately when training is enabled', () => {
  const { doc, state } = setup();
  const checkbox = doc.getElementById('chk-training-mode');
  checkbox.checked = true;
  checkbox.dispatchEvent(new doc.defaultView.Event('change'));
  expect(state.currentData.trainingHidden).toBe(true);
  expect(state.currentData.bestmove).toBeNull();
  expect(state.currentData.lines[0].pv).toBeUndefined();
});
it('pins dashboard commands to the selected board and filters other results', () => {
  const { state, sent } = setup();
  ui.consume({
    type: 'sessions',
    selectedSessionId: 'board-a',
    followFocus: false,
    sessions: [
      { id: 'board-a', site: 'chesscom', variant: 'chess' },
      { id: 'board-b', site: 'lichess', variant: 'chess' },
    ],
  });
  state.ws.send(JSON.stringify({ type: 'set_option', name: 'depth', value: 0 }));
  expect(sent.at(-1).sessionId).toBe('board-a');
  expect(ui.consume({ type: 'bestmove', sessionId: 'board-b' })).toBe(true);
});
