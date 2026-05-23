'use strict';

/**
 * Per-variant Fairy-Stockfish binary selection.
 *
 * Fairy-Stockfish ships two relevant builds:
 *   - the standard build: supports boards up to 8x8 (all the popular
 *     variants — duck, atomic, crazyhouse, 3check, antichess, etc.).
 *   - the "largeboard" build: adds support for boards bigger than 8x8
 *     (Xiangqi 9x10, Capablanca 10x8, Grand 10x10, ...), but is known to
 *     crash (segfault) on some 8x8 variants such as duck.
 *
 * So when the user has both binaries available we route each variant to the
 * build that can actually play it.
 */

/**
 * Variants whose board exceeds 8x8 and therefore require the largeboard
 * build. Everything else (8x8 and smaller) prefers the standard build.
 * @type {Set<string>}
 */
const LARGEBOARD_VARIANTS = new Set([
  // Xiangqi family (9x10)
  'xiangqi',
  'manchu',
  'janggi',
  // Shogi (9x9) — minis are <=8x8 and stay on the standard build
  'shogi',
  // Capablanca family (10x8) + Courier (12x8)
  'capablanca',
  'capahouse',
  'gothic',
  'janus',
  'embassy',
  'chancellor',
  'courier',
  // 9x9 boards
  'modern',
  'jesonmor',
  // 10x10 boards
  'grand',
  'grandhouse',
  'shako',
  'tencubed',
  'opulent',
]);

/** @param {string} name */
const isLargeboardName = (name) => /largeboard/i.test(name || '');
/** @param {string} name */
const isFairyName = (name) => /fairy/i.test(name || '');

/**
 * Classify a variant for engine selection.
 * @param {string} variantKey
 * @param {(key: string) => boolean} isCurated whether the key is a known
 *   (curated) variant; non-curated engine-reported variants are "unknown".
 * @returns {'large' | 'standard' | 'unknown'}
 */
function classifyVariant(variantKey, isCurated) {
  if (LARGEBOARD_VARIANTS.has(variantKey)) return 'large';
  if (isCurated(variantKey)) return 'standard';
  return 'unknown';
}

/**
 * Choose the Fairy-Stockfish binary path for a variant classification from
 * the available engine list. Returns the chosen path, or `null` meaning
 * "no preference — keep the current engine" (used for unknown variants and
 * when no fairy binary is available).
 *
 * @param {Array<{ name: string, path: string }>} engines
 * @param {'large' | 'standard' | 'unknown'} classification
 * @returns {string | null}
 */
function chooseFairyBinary(engines, classification) {
  if (classification === 'unknown') return null;
  const fairy = (engines || []).filter((e) => e && isFairyName(e.name));
  if (!fairy.length) return null;
  const large = fairy.filter((e) => isLargeboardName(e.name));
  const standard = fairy.filter((e) => !isLargeboardName(e.name));
  const prefer = classification === 'large' ? large : standard;
  const fallback = classification === 'large' ? standard : large;
  const chosen = prefer[0] || fallback[0] || null;
  return chosen ? chosen.path : null;
}

module.exports = { LARGEBOARD_VARIANTS, classifyVariant, chooseFairyBinary };
