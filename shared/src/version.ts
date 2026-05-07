/**
 * Protocol version for WebSocket messages exchanged between the backend,
 * the extension content script, and the dashboard panel.
 *
 * Bump this whenever the shape of any message in `./messages` changes in a
 * way that is not backwards compatible.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Returns true if `serverVersion` is a number that disagrees with the
 * caller's `expectedVersion`. Non-numeric values (older backend that
 * didn't send the field at all) are treated as "no signal" so we don't
 * pop a mismatch warning on legitimate older-but-still-compatible
 * deployments.
 *
 * Used by both the extension content script and the dashboard panel to
 * decide whether to render the protocol-mismatch banner.
 */
export function isProtocolMismatch(expectedVersion: number, serverVersion: unknown): boolean {
  if (typeof serverVersion !== 'number') return false;
  if (!Number.isFinite(serverVersion)) return false;
  return serverVersion !== expectedVersion;
}
