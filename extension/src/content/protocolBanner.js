// @ts-check
/**
 * Protocol-mismatch banner — visible warning when the connected backend
 * speaks a different protocol version than the extension was built for.
 *
 * Plan §7.4 / Phase 4 (P4.A): the server already sends `protocolVersion`
 * in `server_hello` (`backend/server.js:524`), and content.js already
 * detects the mismatch — but the only signal was a `console.warn` that
 * users never see. Symptoms then look like silent breakage: arrows don't
 * appear, eval bar stays empty, no error in the page UI.
 *
 * This module renders a fixed-position banner at the top of the page so
 * the user knows to reload the extension or update the backend.
 *
 * Pure of build-time deps and stylesheets — injects all styles inline so
 * the banner shows even if the content stylesheet hasn't loaded yet (the
 * mismatch can fire on the very first WS frame, which is before
 * content.css attaches in some site DOMs).
 */

const BANNER_ID = 'chessbot-protocol-banner';

/**
 * Show a non-blocking banner across the top of the page. Idempotent —
 * calling twice with the same content updates in place rather than
 * stacking. Returns the banner element so callers can attach extra
 * behaviour if needed.
 *
 * @param {{
 *   extensionVersion: number,
 *   serverVersion: number,
 *   onDismiss?: () => void,
 *   doc?: Document,
 * }} args
 */
export function showProtocolMismatchBanner({
  extensionVersion,
  serverVersion,
  onDismiss,
  doc = document,
}) {
  const existing = doc.getElementById(BANNER_ID);
  const banner = existing || doc.createElement('div');
  banner.id = BANNER_ID;
  // Inline styles keep the banner visible even if content.css is racing
  // page styles or hasn't loaded yet.
  banner.setAttribute(
    'style',
    [
      'position: fixed',
      'top: 0',
      'left: 0',
      'right: 0',
      'z-index: 2147483646', // one below max so site nav still tops if needed
      'background: #c0392b',
      'color: #fff',
      'font: 13px/1.4 system-ui, -apple-system, sans-serif',
      'padding: 8px 14px',
      'box-shadow: 0 2px 6px rgba(0,0,0,0.25)',
      'display: flex',
      'align-items: center',
      'justify-content: space-between',
      'gap: 12px',
    ].join('; '),
  );
  // Use textContent to avoid any HTML-injection risk from version
  // numbers (they're numeric, but defence in depth).
  const message = doc.createElement('span');
  message.textContent =
    `Chessbot: protocol mismatch — extension speaks v${extensionVersion}, ` +
    `backend speaks v${serverVersion}. Reload the extension after restarting ` +
    `the backend, or upgrade whichever side is older.`;

  const dismiss = doc.createElement('button');
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute(
    'style',
    [
      'background: rgba(255,255,255,0.15)',
      'color: #fff',
      'border: 1px solid rgba(255,255,255,0.4)',
      'border-radius: 4px',
      'padding: 4px 10px',
      'font: inherit',
      'cursor: pointer',
      'flex: 0 0 auto',
    ].join('; '),
  );
  dismiss.addEventListener('click', () => {
    hideProtocolMismatchBanner({ doc });
    if (onDismiss) onDismiss();
  });

  banner.replaceChildren(message, dismiss);
  if (!existing) doc.body.appendChild(banner);
  return banner;
}

/**
 * Remove the banner if it's currently in the DOM. No-op otherwise.
 * @param {{ doc?: Document }} [args]
 */
export function hideProtocolMismatchBanner({ doc = document } = {}) {
  const el = doc.getElementById(BANNER_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// `isProtocolMismatch` moved to @chessbot/shared so the panel and
// extension agree on the predicate. Re-exported here so call sites
// inside the content script can keep importing from one module.
export { isProtocolMismatch } from '@chessbot/shared';
