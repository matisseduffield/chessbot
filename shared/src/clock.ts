/**
 * Clock parsing + time-budget helpers (plan §8.3).
 *
 * Chess sites render clocks in inconsistent formats. The extension
 * scrapes whatever the DOM gives us; this module normalizes that text
 * into milliseconds and then decides how much time the engine can
 * safely spend on the next move.
 */

/**
 * Parse a clock string into total milliseconds.
 *
 * Accepted shapes (case / whitespace tolerant):
 *   "0.2"        → 200         (sub-second, bullet)
 *   "4.9"        → 4900
 *   "12"         → 12000
 *   "1:23"       → 83 000
 *   "1:23.4"     → 83 400
 *   "01:23"      → 83 000
 *   "1:02:30"    → 3 750 000
 *
 * Returns `null` for anything unrecognised (never throws).
 */
export function parseClockText(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;

  // H:MM:SS[.f]  or  MM:SS[.f]
  const colonMatch = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d+))?$/);
  if (colonMatch) {
    const a = Number(colonMatch[1]);
    const b = Number(colonMatch[2]);
    const c = colonMatch[3] !== undefined ? Number(colonMatch[3]) : null;
    const frac = colonMatch[4] !== undefined ? Number('0.' + colonMatch[4]) : 0;
    let totalSec: number;
    if (c !== null) {
      if (b >= 60 || c >= 60) return null;
      totalSec = a * 3600 + b * 60 + c;
    } else {
      if (b >= 60) return null;
      totalSec = a * 60 + b;
    }
    return Math.round((totalSec + frac) * 1000);
  }

  // Pure decimal seconds: "4.9", "12"
  const decMatch = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (decMatch) {
    const sec = Number(decMatch[1]);
    const frac = decMatch[2] !== undefined ? Number('0.' + decMatch[2]) : 0;
    return Math.round((sec + frac) * 1000);
  }

  return null;
}

/**
 * Coarse time-control classification from total starting time in
 * seconds, used to pick default engine budgets. Matches Lichess'
 * lexicon: ≤29s bullet classifier includes UltraBullet in practice.
 */
export type TimeControlClass = 'ultrabullet' | 'bullet' | 'blitz' | 'rapid' | 'classical';

export function classifyTimeControl(totalStartSec: number, incrementSec = 0): TimeControlClass {
  const budget = Math.max(0, totalStartSec) + 40 * Math.max(0, incrementSec);
  if (budget < 30) return 'ultrabullet';
  if (budget < 180) return 'bullet';
  if (budget < 480) return 'blitz';
  if (budget < 1500) return 'rapid';
  return 'classical';
}

export interface SafeMoveTimeOpts {
  /** Keep at least this many ms on the user's clock. Default 2 000. */
  reserveMs?: number;
  /** Engine may use at most this fraction of remaining time. Default 0.1 (10 %). */
  fraction?: number;
  /** Never exceed this — typically the user's configured movetime. */
  hardCapMs?: number;
  /** Never go below this — engine still needs a shot at a move. Default 50 ms. */
  minMs?: number;
}

/**
 * Given how much time the user has left on their clock, compute a
 * safe engine `movetime` in milliseconds. Always stays below the
 * hard cap, always leaves the reserve, never returns negative.
 */
export function pickSafeMoveTime(
  remainingClockMs: number | null | undefined,
  opts: SafeMoveTimeOpts = {},
): number | null {
  if (!Number.isFinite(remainingClockMs) || (remainingClockMs as number) <= 0) {
    return null;
  }
  const reserve = opts.reserveMs ?? 2000;
  const fraction = opts.fraction ?? 0.1;
  const minMs = opts.minMs ?? 50;
  const available = Math.max(0, (remainingClockMs as number) - reserve);
  let budget = Math.floor(available * fraction);
  if (opts.hardCapMs !== undefined) budget = Math.min(budget, opts.hardCapMs);
  if (budget < minMs) {
    // If reserving would leave nothing, still give the engine at
    // least minMs so we never return 0 (engine would hang).
    budget = Math.min(minMs, Math.max(1, (remainingClockMs as number) - 1));
  }
  return Math.max(0, budget);
}
