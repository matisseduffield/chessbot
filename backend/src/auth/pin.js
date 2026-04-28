'use strict';

/**
 * LAN-mode PIN authentication.
 *
 * When the backend is bound to a non-loopback address (BIND_HOST=0.0.0.0)
 * we don't want any device on the network to read game state or clear the
 * eval cache. We gate non-loopback HTTP requests and WebSocket upgrades
 * behind a short PIN that's printed once to the server log on startup.
 *
 * Loopback connections (127.0.0.1, ::1, ::ffff:127.0.0.1) are always
 * allowed without a PIN — the user running `npm start` on the same machine
 * shouldn't have to type a code.
 *
 * Auth flow:
 *   1. Client visits http://<lan-ip>:8080/?pin=123456 (or types the PIN
 *      into the prompt page we serve).
 *   2. We set an HttpOnly cookie `chessbot_pin=<token>` for 30 days.
 *   3. Subsequent requests (and the WS upgrade) carry the cookie and
 *      bypass the prompt.
 *
 * If LAN mode isn't active we export no-op middleware so loopback-only
 * users (the default) pay zero cost.
 */

const crypto = require('node:crypto');

const COOKIE = 'chessbot_pin';
const PIN_PAGE = (msg) => `<!doctype html>
<meta charset="utf-8">
<title>chessbot — pair this device</title>
<style>
  body { font: 14px system-ui, sans-serif; background: #1d1f23; color: #d8dadf; padding: 32px; max-width: 360px; margin: auto; }
  h1 { font-size: 18px; }
  input { font: 18px monospace; letter-spacing: 4px; padding: 10px; width: 100%; box-sizing: border-box; background: #15171a; color: #fff; border: 1px solid #3a3d44; border-radius: 6px; }
  button { margin-top: 12px; padding: 10px 16px; background: #4d8cf5; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  .err { color: #ff7676; margin-top: 10px; min-height: 1em; }
  .hint { opacity: 0.6; font-size: 12px; margin-top: 16px; }
</style>
<h1>chessbot — pair this device</h1>
<p>Enter the 6-digit PIN printed in the backend's server log to allow this device to use the dashboard.</p>
<form method="get" action="/">
  <input name="pin" autocomplete="off" autofocus inputmode="numeric" pattern="[0-9]{6}" maxlength="6" />
  <button type="submit">Pair</button>
  <div class="err">${msg || ''}</div>
</form>
<p class="hint">Only devices that pair are granted access. Cookie persists 30 days.</p>
`;

function isLoopback(req) {
  const raw = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return raw === '127.0.0.1' || raw === '::1' || raw === 'localhost';
}

function readCookie(headers, name) {
  const raw = headers?.cookie;
  if (!raw) return null;
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

/**
 * Build a PIN-auth handle. Call `installHttp(app)` and `wsUpgradeAllowed(req)`
 * from server.js. If LAN mode isn't active everything is a no-op.
 *
 * @param {{ enabled: boolean, logger?: { info(msg:string):void } }} opts
 */
function createPinAuth({ enabled, logger = console }) {
  if (!enabled) {
    return {
      enabled: false,
      pin: null,
      token: null,
      installHttp() {
        /* no-op */
      },
      wsUpgradeAllowed() {
        return true;
      },
    };
  }

  const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const token = crypto.randomBytes(24).toString('hex');

  logger.info(`[server] LAN PIN: ${pin}  (enter on first non-loopback connection)`);

  function isAuthed(req) {
    if (isLoopback(req)) return true;
    return readCookie(req.headers, COOKIE) === token;
  }

  return {
    enabled: true,
    pin,
    token,

    installHttp(app) {
      app.use((req, res, next) => {
        if (isAuthed(req)) return next();

        const provided = req.query?.pin;
        if (provided && String(provided) === pin) {
          if (typeof res.cookie === 'function') {
            res.cookie(COOKIE, token, {
              httpOnly: true,
              sameSite: 'lax',
              maxAge: 30 * 24 * 60 * 60 * 1000,
            });
          } else {
            res.setHeader(
              'Set-Cookie',
              `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Path=/`,
            );
          }
          const url = (req.originalUrl || '/').split('?')[0] || '/';
          return res.redirect(303, url);
        }

        const accept = req.headers['accept'] || '';
        if (accept.includes('text/html')) {
          res
            .status(401)
            .set('Content-Type', 'text/html; charset=utf-8')
            .end(PIN_PAGE(provided ? 'Wrong PIN — try again.' : ''));
        } else {
          res.status(401).json({ error: 'pin_required' });
        }
      });
    },

    wsUpgradeAllowed(req) {
      return isAuthed(req);
    },
  };
}

module.exports = { createPinAuth, _isLoopback: isLoopback, _readCookie: readCookie };
