/**
 * MultiPV line formatter.
 *
 * Takes an array of raw `parseInfoLine` results (from
 * backend/src/engine/uciParser) and produces a normalised, sorted,
 * render-ready list for the panel. Plan §8.2.
 *
 * Input tolerance: the engine can emit multiple depth iterations per
 * multipv index during a single search. We keep only the deepest per
 * index. Sort ascending by multipv so the PV arrows always draw the
 * same colour on top.
 */

export interface RawPv {
  multipv: number;
  depth: number;
  score?: number;
  mate?: number;
  nodes?: number;
  nps?: number;
  timeMs?: number;
  pv: string[];
}

export interface FormattedPv {
  rank: number;
  depth: number;
  score: string;
  scoreCp: number | null;
  mate: number | null;
  moves: string[];
  firstMove: string;
}

export function formatScore(cp?: number, mate?: number): string {
  if (mate !== undefined) return mate > 0 ? `#${mate}` : `#${mate}`;
  if (cp === undefined) return '0.00';
  const sign = cp > 0 ? '+' : '';
  return `${sign}${(cp / 100).toFixed(2)}`;
}

export function formatMultiPv(lines: readonly RawPv[]): FormattedPv[] {
  const deepest = new Map<number, RawPv>();
  for (const l of lines) {
    const existing = deepest.get(l.multipv);
    if (!existing || l.depth > existing.depth) deepest.set(l.multipv, l);
  }
  const sorted = [...deepest.values()].sort((a, b) => a.multipv - b.multipv);
  return sorted.map((l) => ({
    rank: l.multipv,
    depth: l.depth,
    score: formatScore(l.score, l.mate),
    scoreCp: l.score ?? null,
    mate: l.mate ?? null,
    moves: l.pv.slice(),
    firstMove: l.pv[0] ?? '',
  }));
}
