// SVG board + arrow renderer + appearance constants.
// Reads app state from ./state.js and calls renderPlayerBars after drawing.

import { state } from './state.js';
import { parseBoardDimensions } from './panelUtils.js';
import { renderPlayerBars } from './playerBars.js';

export const PIECE_IMG = {
  K: '/pieces/white-king.png',
  Q: '/pieces/white-queen.png',
  R: '/pieces/white-rook.png',
  B: '/pieces/white-bishop.png',
  N: '/pieces/white-knight.png',
  P: '/pieces/white-pawn.png',
  k: '/pieces/black-king.png',
  q: '/pieces/black-queen.png',
  r: '/pieces/black-rook.png',
  b: '/pieces/black-bishop.png',
  n: '/pieces/black-knight.png',
  p: '/pieces/black-pawn.png',
};

export const BOARD_THEMES = {
  classic: { light: '#f0d9b5', dark: '#b58863', name: 'Classic' },
  green: { light: '#ffffdd', dark: '#86a666', name: 'Green' },
  blue: { light: '#dee3e6', dark: '#8ca2ad', name: 'Blue' },
  purple: { light: '#e8daf0', dark: '#9070a0', name: 'Purple' },
  grey: { light: '#d9d9d9', dark: '#8b8b8b', name: 'Grey' },
  coral: { light: '#f0d0b0', dark: '#c07050', name: 'Coral' },
  midnight: { light: '#c8c8d0', dark: '#505070', name: 'Midnight' },
  wood: { light: '#e8d0a8', dark: '#a07850', name: 'Wood' },
};

export function getBoardColors() {
  return BOARD_THEMES[state.currentBoardTheme] || BOARD_THEMES.classic;
}

export const PIECE_SETS = {
  classic: { name: 'Classic', type: 'image' },
  neo: { name: 'Neo', type: 'unicode', shadow: true, outline: true },
  minimalist: { name: 'Minimal', type: 'unicode', shadow: false, outline: false },
  letters: { name: 'Letters', type: 'letter' },
};

export const UNICODE_PIECES = {
  K: '\u2654',
  Q: '\u2655',
  R: '\u2656',
  B: '\u2657',
  N: '\u2658',
  P: '\u2659',
  k: '\u265A',
  q: '\u265B',
  r: '\u265C',
  b: '\u265D',
  n: '\u265E',
  p: '\u265F',
};

