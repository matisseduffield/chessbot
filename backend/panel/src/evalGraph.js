// Stateful eval graph renderer (plan §2.1 / §5.1).
// Owns the rAF coalescing and canvas-size cache so the panel monolith no
// longer needs to track any of it. Imports pure graph math from panelRender
// and the shared state bag from state.js.

import { computeEvalGraphPoints } from './panelRender.js';
import { state } from './state.js';

let rafId = 0;
let lastCanvasW = 0;
let lastCanvasH = 0;

/**
 * Request a redraw on the next animation frame. Multiple calls within the
 * same frame collapse into a single draw — critical during WS bursts where
 * many info frames arrive per render tick.
 */
export function renderEvalGraph() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    renderEvalGraphNow();
  });
}

function renderEvalGraphNow() {
  const canvas = document.getElementById('eval-graph');
  const evalHistory = state.evalHistory;
  const currentData = state.currentData || {};
  if (!canvas || !evalHistory.length) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.floor(rect.width * dpr);
  const h = Math.floor(rect.height * dpr);
  if (w !== lastCanvasW || h !== lastCanvasH) {
    canvas.width = w;
    canvas.height = h;
    lastCanvasW = w;
    lastCanvasH = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = rect.width;
  const ch = rect.height;
  ctx.clearRect(0, 0, cw, ch);

  const style = getComputedStyle(document.documentElement);
  const green = style.getPropertyValue('--green').trim() || '#22c55e';
  const red = style.getPropertyValue('--red').trim() || '#ef4444';

  const midY = ch / 2;

  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(cw, midY);
  ctx.stroke();
  ctx.restore();

  const n = evalHistory.length;
  const graph = computeEvalGraphPoints(evalHistory, currentData.flipped || false, cw, ch);
  const { points } = graph;

  if (n === 1) {
    const y = points[0].y;
    const color = graph.lastAdjCp >= 0 ? green : red;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cw, y);
    ctx.stroke();
    return;
  }

  // Green fill (above zero)
  ctx.beginPath();
  ctx.moveTo(points[0].x, midY);
  for (const p of points) {
    const y = Math.min(p.y, midY);
    ctx.lineTo(p.x, y);
  }
  ctx.lineTo(points[n - 1].x, midY);
  ctx.closePath();
  ctx.fillStyle = green + '33';
  ctx.fill();

  // Red fill (below zero)
  ctx.beginPath();
  ctx.moveTo(points[0].x, midY);
  for (const p of points) {
    const y = Math.max(p.y, midY);
    ctx.lineTo(p.x, y);
  }
  ctx.lineTo(points[n - 1].x, midY);
  ctx.closePath();
  ctx.fillStyle = red + '33';
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < n; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.strokeStyle = graph.lastAdjCp >= 0 ? green : red;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
