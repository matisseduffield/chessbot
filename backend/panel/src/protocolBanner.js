// @ts-check
/**
 * Protocol-mismatch banner for the dashboard panel.
 *
 * Plan §7.4 / Phase 4 (P4.A): the server already sends `protocolVersion`
 * in `server_hello`. The panel previously only logged the mismatch to
 * the console — users would just see "half-working behaviour" with no
 * UI signal. This module renders a fixed banner across the top of the
 * page so they know to rebuild + reload.
 *
 * The mismatch *predicate* is shared with the extension via
 * @chessbot/shared so the two clients agree on what counts as a
 * mismatch. The DOM rendering is panel-specific (the extension banner
 * has different positioning constraints because it overlays
 * third-party sites).
 */

const BANNER_ID = 'chessbot-panel-protocol-banner';

/**
 * Show a non-blocking banner across the top of the panel. Idempotent —
 * a second call updates in place rather than stacking.
 *
 * @param {{
 *   panelVersion: number,
 *   serverVersion: number,
 *   doc?: Document,
 *   onDismiss?: () => void,
 * }} args
 */
export function showProtocolMismatchBanner({
  panelVersion,
  serverVersion,
  doc = document,
  onDismiss,
}) {
  const existing = doc.getElementById(BANNER_ID);
  const banner = existing || doc.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute(
    'style',
    [
      'position: sticky',
      'top: 0',
      'z-index: 1000',
      'background: #c0392b',
      'color: #fff',
      'font: 13px/1.4 system-ui, -apple-system, sans-serif',
      'padding: 8px 14px',
      'display: flex',
      'align-items: center',
      'justify-content: space-between',
      'gap: 12px',
      'box-shadow: 0 2px 6px rgba(0,0,0,0.25)',
    ].join('; '),
  );

  const message = doc.createElement('span');
  message.textContent =
    `Protocol mismatch — panel v${panelVersion}, backend v${serverVersion}. ` +
    `Rebuild the panel (npm run build --workspace @chessbot/panel) and reload, ` +
    `or update whichever side is older.`;

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
  if (!existing) {
    // Prepend so the banner sits above the dashboard layout. Stays
    // sticky as the user scrolls until they dismiss it or reload.
    doc.body.insertBefore(banner, doc.body.firstChild);
  }
  return banner;
}

/** @param {{ doc?: Document }} [args] */
export function hideProtocolMismatchBanner({ doc = document } = {}) {
  const el = doc.getElementById(BANNER_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}