export const LETTER_PIECES = {
  K: 'K',
  Q: 'Q',
  R: 'R',
  B: 'B',
  N: 'N',
  P: 'P',
  k: 'K',
  q: 'Q',
  r: 'R',
  b: 'B',
  n: 'N',
  p: 'P',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function renderBoard() {
  const container = document.getElementById('board-svg-container');
  container.style.display = 'block';

  const svg = document.getElementById('board-svg');
  svg.innerHTML = '';

  const fen = state.currentData.fen;
  if (!fen) return;
  const boardPart = fen.split(' ')[0].replace(/\[.*?\]$/g, '');
  const dim = parseBoardDimensions(fen);
  const numFiles = dim.files;
  const numRanks = dim.ranks;
  const sqSize = 100;
  const svgW = numFiles * sqSize;
  const svgH = numRanks * sqSize;
  svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
  container.style.setProperty('--board-aspect', `${numFiles} / ${numRanks}`);

  const theme = getBoardColors();
  const flipped = state.currentData.flipped || false;

  for (let r = 0; r < numRanks; r++) {
    for (let f = 0; f < numFiles; f++) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', f * sqSize);
      rect.setAttribute('y', r * sqSize);
      rect.setAttribute('width', sqSize);
      rect.setAttribute('height', sqSize);
      const actualR = flipped ? numRanks - 1 - r : r;
      const actualF = flipped ? numFiles - 1 - f : f;
      rect.setAttribute('fill', (actualR + actualF) % 2 === 0 ? theme.light : theme.dark);
      svg.appendChild(rect);
    }
  }

  const pieceSet = PIECE_SETS[state.currentPieceSet] || PIECE_SETS.classic;
  const rows = boardPart.split('/');
  for (let r = 0; r < rows.length; r++) {
    let f = 0;
    for (let i = 0; i < rows[r].length; i++) {
      const ch = rows[r][i];
      if (ch >= '0' && ch <= '9') {
        let num = ch;
        while (i + 1 < rows[r].length && rows[r][i + 1] >= '0' && rows[r][i + 1] <= '9') {
          num += rows[r][++i];
        }
        f += parseInt(num);
        continue;
      }
      if (ch === '+' || ch === '~') continue;

      const visR = flipped ? numRanks - 1 - r : r;
      const visF = flipped ? numFiles - 1 - f : f;
      const tx = visF * sqSize;
      const ty = visR * sqSize;

      if (pieceSet.type === 'image') {
        const pieceImg = PIECE_IMG[ch];
        if (!pieceImg) {
          f++;
          continue;
        }
        const img = document.createElementNS(SVG_NS, 'image');
        img.setAttribute('href', pieceImg);
        img.setAttribute('x', tx);
        img.setAttribute('y', ty);
        img.setAttribute('width', sqSize);
        img.setAttribute('height', sqSize);
        img.setAttribute('style', 'pointer-events:none;');
        svg.appendChild(img);
      } else if (pieceSet.type === 'unicode') {
        const sym = UNICODE_PIECES[ch];
        if (!sym) {
          f++;
          continue;
        }
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', tx + sqSize / 2);
        text.setAttribute('y', ty + sqSize * 0.82);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', sqSize * 0.85);
        text.setAttribute('fill', ch === ch.toUpperCase() ? '#fff' : '#1a1a1a');
        text.setAttribute('style', 'pointer-events:none;');
        if (pieceSet.shadow) text.setAttribute('filter', 'drop-shadow(0 2px 3px rgba(0,0,0,0.5))');
        if (pieceSet.outline) {
          text.setAttribute('stroke', ch === ch.toUpperCase() ? '#333' : '#999');
          text.setAttribute('stroke-width', '1.5');
          text.setAttribute('paint-order', 'stroke');
        }
        text.textContent = sym;
        svg.appendChild(text);
      } else if (pieceSet.type === 'letter') {
        const ltr = LETTER_PIECES[ch];
        if (!ltr) {
          f++;
          continue;
        }
        const isWhite = ch === ch.toUpperCase();
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', tx + sqSize / 2);
        text.setAttribute('y', ty + sqSize * 0.72);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', sqSize * 0.65);
        text.setAttribute('font-weight', '900');
        text.setAttribute('font-family', "'JetBrains Mono', monospace");
        text.setAttribute('fill', isWhite ? '#fff' : '#1a1a1a');
        text.setAttribute('stroke', isWhite ? '#333' : '#ccc');
        text.setAttribute('stroke-width', '2');
        text.setAttribute('paint-order', 'stroke');
        text.setAttribute('style', 'pointer-events:none;');
        text.textContent = ltr;
        svg.appendChild(text);
      }
      f++;
    }
  }

  const lines = state.currentData.lines || [];
  if (lines.length > 0) {
    const line = lines[Math.min(state.selectedPV - 1, lines.length - 1)];
    const pv = line.pv || [];
    if (pv.length >= 1) drawArrow(svg, pv[0], true, numFiles, numRanks);
    if (pv.length >= 2) drawArrow(svg, pv[1], false, numFiles, numRanks);
  } else if (state.currentData.bestmove && state.currentData.bestmove.length >= 3) {
    drawArrow(svg, state.currentData.bestmove, true, numFiles, numRanks);
  }

  renderPlayerBars();
}

