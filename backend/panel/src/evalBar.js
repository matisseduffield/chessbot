// Eval bar + WDL bar renderer.
// Reads app state from ./state.js, pure math from ./panelRender.js, formatters from ./panelUtils.js.

import { state } from './state.js';
import { computeEvalBar, computeWdlPcts } from './panelRender.js';
import { formatScore } from './panelUtils.js';

export function renderEvalBar() {
  const wrap = document.getElementById('eval-bar-wrap');
  wrap.style.display = document.getElementById('chk-evalbar').checked ? 'block' : 'none';

  const topEl = document.getElementById('eval-bar-top');
  const scoreEl = document.getElementById('eval-bar-score');

  if (state.currentData.source === 'book') {
    topEl.style.height = '50%';
    topEl.style.background = 'linear-gradient(180deg,#d4a017,#b8860b)';
    scoreEl.textContent = 'Book';
    scoreEl.style.color = '#fff';
    scoreEl.style.bottom = 'auto';
    scoreEl.style.top = 'calc(50% - 5px)';
    scoreEl.style.transform = 'none';
    return;
  }

  topEl.style.background = '#333';
  scoreEl.style.transform = '';

  const boardFlipped = state.boardFlipped || state.currentData.flipped || false;
  const evalBarTop = document.getElementById('eval-bar-top');
  const evalBarBot = document.getElementById('eval-bar-bot');
  if (boardFlipped) {
    evalBarTop.style.background = '#e8e8e8';
    evalBarBot.style.background = '#333';
  } else {
    evalBarTop.style.background = '#333';
    evalBarBot.style.background = '#e8e8e8';
  }

  const lines = state.currentData.lines || [];
  if (!lines.length) {
    topEl.style.height = '50%';
    scoreEl.textContent = '—';
    scoreEl.style.color = '#333';
    scoreEl.style.bottom = '4px';
    scoreEl.style.top = 'auto';
    return;
  }

  const best = lines[0];
  const { whitePct, userScore } = computeEvalBar(
    best,
    state.currentData.fen ? state.currentData.fen.split(' ')[1] : 'w',
    boardFlipped,
  );

  topEl.style.height = boardFlipped ? `${whitePct}%` : `${100 - whitePct}%`;
  scoreEl.textContent = formatScore(userScore);

  if (boardFlipped) {
    if (whitePct > 50) {
      scoreEl.style.top = '4px';
      scoreEl.style.bottom = 'auto';
      scoreEl.style.color = '#333';
    } else {
      scoreEl.style.bottom = '4px';
      scoreEl.style.top = 'auto';
      scoreEl.style.color = '#ccc';
    }
  } else {
    if (whitePct > 50) {
      scoreEl.style.bottom = '4px';
      scoreEl.style.top = 'auto';
      scoreEl.style.color = '#333';
    } else {
      scoreEl.style.top = '4px';
      scoreEl.style.bottom = 'auto';
      scoreEl.style.color = '#ccc';
    }
  }

  const wdlBar = document.getElementById('wdl-bar');
  const turnStm = state.currentData.fen ? state.currentData.fen.split(' ')[1] : 'w';
  const wdlPcts = best.wdl ? computeWdlPcts(best.wdl, turnStm, boardFlipped) : null;
  if (wdlPcts) {
    const { w, d, l, wPct, dPct, lPct } = wdlPcts;
    document.getElementById('wdl-win').style.width = `${wPct.toFixed(1)}%`;
    document.getElementById('wdl-draw').style.width = `${dPct.toFixed(1)}%`;
    document.getElementById('wdl-loss').style.width = `${lPct.toFixed(1)}%`;
    document.getElementById('wdl-win-label').textContent = wPct >= 8 ? `${Math.round(wPct)}%` : '';
    document.getElementById('wdl-draw-label').textContent = dPct >= 8 ? `${Math.round(dPct)}%` : '';
    document.getElementById('wdl-loss-label').textContent = lPct >= 8 ? `${Math.round(lPct)}%` : '';
    wdlBar.title = `Win: ${(w / 10).toFixed(1)}%  Draw: ${(d / 10).toFixed(1)}%  Loss: ${(l / 10).toFixed(1)}%`;
    wdlBar.style.display = 'block';
  } else {
    wdlBar.style.display = 'none';
  }
}
