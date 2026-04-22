// @ts-check
/**
 * Pure helpers for resolving search limits from a client request.
 *
 * History: depth/movetime handling has regressed before — bullet mode
 * was ignoring user-set depth caps. Isolating the logic makes it
 * unit-testable (plan §4.1) and keeps server.js focused on
 * orchestration.
 *
 * Now also applies clock-aware movetime safety (plan §8.3): if the
 * message carries `remainingClockMs`, we cap the configured movetime
 * so the engine never eats into the user's time reserve.
 */

const { pickSafeMoveTime } = require('@chessbot/shared');

/**
 * @param {{
 *   depth?: number|string|null,
 *   movetime?: number|string|null,
 *   nodes?: number|string|null,
 *   remainingClockMs?: number|string|null,
 *   clockReserveMs?: number|string|null,
 *   clockFraction?: number|string|null,
 * }} msg
 * @param {{ defaultDepth?: number, searchMovetime?: number, searchNodes?: number }} config
 * @returns {{ depth: number, options: { movetime?: number, nodes?: number } }}
 */
function pickSearchLimits(msg, config) {
  const m = msg || {};
  const c = config || {};
  const depth = (m.depth !== undefined && m.depth !== null)
    ? Number(m.depth)
    : (c.defaultDepth ?? 0);

  /** @type {{ movetime?: number, nodes?: number }} */
  const options = {};
  if (m.movetime) options.movetime = Number(m.movetime);
  else if (c.searchMovetime) options.movetime = Number(c.searchMovetime);
  else if (m.nodes) options.nodes = Number(m.nodes);
  else if (c.searchNodes) options.nodes = Number(c.searchNodes);

  // Plan §8.3: if client told us how much time they have left, cap
  // the movetime so we never burn the user's clock reserve. Only
  // applies when a movetime is actually being used (not pure-depth
  // or nodes mode).
  if (options.movetime !== undefined && m.remainingClockMs !== undefined && m.remainingClockMs !== null) {
    const remaining = Number(m.remainingClockMs);
    const reserveMs = m.clockReserveMs !== undefined && m.clockReserveMs !== null
      ? Number(m.clockReserveMs) : undefined;
    const fraction = m.clockFraction !== undefined && m.clockFraction !== null
      ? Number(m.clockFraction) : undefined;
    const safe = pickSafeMoveTime(remaining, {
      hardCapMs: options.movetime,
      reserveMs,
      fraction,
    });
    if (safe !== null && safe < options.movetime) {
      options.movetime = safe;
    }
  }

  return { depth, options };
}

module.exports = { pickSearchLimits };
