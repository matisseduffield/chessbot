// PV card list renderer.
// Accepts an onSelect callback so the caller (index.html) can trigger a full re-render
// when a card is clicked.

import { state } from './state.js';
import { escHtml, formatScore, formatPVMoves } from './panelUtils.js';
import {
  pvScoreColor,
  formatNodesMetric,
  formatTimeMetric,
  formatNpsMetric,
} from './panelRender.js';

export const PV_COLORS = [
  '#2ecc71',
  '#00bcd4',
  '#f39c12',
  '#e74c3c',
  '#9b59b6',
  '#e67e22',
  '#1abc9c',
  '#e84393',
];

export function renderPVs(onSelect) {
  const container = document.getElementById('pvs');
  if (!document.getElementById('chk-pvs').checked) {
    container.innerHTML = '';
    return;
  }

  const lines = state.currentData.lines || [];
  if (!lines.length && state.currentData.source === 'book') {
    container.innerHTML = `<div class="pv-card selected">
      <div class="pv-header">
        <span class="pv-rank">Book Move</span>
        <span class="pv-source book">BOOK</span>
      </div>
      <div class="pv-eco">${escHtml(state.currentData.eco)}</div>
      <div style="font-size:18px;font-weight:800;font-family:monospace;color:var(--orange)">${escHtml(state.currentData.bestmove)}</div>
    </div>`;
    return;
  }

  if (!lines.length) {
    container.innerHTML = '<div class="empty-state">Waiting for analysis…</div>';
    return;
  }

  container.innerHTML = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const card = document.createElement('div');
    card.className = 'pv-card' + (state.selectedPV === i + 1 ? ' selected' : '');
    card.style.borderColor = state.selectedPV === i + 1 ? PV_COLORS[i] || PV_COLORS[0] : '';
    card.onclick = () => {
      state.selectedPV = i + 1;
      if (onSelect) onSelect();
    };

    const scoreText = formatScore(line);
    const scoreColor = pvScoreColor(line);
    const sanMoves = line.san || line.pv || [];
    const eco = line.eco || '';

    const metrics = [];
    const nodesStr = formatNodesMetric(line.nodes);
    if (nodesStr) metrics.push(nodesStr);
    const timeStr = formatTimeMetric(line.timeMs);
    if (timeStr) metrics.push(timeStr);
    const npsStr = formatNpsMetric(line.nps);
    if (npsStr) metrics.push(npsStr);
    const metricsHtml = metrics.length
      ? `<div class="pv-metrics">${metrics.map((m) => `<span>${escHtml(m)}</span>`).join('')}</div>`
      : '';

    card.innerHTML = `
      <div class="pv-header">
        <span class="pv-rank">PV ${i + 1} <span class="pv-source engine">${state.currentData.source === 'book' ? 'BOOK' : 'ENGINE'}</span>${line.depth ? `<span class="pv-depth">D${escHtml(line.depth)}</span>` : ''}</span>
        <span class="pv-score" style="color:${scoreColor}">${escHtml(scoreText)}</span>
      </div>
      <div class="pv-eco" title="${escHtml(eco)}">${escHtml(eco)}</div>
      <div class="pv-moves">${formatPVMoves(sanMoves.slice(0, 16), state.currentData.fen)}</div>
      ${metricsHtml}
    `;
    container.appendChild(card);
  }
}
