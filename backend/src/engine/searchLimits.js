/**
 * Pure helpers for resolving search limits from a client request.
 *
 * History: depth/movetime handling has regressed before — bullet mode
 * was ignoring user-set depth caps. Isolating the logic makes it
 * unit-testable (plan §4.1) and keeps server.js focused on
 * orchestration.
 */

/**
 * @param {{ depth?: number|string|null, movetime?: number|string|null, nodes?: number|string|null }} msg
 * @param {{ defaultDepth?: number, searchMovetime?: number, searchNodes?: number }} config
 * @returns {{ depth: number, options: { movetime?: number, nodes?: number } }}
 */
function pickSearchLimits(msg, config) {
  const m = msg || {};
  const c = config || {};
  const depth = (m.depth !== undefined && m.depth !== null)
    ? Number(m.depth)
    : (c.defaultDepth ?? 0);

  const options = {};
  if (m.movetime) options.movetime = Number(m.movetime);
  else if (c.searchMovetime) options.movetime = Number(c.searchMovetime);
  else if (m.nodes) options.nodes = Number(m.nodes);
  else if (c.searchNodes) options.nodes = Number(c.searchNodes);

  return { depth, options };
}

module.exports = { pickSearchLimits };
