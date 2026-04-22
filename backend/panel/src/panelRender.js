// Pure helpers carved out of panel renderers (renderEvalGraph, renderEvalBar,
// renderPVs, speak) so they can be unit-tested. The DOM-touching shells stay
// in backend/panel/index.html and call into these functions.

/**
 * Convert a centipawn value to a Y pixel coordinate on the eval graph.
 * @param {number} cp
 * @param {boolean} flipped   user is playing black → invert sign
 * @param {number} midY       graph vertical midpoint in CSS pixels
 * @param {number} clamp      centipawn clamp range (default 800)
 * @returns {number}
 */
export function evalCpToY(cp, flipped, midY, clamp = 800) {
  const userCp = flipped ? -cp : cp;
  const clamped = Math.max(-clamp, Math.min(clamp, userCp));
  return midY - (clamped / clamp) * midY;
}

/**
 * Precompute everything the eval graph renderer needs.
 * @param {Array<{ cp: number }>} evalHistory
 * @param {boolean} flipped
 * @param {number} width       graph width in CSS pixels
 * @param {number} height      graph height in CSS pixels
 * @param {number} clamp
 * @returns {{ midY: number, points: Array<{x:number, y:number}>, lastAdjCp: number, step: number }}
 */
export function computeEvalGraphPoints(evalHistory, flipped, width, height, clamp = 800) {
  const midY = height / 2;
  const n = evalHistory.length;
  if (n === 0) return { midY, points: [], lastAdjCp: 0, step: 0 };
  if (n === 1) {
    const y = evalCpToY(evalHistory[0].cp, flipped, midY, clamp);
    const lastAdjCp = flipped ? -evalHistory[0].cp : evalHistory[0].cp;
    return {
      midY,
      points: [
        { x: 0, y },
        { x: width, y },
      ],
      lastAdjCp,
      step: 0,
    };
  }
  const step = width / (n - 1);
  const points = evalHistory.map((e, i) => ({
    x: i * step,
    y: evalCpToY(e.cp, flipped, midY, clamp),
  }));
  const lastAdjCp = flipped ? -evalHistory[n - 1].cp : evalHistory[n - 1].cp;
  return { midY, points, lastAdjCp, step };
}

/**
 * Compute the eval-bar white-percentage and user-oriented score object for a
 * given engine PV line. Pure — no DOM.
 * @param {{ score?: number|null, mate?: number|null }} bestLine
 * @param {"w"|"b"} turn
 * @param {boolean} flipped
 * @returns {{ whitePct: number, userScore: { score?: number|null, mate?: number|null } }}
 */
export function computeEvalBar(bestLine, turn, flipped) {
  if (!bestLine) return { whitePct: 50, userScore: {} };
  let whitePct = 50;
  if (bestLine.mate !== undefined && bestLine.mate !== null) {
    whitePct = bestLine.mate > 0 ? 95 : 5;
  } else if (bestLine.score !== undefined && bestLine.score !== null) {
    const cpWhite = turn === 'w' ? bestLine.score : -bestLine.score;
    whitePct = Math.min(95, Math.max(5, 50 + cpWhite / 10));
  }
  let userScore = { ...bestLine };
  if (flipped) {
    if (userScore.score !== undefined && userScore.score !== null) {
      const cpWhiteScore = turn === 'w' ? userScore.score : -userScore.score;
      userScore = { ...userScore, score: -cpWhiteScore };
    }
    if (userScore.mate !== undefined && userScore.mate !== null) {
      const mateWhite = turn === 'w' ? userScore.mate : -userScore.mate;
      userScore = { ...userScore, mate: -mateWhite };
    }
  }
  return { whitePct, userScore };
}

/**
 * Compute WDL bar widths from a wdl struct, accounting for side-to-move and
 * board orientation.
 * @param {{ win: number, draw: number, loss: number } | null | undefined} wdl
 * @param {"w"|"b"} turn
 * @param {boolean} flipped
 * @returns {{ w: number, d: number, l: number, wPct: number, dPct: number, lPct: number, total: number } | null}
 */
export function computeWdlPcts(wdl, turn, flipped) {
  if (!wdl) return null;
  const total = wdl.win + wdl.draw + wdl.loss;
  if (total <= 0) return null;
  const wWhite = turn === 'w' ? wdl.win : wdl.loss;
  const dWhite = wdl.draw;
  const lWhite = turn === 'w' ? wdl.loss : wdl.win;
  const w = flipped ? lWhite : wWhite;
  const d = dWhite;
  const l = flipped ? wWhite : lWhite;
  return {
    w,
    d,
    l,
    wPct: (w / total) * 100,
    dPct: (d / total) * 100,
    lPct: (l / total) * 100,
    total,
  };
}

/** Format an engine node count ("1.2M", "340K", "123"). */
export function formatNodesMetric(n) {
  if (!n && n !== 0) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M nodes`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K nodes`;
  return `${n} nodes`;
}

/** Format an engine search time ("1.2s" / "450ms"). */
export function formatTimeMetric(ms) {
  if (!ms && ms !== 0) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/** Format an engine NPS value ("1.2M nps" / "340K nps"). */
export function formatNpsMetric(nps) {
  if (!nps && nps !== 0) return '';
  if (nps >= 1e6) return `${(nps / 1e6).toFixed(1)}M nps`;
  return `${(nps / 1e3).toFixed(0)}K nps`;
}

/**
 * Decide the CSS colour (var(--green) / var(--red)) for a PV line based on
 * its score / mate sign.
 * @param {{ score?: number|null, mate?: number|null }} line
 * @returns {string}
 */
export function pvScoreColor(line) {
  if (!line) return 'var(--green)';
  const isGood =
    line.mate !== undefined && line.mate !== null
      ? line.mate > 0
      : line.score !== undefined && line.score !== null
        ? line.score >= 0
        : true;
  return isGood ? 'var(--green)' : 'var(--red)';
}

/**
 * Make a SAN move string pronounceable by TTS.
 * @param {string} text
 * @returns {string}
 */
export function speakablize(text) {
  return String(text || '')
    .replace(/\+/g, ' check')
    .replace(/#/g, ' checkmate')
    .replace(/^O-O-O$/i, 'queen side castle')
    .replace(/^O-O$/i, 'king side castle');
}
