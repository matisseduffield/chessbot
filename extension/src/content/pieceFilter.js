/**
 * Pure class-name filter that removes chess.com "ghost" / "premove"
 * piece elements from a raw piece list. Extracted from content.js
 * (plan §2.1) so it can be unit-tested without a DOM.
 *
 * Input can be any iterable of objects that expose either a
 * `className` string or a `getAttribute("class")` method — so real
 * DOM elements, NodeList entries, and plain test stubs all work.
 */

/**
 * @param {Iterable<{ className?: string|unknown, getAttribute?: (name: string) => string|null }>} pieces
 * @returns {Array<{ className?: string|unknown, getAttribute?: (name: string) => string|null }>}
 */
export function filterGhostPieces(pieces) {
  return Array.from(pieces).filter((el) => {
    const cls =
      typeof el.className === 'string'
        ? el.className
        : (el.getAttribute && el.getAttribute('class')) || '';
    if (/\b(ghost|premove)\b/i.test(cls)) return false;
    return true;
  });
}
