'use strict';

/**
 * HTTP route registration for the backend dashboard + diagnostics.
 *
 * Extracted from server.js (plan §2.1, P2.F). The previous inline
 * version reached straight into main()'s locals; this module takes
 * a `deps` object so the routes can be unit-tested against fakes
 * and the main file no longer needs to know how individual
 * endpoints are wired.
 *
 * Mutable backend state (`engine`, `currentVariant`, `wss`) is
 * accessed through getter functions so that route handlers always
 * read the latest value after a variant/engine switch.
 *
 * @typedef {{
 *   startedAt: number,
 *   config: { port: number },
 *   evalCache: { size: number, max: number, ttlMs: number, clear(): void },
 *   evalCachePath: string,
 *   eco: { size?: () => number },
 *   book: { enabled: boolean, bookPath?: string },
 *   getEngine: () => { ready: boolean, evaluate?: Function } | null,
 *   getCurrentVariant: () => string,
 *   getCurrentEngineType: () => string,
 *   getLichessBook: () => { enabled: boolean } | null,
 *   getWss: () => { clients: { size: number } } | null,
 *   panelDir: string,
 *   pkgVersion: string,
 *   bookBaseName: (p: string) => string,
 *   express: typeof import('express'),
 *   log?: { info: Function, warn: Function },
 * }} HttpRoutesDeps
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Register origin / CORS middleware and dashboard / health / cache
 * routes on the given Express app.
 * @param {import('express').Express} app
 * @param {HttpRoutesDeps} deps
 */
function registerHttpRoutes(app, deps) {
  registerOriginGate(app, deps);
  registerCors(app, deps);
  registerHealthAndDiagnostics(app, deps);
  registerCacheControlEndpoints(app, deps);
  registerPanelStatic(app, deps);
}

/**
 * Block POST requests from origins we don't recognise. Stops a malicious
 * page or LAN device from forging a form post that would clear the eval
 * cache or otherwise mutate state. Same-host POSTs (i.e. the dashboard
 * pinned itself open from the running device) are allowed.
 * @param {import('express').Express} app
 * @param {HttpRoutesDeps} deps
 */
function registerOriginGate(app, { config }) {
  const TRUSTED_POST_ORIGINS = new Set([
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    'https://www.chess.com',
    'https://lichess.org',
    'https://playstrategy.org',
    'https://chesstempo.com',
  ]);
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.headers.origin;
    if (origin && !TRUSTED_POST_ORIGINS.has(origin)) {
      const host = req.headers.host;
      if (!host || origin !== `http://${host}`) {
        return res.status(403).json({ error: 'forbidden_origin' });
      }
    }
    next();
  });
}

/**
 * CORS + Private Network Access preflight. Chrome requires a successful
 * OPTIONS preflight with Access-Control-Allow-Private-Network: true
 * before allowing a WebSocket from an HTTPS page to talk to localhost.
 * @param {import('express').Express} app
 * @param {HttpRoutesDeps} deps
 */
function registerCors(app, { config }) {
  const ALLOWED_ORIGINS = new Set([
    `http://localhost:${config.port}`,
    'https://www.chess.com',
    'https://lichess.org',
    'https://playstrategy.org',
    'https://chesstempo.com',
  ]);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
}

/**
 * GET /healthz — backend liveness + a snapshot of engine/book/client
 * state.
 * GET /selfcheck — runs a short canned evaluation so ops can verify
 * the engine pipeline end-to-end.
 * @param {import('express').Express} app
 * @param {HttpRoutesDeps} deps
 */
function registerHealthAndDiagnostics(
  app,
  {
    startedAt,
    pkgVersion,
    getEngine,
    getCurrentEngineType,
    getCurrentVariant,
    eco,
    book,
    getLichessBook,
    getWss,
    bookBaseName,
  },
) {
  app.get('/healthz', (_req, res) => {
    const engine = getEngine();
    const wss = getWss();
    const lichessBook = getLichessBook();
    res.json({
      status: 'ok',
      uptimeMs: Date.now() - startedAt,
      version: pkgVersion,
      engine: {
        ready: !!(engine && engine.ready),
        type: getCurrentEngineType(),
        variant: getCurrentVariant(),
      },
      book: {
        ecoOpenings: eco.size ? eco.size() : 0,
        lichessEnabled: !!(lichessBook && lichessBook.enabled),
        offlineBook: book.enabled ? bookBaseName(book.bookPath) : null,
      },
      clients: wss ? wss.clients.size : 0,
    });
  });

  // Refuses concurrent self-checks so we don't poison a user's active
  // analysis. Plan §10.
  let selfcheckBusy = false;
  app.get('/selfcheck', async (_req, res) => {
    const engine = getEngine();
    if (!engine || !engine.ready) {
      return res.status(503).json({ status: 'engine_not_ready' });
    }
    if (selfcheckBusy) {
      return res.status(503).json({ status: 'busy' });
    }
    selfcheckBusy = true;
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const t0 = Date.now();
    try {
      const result = await engine.evaluate(startFen, 8, { movetime: 1500 });
      res.json({
        status: 'ok',
        elapsedMs: Date.now() - t0,
        depthReached: result.depth || 0,
        bestMove: result.bestmove || result.bestMove || null,
        score: result.score ?? null,
        engineType: getCurrentEngineType(),
      });
    } catch (err) {
      res.status(500).json({ status: 'error', error: String((err && err.message) || err) });
    } finally {
      selfcheckBusy = false;
    }
  });
}

/**
 * GET /api/cache/stats — eval-cache size / capacity / TTL / persistence path.
 * POST /api/cache/clear — empty the in-memory cache, return previous size.
 * @param {import('express').Express} app
 * @param {HttpRoutesDeps} deps
 */
function registerCacheControlEndpoints(app, { evalCache, evalCachePath }) {
  app.get('/api/cache/stats', (_req, res) => {
    res.json({
      size: evalCache.size,
      max: evalCache.max,
      ttlMs: evalCache.ttlMs,
      path: evalCachePath,
    });
  });
  app.post('/api/cache/clear', (_req, res) => {
    const prev = evalCache.size;
    evalCache.clear();
    res.json({ status: 'ok', cleared: prev });
  });
}

/**
 * Serve the Vite-built panel as static assets, preferring dist/ over
 * src/. Cache strategy: HTML must never be cached (the entry point
 * pins the JS/CSS hashes), Vite-emitted hashed assets live forever,
 * everything else gets a revalidate hint.
 * @param {import('express').Express} app
 * @param {HttpRoutesDeps} deps
 */
function registerPanelStatic(app, { panelDir, express, log }) {
  const panelDist = path.join(panelDir, 'dist');
  const panelRoot = fs.existsSync(path.join(panelDist, 'index.html')) ? panelDist : panelDir;
  if (log?.info) {
    log.info(
      `[server] serving panel from ${panelRoot === panelDist ? 'dist (built)' : 'src (dev)'}`,
    );
  } else {
    console.log(
      `[server] serving panel from ${panelRoot === panelDist ? 'dist (built)' : 'src (dev)'}`,
    );
  }
  app.use(
    express.static(panelRoot, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-store');
        } else if (
          /[\\/]assets[\\/].+-[A-Za-z0-9_]{8,}\.(?:js|css|woff2?|png|svg)$/i.test(filePath)
        ) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
      },
    }),
  );
}

module.exports = {
  registerHttpRoutes,
  // Exported for unit tests that want to register a single concern
  // against a fake express app.
  registerOriginGate,
  registerCors,
  registerHealthAndDiagnostics,
  registerCacheControlEndpoints,
  registerPanelStatic,
};
