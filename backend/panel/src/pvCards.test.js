import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { state } from './state.js';
import { renderPVs } from './pvCards.js';
import { renderBoard } from './board.js';
import { PV_COLORS, moveRoute } from './movePresentation.js';
vi.mock('./playerBars.js', () => ({ renderPlayerBars: vi.fn() }));
let dom;
beforeEach(() => {
  dom = new JSDOM(
    '<input id="chk-pvs" type="checkbox" checked><div id="pvs"></div><div id="board-svg-container"><svg id="board-svg"></svg></div>',
  );
  vi.stubGlobal('document', dom.window.document);
  state.selectedPV = 1;
  state.boardFlipped = false;
  state.currentData = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    source: 'engine',
    lines: [
      { move: 'e2e4', san: ['e4', 'e5'], pv: ['e2e4', 'e7e5'], score: 30, depth: 15 },
      { move: 'g1f3', san: ['Nf3', 'd5'], pv: ['g1f3', 'd7d5'], score: 20, depth: 15 },
    ],
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});
it('selects a suggestion with a native button and preserves focus through rerenders', () => {
  renderPVs(() => renderPVs());
  const second = document.querySelectorAll('button')[1];
  second.focus();
  second.click();
  expect(state.selectedPV).toBe(2);
  expect(document.activeElement.dataset.pvRank).toBe('2');
  expect(document.activeElement.getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement.textContent).toContain('g1 → f3');
  expect(document.querySelector('.pv-status').textContent).toContain('Scores for white to move');
});
it('does not expose hidden training moves or coordinates', () => {
  state.currentData.trainingHidden = true;
  renderPVs();
  expect(document.querySelectorAll('button')).toHaveLength(0);
  expect(document.getElementById('pvs').textContent).not.toMatch(/e2|e4|Nf3/);
});
it('keeps book moves selectable and escapes supplied notation', () => {
  state.currentData = {
    ...state.currentData,
    source: 'book',
    bestmove: 'e2e4',
    lines: [],
    eco: '<img src=x onerror=alert(1)>',
  };
  renderPVs();
  expect(document.querySelector('button').textContent).toContain('e2 → e4');
  expect(document.querySelector('#pvs img')).toBeNull();
});
it('formats promotions, drops and multi-digit variant coordinates without rule guesses', () => {
  expect(moveRoute('a7a8n')).toBe('a7 → a8 =N');
  expect(moveRoute('N@f3')).toBe('N @ f3');
  expect(moveRoute('j10j9')).toBe('j10 → j9');
});
it('keeps board coordinates and selected arrow colour aligned after flipping', () => {
  state.selectedPV = 2;
  renderBoard();
  expect(
    [...document.querySelectorAll('[data-axis="file"]')].map((e) => e.textContent).join(''),
  ).toBe('abcdefgh');
  expect(document.querySelectorAll('.move-arrow')[1].getAttribute('fill')).toBe(PV_COLORS[1]);
  state.boardFlipped = true;
  renderBoard();
  expect(
    [...document.querySelectorAll('[data-axis="file"]')].map((e) => e.textContent).join(''),
  ).toBe('hgfedcba');
  expect(
    [...document.querySelectorAll('[data-axis="rank"]')].map((e) => e.textContent).join(''),
  ).toBe('12345678');
});
it('labels larger variant boards using their actual dimensions', () => {
  state.currentData = { fen: '10/10/10/10/10/10/10/10/10/10 w - - 0 1', lines: [] };
  renderBoard();
  expect(document.querySelector('#board-svg').getAttribute('viewBox')).toBe('0 0 1000 1000');
  expect(document.querySelectorAll('[data-axis="file"]')).toHaveLength(10);
  expect(document.querySelector('[data-axis="rank"]').textContent).toBe('10');
});