export function drawArrow(svg, uci, isOurMove, numFiles, numRanks) {
  if (!uci || uci.length < 3) return;
  const sqSize = 100;

  const dropMatch = uci.match(/^([PNBRQK])@([a-z])(\d+)$/i);
  if (dropMatch) {
    const toF = dropMatch[2].charCodeAt(0) - 97;
    const toR = numRanks - parseInt(dropMatch[3]);
    const cx = toF * sqSize + sqSize / 2;
    const cy = toR * sqSize + sqSize / 2;
    const tx = toF * sqSize;
    const ty = toR * sqSize;
    const color = isOurMove ? 'hsla(145,100%,50%,0.8)' : 'hsla(350,100%,50%,0.7)';
    const radius = sqSize * 0.38;
    const sw = Math.max(2, sqSize * 0.04);
    const PIECE_SYMBOLS = {
      P: '\u265F',
      N: '\u265E',
      B: '\u265D',
      R: '\u265C',
      Q: '\u265B',
      K: '\u265A',
    };
    const PIECE_NAMES = { P: 'PAWN', N: 'KNIGHT', B: 'BISHOP', R: 'ROOK', Q: 'QUEEN', K: 'KING' };
    const symbol = PIECE_SYMBOLS[dropMatch[1].toUpperCase()] || dropMatch[1];
    const pieceName = PIECE_NAMES[dropMatch[1].toUpperCase()] || 'DROP';

    const g = document.createElementNS(SVG_NS, 'g');

    const highlight = document.createElementNS(SVG_NS, 'rect');
    highlight.setAttribute('x', tx + sw / 2);
    highlight.setAttribute('y', ty + sw / 2);
    highlight.setAttribute('width', sqSize - sw);
    highlight.setAttribute('height', sqSize - sw);
    highlight.setAttribute('fill', color);
    highlight.setAttribute('fill-opacity', '0.25');
    highlight.setAttribute('stroke', color);
    highlight.setAttribute('stroke-width', sw);
    highlight.setAttribute('stroke-dasharray', `${sqSize * 0.15} ${sqSize * 0.08}`);
    highlight.setAttribute('rx', sqSize * 0.06);
    g.appendChild(highlight);

    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', radius);
    circle.setAttribute('fill', color);
    circle.setAttribute('stroke', '#fff');
    circle.setAttribute('stroke-width', Math.max(2, sqSize * 0.04));
    circle.setAttribute('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))');
    g.appendChild(circle);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', cx);
    text.setAttribute('y', cy + sqSize * 0.14);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', sqSize * 0.46);
    text.setAttribute('font-weight', '900');
    text.setAttribute('fill', '#fff');
    text.setAttribute('filter', 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))');
    text.textContent = symbol;
    g.appendChild(text);

    const labelFontSize = sqSize * 0.17;
    const labelY = ty - labelFontSize * 0.3;
    if (labelY > 0) {
      const pillW = labelFontSize * pieceName.length * 0.7 + 8;
      const pillH = labelFontSize + 4;
      const pill = document.createElementNS(SVG_NS, 'rect');
      pill.setAttribute('x', cx - pillW / 2);
      pill.setAttribute('y', labelY - pillH + 2);
      pill.setAttribute('width', pillW);
      pill.setAttribute('height', pillH);
      pill.setAttribute('fill', color);
      pill.setAttribute('rx', pillH / 2);
      g.appendChild(pill);

      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', cx);
      label.setAttribute('y', labelY);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', labelFontSize);
      label.setAttribute('font-weight', '900');
      label.setAttribute('font-family', 'system-ui, sans-serif');
      label.setAttribute('fill', '#fff');
      label.textContent = pieceName;
      g.appendChild(label);
    }

    svg.appendChild(g);
    g.classList.add('move-arrow');
    return;
  }

  const m = uci.match(/^([a-z])(\d+)([a-z])(\d+)/);
  if (!m) return;
  const fromF = m[1].charCodeAt(0) - 97;
  const fromR = numRanks - parseInt(m[2]);
  const toF = m[3].charCodeAt(0) - 97;
  const toR = numRanks - parseInt(m[4]);

  const x1 = fromF * sqSize + sqSize / 2;
  const y1 = fromR * sqSize + sqSize / 2;
  const x2t = toF * sqSize + sqSize / 2;
  const y2t = toR * sqSize + sqSize / 2;

  const dx = x2t - x1;
  const dy = y2t - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return;
  const ux = dx / dist;
  const uy = dy / dist;
  const px = -uy;
  const py = ux;

  const color = isOurMove ? 'hsla(145,100%,50%,0.8)' : 'hsla(350,100%,50%,0.7)';
  const shaftW = sqSize * 0.1;
  const headW = sqSize * 0.25;
  const headLen = sqSize * 0.35;

  const tipDist = dist - sqSize * 0.12;
  const tipX = x1 + ux * tipDist;
  const tipY = y1 + uy * tipDist;
  const neckDist = tipDist - headLen;
  const neckX = x1 + ux * neckDist;
  const neckY = y1 + uy * neckDist;

  const points = [
    x1 + px * shaftW,
    y1 + py * shaftW,
    neckX + px * shaftW,
    neckY + py * shaftW,
    neckX + px * headW,
    neckY + py * headW,
    tipX,
    tipY,
    neckX - px * headW,
    neckY - py * headW,
    neckX - px * shaftW,
    neckY - py * shaftW,
    x1 - px * shaftW,
    y1 - py * shaftW,
  ];

  const d = `M${points[0]},${points[1]} L${points[2]},${points[3]} L${points[4]},${points[5]} L${points[6]},${points[7]} L${points[8]},${points[9]} L${points[10]},${points[11]} L${points[12]},${points[13]}Z`;

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', color);
  path.setAttribute('filter', 'drop-shadow(0 1px 3px rgba(0,0,0,0.4))');
  path.classList.add('move-arrow');
  svg.appendChild(path);
}
