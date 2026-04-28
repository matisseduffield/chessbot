import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPinAuth, _readCookie } = require('./pin');

function mockReq({
  ip = '203.0.113.7',
  cookie = '',
  accept = 'text/html',
  query = {},
  originalUrl = '/',
} = {}) {
  return {
    ip,
    socket: { remoteAddress: ip },
    headers: { cookie, accept },
    query,
    originalUrl,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    redirected: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    set(k, v) {
      this.setHeader(k, v);
      return this;
    },
    end(b) {
      this.body = b;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.redirected = url;
      return this;
    },
  };
  return res;
}

describe('createPinAuth (disabled)', () => {
  it('is a no-op when LAN mode is off', () => {
    const auth = createPinAuth({ enabled: false });
    expect(auth.enabled).toBe(false);
    expect(auth.wsUpgradeAllowed({})).toBe(true);
  });
});

describe('createPinAuth (enabled)', () => {
  function build() {
    return createPinAuth({ enabled: true, logger: { info: vi.fn() } });
  }

  it('lets loopback through without a PIN (HTTP)', () => {
    const auth = build();
    let called = false;
    const next = () => {
      called = true;
    };
    const handler = capture(auth);
    handler(mockReq({ ip: '127.0.0.1' }), mockRes(), next);
    expect(called).toBe(true);
  });

  it('lets loopback upgrade WS without a PIN', () => {
    const auth = build();
    expect(auth.wsUpgradeAllowed(mockReq({ ip: '127.0.0.1' }))).toBe(true);
  });

  it('blocks non-loopback without cookie/PIN with 401', async () => {
    const auth = build();
    const handler = capture(auth);
    const res = mockRes();
    await handler(mockReq({ ip: '192.168.1.42' }), res, () => {
      throw new Error('next called');
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('pair this device');
  });

  it('returns JSON 401 for non-HTML requests', () => {
    const auth = build();
    const handler = capture(auth);
    const res = mockRes();
    handler(mockReq({ ip: '10.0.0.5', accept: 'application/json' }), res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'pin_required' });
  });

  it('accepts the right PIN, sets a cookie, and redirects', () => {
    const auth = build();
    const handler = capture(auth);
    const res = mockRes();
    handler(
      mockReq({ ip: '192.168.1.42', query: { pin: auth.pin }, originalUrl: '/?pin=' + auth.pin }),
      res,
      () => {},
    );
    expect(res.statusCode).toBe(303);
    expect(res.redirected).toBe('/');
    expect(String(res.headers['set-cookie'])).toContain('chessbot_pin=');
  });

  it('rejects the wrong PIN', async () => {
    const auth = build();
    const handler = capture(auth);
    const res = mockRes();
    await handler(mockReq({ ip: '192.168.1.42', query: { pin: '000000' } }), res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Wrong PIN');
  });

  it('lets a request with the right cookie through', () => {
    const auth = build();
    const handler = capture(auth);
    let called = false;
    handler(
      mockReq({ ip: '192.168.1.42', cookie: `chessbot_pin=${auth.token}` }),
      mockRes(),
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
    expect(
      auth.wsUpgradeAllowed(mockReq({ ip: '192.168.1.42', cookie: `chessbot_pin=${auth.token}` })),
    ).toBe(true);
  });
});

describe('_readCookie', () => {
  it('parses a single cookie', () => {
    expect(_readCookie({ cookie: 'a=1' }, 'a')).toBe('1');
  });
  it('parses one of several', () => {
    expect(_readCookie({ cookie: 'a=1; b=2; chessbot_pin=tok' }, 'chessbot_pin')).toBe('tok');
  });
  it('returns null when missing', () => {
    expect(_readCookie({ cookie: 'a=1' }, 'b')).toBe(null);
    expect(_readCookie({}, 'b')).toBe(null);
  });
});

// Helper: extract the middleware function the auth installs on an app.
function capture(auth) {
  let captured;
  const fakeApp = {
    use: (fn) => {
      captured = fn;
    },
  };
  auth.installHttp(fakeApp);
  return captured;
}
