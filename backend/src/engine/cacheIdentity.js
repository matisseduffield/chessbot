'use strict';
const { createHash } = require('node:crypto');
const { statSync } = require('node:fs');
/** @param {string} binary @param {Record<string,unknown>} options @param {{movetime?:number,nodes?:number}} limits */
function cacheIdentity(binary, options, limits) {
  let signature = null;
  try {
    const stat = statSync(binary);
    signature = [stat.size, stat.mtimeMs];
  } catch {
    /* test engine */
  }
  const sorted = Object.fromEntries(Object.entries(options).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256')
    .update(
      JSON.stringify({
        binary,
        signature,
        options: sorted,
        movetime: limits.movetime || null,
        nodes: limits.nodes || null,
      }),
    )
    .digest('hex');
}
module.exports = { cacheIdentity };
