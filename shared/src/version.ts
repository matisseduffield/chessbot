/**
 * Protocol version for WebSocket messages exchanged between the backend,
 * the extension content script, and the dashboard panel.
 *
 * Bump this whenever the shape of any message in `./messages` changes in a
 * way that is not backwards compatible.
 */
export const PROTOCOL_VERSION = 1;
