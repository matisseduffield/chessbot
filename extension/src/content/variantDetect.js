// @ts-check
/**
 * Pure, DOM-free variant detection for the content script.
 *
 * The content script recognises which chess variant a page is showing so the
 * backend can switch Fairy-Stockfish into the right mode. Detection comes from
 * two sources: the URL path, and DOM text (page title + game-info labels /
 * variant links). This module holds the match tables and the pure matchers;
 * `content.js` keeps thin wrappers that read `location` / `document` and pass
 * the strings in here.
 *
 * Why per-site / per-source tables instead of one unified row-per-variant
 * table: the needle sets — and even the target key — genuinely differ between
 * sites and sources. e.g. chess.com folds "antichess" into `giveaway` (it
 * plays giveaway rules) while lichess keeps `antichess`; URL slugs differ from
 * the spaced human labels in titles. Faithful behaviour beats a tidy shape.
 *
 * Each table entry is `[needle, variantKey]`; order matters (first hit wins).
 * `matchVariant` returns the key string, or `null` for no match (callers treat
 * `null` as "standard / no special engine").
 */

/** Lichess / PlayStrategy (Chessground) URL-path patterns.
 *  @type {Array<[string, string]>} */
export const CHESSGROUND_URL_PATTERNS = [
  ['/atomic', 'atomic'],
  ['/crazyhouse', 'crazyhouse'],
  ['/chess960', 'chess960'],
  ['/kingofthehill', 'kingofthehill'],
  ['/threecheck', '3check'],
  ['/three-check', '3check'],
  // PlayStrategy five-check is now a real backend variant (was folded into 3check).
  ['/fivecheck', '5check'],
  ['/five-check', '5check'],
  ['/antichess', 'antichess'],
  ['/giveaway', 'giveaway'],
  ['/horde', 'horde'],
  ['/racingkings', 'racingkings'],
  ['/racing-kings', 'racingkings'],
  ['/bughouse', 'bughouse'],
  // No-castling is now a real backend variant (was treated as plain standard).
  ['/nocastling', 'nocastle'],
  ['/no-castling', 'nocastle'],
];

/** Chess.com URL-path patterns.
 *  @type {Array<[string, string]>} */
export const CHESSCOM_URL_PATTERNS = [
  ['chess960', 'chess960'],
  ['960', 'chess960'],
  ['atomic', 'atomic'],
  ['crazyhouse', 'crazyhouse'],
  ['kingofthehill', 'kingofthehill'],
  ['king-of-the-hill', 'kingofthehill'],
  ['3-check', '3check'],
  ['3check', '3check'],
  ['threecheck', '3check'],
  ['three-check', '3check'],
  ['antichess', 'antichess'],
  ['giveaway', 'giveaway'],
  ['horde', 'horde'],
  ['racingkings', 'racingkings'],
  ['racing-kings', 'racingkings'],
  ['bughouse', 'bughouse'],
  ['duck', 'duck'],
];

/** Chess.com DOM-text patterns (page title + game-info labels).
 *  @type {Array<[string, string]>} */
export const CHESSCOM_TEXT_PATTERNS = [
  ['atomic', 'atomic'],
  ['crazyhouse', 'crazyhouse'],
  ['king of the hill', 'kingofthehill'],
  ['3-check', '3check'],
  ['three-check', '3check'],
  ['three check', '3check'],
  ['giveaway', 'giveaway'],
  // chess.com plays giveaway rules even when the label says "antichess".
  ['antichess', 'giveaway'],
  ['horde', 'horde'],
  ['racing kings', 'racingkings'],
  ['bughouse', 'bughouse'],
  ['chess960', 'chess960'],
  ['fischer random', 'chess960'],
  ['duck', 'duck'],
];

/** Lichess / PlayStrategy DOM-text patterns (variant link/label + title).
 *  @type {Array<[string, string]>} */
export const CHESSGROUND_TEXT_PATTERNS = [
  ['atomic', 'atomic'],
  ['crazyhouse', 'crazyhouse'],
  ['chess960', 'chess960'],
  ['chess 960', 'chess960'],
  ['960', 'chess960'],
  ['king of the hill', 'kingofthehill'],
  ['three-check', '3check'],
  ['threecheck', '3check'],
  ['three check', '3check'],
  ['3-check', '3check'],
  ['3check', '3check'],
  ['five-check', '5check'],
  ['fivecheck', '5check'],
  ['five check', '5check'],
  ['antichess', 'antichess'],
  ['horde', 'horde'],
  ['racing kings', 'racingkings'],
  ['no castling', 'nocastle'],
];

/**
 * First pattern whose needle is a substring of `haystack` wins.
 * @param {Array<[string, string]>} patterns
 * @param {string} haystack
 * @param {{ stripSpaces?: boolean }} [opts] When true, spaces are removed from
 *   the needle before matching — used for hrefs like `/variant/kingofthehill`.
 * @returns {string | null}
 */
export function matchVariant(patterns, haystack, opts = {}) {
  if (typeof haystack !== 'string' || !haystack) return null;
  const hay = haystack.toLowerCase();
  for (const [needle, key] of patterns) {
    const n = opts.stripSpaces ? needle.replace(/ /g, '') : needle;
    if (hay.includes(n)) return key;
  }
  return null;
}

/**
 * Resolve a variant key from a URL pathname.
 * @param {string} pathname
 * @param {'chessground' | 'chesscom'} site
 * @returns {string | null}
 */
export function variantFromUrl(pathname, site) {
  const patterns = site === 'chesscom' ? CHESSCOM_URL_PATTERNS : CHESSGROUND_URL_PATTERNS;
  return matchVariant(patterns, pathname);
}

/**
 * Resolve a variant key from one or more DOM-text candidates (title,
 * game-info labels, hrefs). Returns the first candidate that matches.
 * @param {string[]} texts
 * @param {'chessground' | 'chesscom'} site
 * @param {{ stripSpaces?: boolean }} [opts]
 * @returns {string | null}
 */
export function variantFromText(texts, site, opts = {}) {
  const patterns = site === 'chesscom' ? CHESSCOM_TEXT_PATTERNS : CHESSGROUND_TEXT_PATTERNS;
  for (const t of texts || []) {
    const key = matchVariant(patterns, t, opts);
    if (key) return key;
  }
  return null;
}
