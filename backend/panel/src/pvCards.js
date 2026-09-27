import './pvCards.css';
import { state } from './state.js';
import { escHtml, formatScore, formatPVMoves } from './panelUtils.js';
import {
  pvScoreColor,
  formatNodesMetric,
  formatTimeMetric,
  formatNpsMetric,
} from './panelRender.js';
import { PV_COLORS, moveRoute } from './movePresentation.js';
export { PV_COLORS } from './movePresentation.js';

export function renderPVs(onSelect) {
  const container = document.getElementById('pvs');
  const focusedRank = container.contains(document.activeElement)
    ? document.activeElement.dataset.pvRank
    : null;
  if (!document.getElementById('chk-pvs').checked) {
    container.replaceChildren();
    return;
  }
  const data = state.currentData;
  if (data.trainingHidden) {
    container.innerHTML =
      '<div class="empty-state"><span class="pv-empty-title">Training: your move</span>Move suggestions are hidden until reveal.</div>';
    return;
  }
  const lines = data.lines?.length
    ? data.lines
    : data.source === 'book' && data.bestmove
      ? [{ move: data.bestmove, eco: data.eco, pv: [data.bestmove] }]
      : [];
  if (!lines.length) {
    container.innerHTML =
      '<div class="empty-state"><span class="pv-empty-title">Waiting for analysis</span>Open a supported chess board to see move suggestions here.</div>';
    return;
  }
  state.selectedPV = Math.max(1, Math.min(state.selectedPV, lines.length));
  container.replaceChildren();
  const status = document.createElement('div');
  status.className = 'pv-status';
  const phase =
    data.source === 'review'
      ? 'Saved position'
      : data.cached
        ? 'Cached analysis'
        : data.streaming
          ? 'Searching'
          : 'Analysis ready';
  const turn = data.fen?.split(' ')[1] === 'b' ? 'Black' : 'White';
  status.innerHTML = `<span>${phase}</span><span>Scores for ${turn.toLowerCase()} to move</span>`;
  container.appendChild(status);
  lines.forEach((line, i) => {
    const selected = state.selectedPV === i + 1;
    const card = document.createElement('button');
    card.type = 'button';
    card.dataset.pvRank = String(i + 1);
    card.className = `pv-card${selected ? ' selected' : ''}`;
    card.style.setProperty('--pv-color', PV_COLORS[i] || PV_COLORS[0]);
    card.setAttribute('aria-pressed', String(selected));
    const moves = line.san || line.pv || [];
    const move = line.move || line.pv?.[0] || '';
    const first = moves[0] || move;
    const route = moveRoute(move);
    const score = formatScore(line);
    card.setAttribute(
      'aria-label',
      `Show suggestion ${i + 1}: ${first}, ${route}, evaluation ${score}`,
    );
    card.onclick = () => {
      state.selectedPV = i + 1;
      if (onSelect) onSelect();
    };
    const metrics = [
      line.depth ? `Depth ${line.depth}` : '',
      formatNodesMetric(line.nodes),
      formatTimeMetric(line.timeMs),
      formatNpsMetric(line.nps),
    ].filter(Boolean);
    const source = data.source === 'book' ? 'Book' : data.source === 'review' ? 'Saved' : 'Engine';
    card.innerHTML = `
      <span class="pv-header">
        <span class="pv-rank"><span class="pv-rank-dot" aria-hidden="true"></span>Choice ${i + 1}<span class="pv-source ${data.source === 'book' ? 'book' : 'engine'}">${source}</span></span>
        <span class="pv-score" style="color:${pvScoreColor(line)}">${escHtml(score)}</span>
      </span>
      <span class="pv-primary"><span class="pv-main-move">${escHtml(first)}</span><span class="pv-route">${escHtml(route)}</span></span>
      ${line.eco ? `<span class="pv-eco" title="${escHtml(line.eco)}">${escHtml(line.eco)}</span>` : ''}
      <span class="pv-moves">${formatPVMoves(moves.slice(0, 16), data.fen)}</span>
      <span class="pv-metrics">${metrics.map((m) => `<span>${escHtml(m)}</span>`).join('')}<span class="pv-selected-label">${selected ? 'On board' : 'Show on board'}</span></span>`;
    container.appendChild(card);
    // Streaming rerenders must not send a keyboard user's focus back to the page.
    if (focusedRank === card.dataset.pvRank) card.focus({ preventScroll: true });
  });
}
