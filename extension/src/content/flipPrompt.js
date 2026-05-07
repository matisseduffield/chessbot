// @ts-check
/**
 * "Which side am I?" prompt — shown when adapter flip detection
 * returns 'unknown' so we never silently guess wrong on rare DOM
 * shapes (custom puzzle pages, embedded boards, themes that drop
 * the orientation class).
 *
 * Plan §3 (P3.F): the previous fallback was a piece-Y-centroid
 * heuristic that frequently picked the wrong side on endgames with
 * few pieces. The plan called for "explicit unknown beats wrong" —
 * this module is the explicit prompt.
 *
 * Pure of build-time deps and stylesheets — injects all styles inline
 * so the badge shows even if content.css is racing with page styles
 * or hasn't loaded yet (the unknown signal can fire on the very
 * first read).
 */

const BADGE_ID = 'chessbot-flip-prompt';

/**
 * Show a small floating prompt asking the user which colour they're
 * playing. Idempotent — calling twice updates in place rather than
 * stacking. The two buttons each call `onSelect` with `'w'` or `'b'`.
 *
 * @param {{
 *   onSelect: (color: 'w' | 'b') => void,
 *   onDismiss?: () => void,
 *   doc?: Document,
 * }} args
 */
export function showFlipPrompt({ onSelect, onDismiss, doc = document }) {
  const existing = doc.getElementById(BADGE_ID);
  const badge = existing || doc.createElement('div');
  badge.id = BADGE_ID;
  badge.setAttribute(
    'style',
    [
      'position: fixed',
      'bottom: 16px',
      'right: 16px',
      'z-index: 2147483645',
      'background: #1f242c',
      'color: #e8eaef',
      'font: 12px/1.4 system-ui, -apple-system, sans-serif',
      'border: 1px solid #3a414d',
      'border-radius: 8px',
      'padding: 10px 12px',
      'box-shadow: 0 6px 18px rgba(0,0,0,0.35)',
      'display: flex',
      'flex-direction: column',
      'gap: 8px',
      'max-width: 240px',
    ].join('; '),
  );

  const message = doc.createElement('div');
  message.textContent = "Chessbot: which side are you playing? (Couldn't auto-detect.)";
  message.setAttribute('style', 'opacity: 0.85');

  const row = doc.createElement('div');
  row.setAttribute('style', 'display: flex; gap: 8px');

  const whiteBtn = makeChoiceButton(doc, 'White', () => {
    hideFlipPrompt({ doc });
    onSelect('w');
  });
  const blackBtn = makeChoiceButton(doc, 'Black', () => {
    hideFlipPrompt({ doc });
    onSelect('b');
  });
  row.append(whiteBtn, blackBtn);

  const dismiss = doc.createElement('button');
  dismiss.textContent = 'Skip';
  dismiss.setAttribute(
    'style',
    [
      'background: transparent',
      'color: #8a93a4',
      'border: 0',
      'font: inherit',
      'cursor: pointer',
      'align-self: flex-end',
      'padding: 0',
      'text-decoration: underline',
    ].join('; '),
  );
  dismiss.addEventListener('click', () => {
    hideFlipPrompt({ doc });
    if (onDismiss) onDismiss();
  });

  badge.replaceChildren(message, row, dismiss);
  if (!existing) doc.body.appendChild(badge);
  return badge;
}

/** @param {{ doc?: Document }} [args] */
export function hideFlipPrompt({ doc = document } = {}) {
  const el = doc.getElementById(BADGE_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

/**
 * @param {Document} doc
 * @param {string} label
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function makeChoiceButton(doc, label, onClick) {
  const btn = /** @type {HTMLButtonElement} */ (doc.createElement('button'));
  btn.textContent = label;
  btn.setAttribute(
    'style',
    [
      'flex: 1 1 auto',
      'background: #2c333d',
      'color: #fff',
      'border: 1px solid #3a414d',
      'border-radius: 5px',
      'padding: 6px 10px',
      'font: inherit',
      'cursor: pointer',
    ].join('; '),
  );
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Convenience: shown the prompt iff `confidence === 'unknown'` and
 * forward the user's choice to `onResolve` as a boolean
 * (`true` = flipped, i.e. they're playing black). When confidence is
 * already 'flipped' or 'unflipped', resolve synchronously and skip
 * the prompt. Returns a cancel function the caller can use if the
 * page navigates before the user clicks.
 *
 * @param {{
 *   confidence: 'flipped' | 'unflipped' | 'unknown',
 *   onResolve: (flipped: boolean) => void,
 *   doc?: Document,
 * }} args
 * @returns {() => void}
 */
export function resolveFlip({ confidence, onResolve, doc = document }) {
  if (confidence === 'flipped') {
    onResolve(true);
    return () => {};
  }
  if (confidence === 'unflipped') {
    onResolve(false);
    return () => {};
  }
  showFlipPrompt({
    doc,
    onSelect: (color) => onResolve(color === 'b'),
    onDismiss: () => {
      /* user skipped — caller decides what to do */
    },
  });
  return () => hideFlipPrompt({ doc });
}
