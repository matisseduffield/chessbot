// Top + bottom player bars (name, clock, material, move #).
// Reads app state from ./state.js, material helpers from ./panelUtils.js.

import { state } from './state.js';
import { calculateMaterial, materialAdvantageHtml } from './panelUtils.js';

export function renderPlayerBars() {
  if (!state.currentData || !state.currentData.fen) return;
  const mat = calculateMaterial(state.currentData.fen);
  const moveNum = parseInt(state.currentData.fen.split(' ')[5]) || 1;
  const activeSide = state.currentData.fen.split(' ')[1];

  const flipped = state.currentData.flipped || false;
  const topColor = flipped ? 'white' : 'black';
  const bottomColor = flipped ? 'black' : 'white';

  const topInfo = state.gameInfo[topColor] || {};
  const bottomInfo = state.gameInfo[bottomColor] || {};

  document.getElementById('top-player-name').textContent = topInfo.name || '—';
  document.getElementById('top-player-clock').textContent = topInfo.clock || '';
  document.getElementById('top-player-clock').className =
    'player-bar-clock' + (activeSide === topColor[0] ? ' active' : '');
  document.getElementById('top-player-material').innerHTML =
    materialAdvantageHtml({}, mat[topColor + 'Pieces'] || {}, topColor[0]) +
    (mat.diff !== 0 &&
    ((topColor === 'white' && mat.diff > 0) || (topColor === 'black' && mat.diff < 0))
      ? `<span class="mat-adv">+${Math.abs(mat.diff)}</span>`
      : '');

  document.getElementById('bottom-player-name').textContent = bottomInfo.name || '—';
  document.getElementById('bottom-player-clock').textContent = bottomInfo.clock || '';
  document.getElementById('bottom-player-clock').className =
    'player-bar-clock' + (activeSide === bottomColor[0] ? ' active' : '');
  document.getElementById('bottom-player-material').innerHTML =
    materialAdvantageHtml({}, mat[bottomColor + 'Pieces'] || {}, bottomColor[0]) +
    (mat.diff !== 0 &&
    ((bottomColor === 'white' && mat.diff > 0) || (bottomColor === 'black' && mat.diff < 0))
      ? `<span class="mat-adv">+${Math.abs(mat.diff)}</span>`
      : '');

  const moveEl = document.getElementById('player-bar-bottom').querySelector('.move-num');
  if (!moveEl) {
    const span = document.createElement('span');
    span.className = 'move-num';
    span.textContent = `#${moveNum}`;
    document.getElementById('player-bar-bottom').prepend(span);
  } else {
    moveEl.textContent = `#${moveNum}`;
  }
}
