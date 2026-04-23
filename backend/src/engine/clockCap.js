'use strict';
// @ts-check

/**
 * Clock-aware movetime cap (plan §8.3).
 *
 * When the user has a visible game clock (bullet / blitz / rapid), the engine
 * should never think longer than the user could realistically afford to spend.
 * This module takes the user's requested movetime and the parsed clock state
 * and returns a safe effective movetime.
 *
 * The caller is responsible for:
 *   - parsing the clock string into milliseconds (see shared/src/clock.ts)
 *   - deciding which side is "the user" (the side currently to move, assumed)
 *
 * Strategy (safe, conservative):
 *   1. If no clock data, return requested movetime unchanged.
 *   2. Reserve `bufferMs` (default 1500ms) for network/UI latency.
 *   3. Allocate at most 1 / `fractionDenom` of remaining time (default 1/25)
 *      — mirrors common time-management heuristics.
 *   4. Final cap = min(requested, buffered-fraction).
 *   5. Never return below `floorMs` (default 100ms) to ensure the engine
 *      returns *something*.
 */

/**
 * @param {number|null|undefined} requestedMs
 * @param {number|null|undefined} remainingMs
 * @param {{ bufferMs?: number, fractionDenom?: number, floorMs?: number, incrementMs?: number }} [opts]
 * @returns {{ effectiveMs: number, capped: boolean, reason: string|null }}
 */
function computeSafeMovetime(requestedMs, remainingMs, opts = {}) {
  const bufferMs = opts.bufferMs ?? 1500;
  const fractionDenom = Math.max(2, opts.fractionDenom ?? 25);
  const floorMs = Math.max(50, opts.floorMs ?? 100);
  const incrementMs = Math.max(0, opts.incrementMs ?? 0);

  const req = typeof requestedMs === 'number' && requestedMs > 0 ? requestedMs : null;

  if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs) || remainingMs <= 0) {
    return { effectiveMs: req ?? 0, capped: false, reason: null };
  }

  const usable = Math.max(0, remainingMs - bufferMs);
  const fraction = Math.floor(usable / fractionDenom) + Math.floor(incrementMs * 0.75);
  const allowed = Math.max(floorMs, fraction);

  if (req == null) {
    return { effectiveMs: allowed, capped: true, reason: 'no-request-used-clock' };
  }
  if (req <= allowed) {
    return { effectiveMs: req, capped: false, reason: null };
  }
  return { effectiveMs: allowed, capped: true, reason: 'clock-cap' };
}

module.exports = { computeSafeMovetime };
