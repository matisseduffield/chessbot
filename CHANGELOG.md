# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The first tagged release will close out the **Unreleased** section below.

## [Unreleased]

### Added

- WebSocket heartbeat (server-side ping/pong every 30 s; reaps clients that miss two pings) so half-open TCP connections no longer leak memory or push broadcasts into dead sockets.
- Eval-cache _depth fallback_: a request for depth `D` now serves any same-position cache entry at depth ≥ `D`, tagging the response with `cachedFromDepth`. Toggling the depth slider down feels instant.
- Site-adapter contract tests for Lichess / PlayStrategy with checked-in HTML fixtures + jsdom; selector-shape regressions on the live site now break a unit test before they reach users.
- `extension/src/content/protocolBanner.js` + `backend/panel/src/protocolBanner.js`: visible banner when the connected backend speaks a different protocol version, replacing the silent `console.warn`. Shared predicate `isProtocolMismatch` lives in `@chessbot/shared`.
- Annotated PGN export in the dashboard: derives real SAN moves from the FEN history via `chess.js` and writes `{[%eval ...]}` comments through `buildAnnotatedPgn` from `@chessbot/shared`. The previous version emitted `1. ...` for every ply.
- Zod-validated popup settings (`extension/src/popupSettings.js`). `enabled` and `displayMode` now go through a typed schema with field-by-field repair so a single bad storage key doesn't drop the rest.
- Server integration test (`backend/server.integration.test.js`) that boots the real backend on an ephemeral port via a fake-Stockfish UCI fixture and exercises every major frame type end-to-end.
- `stockfishBridge` test suite — handshake, evaluate, abort, stop, crash recovery, option whitelist, and configurable timeouts. The hot-path module went from zero coverage to 19 hermetic tests.
- Extension typing scaffold: `extension/tsconfig.json` with `// @ts-check` on 9 helper modules so JSDoc annotations are now type-checked by `tsc -b`.
- Backend tsconfig widened from 5 hand-picked files to `src/**/*.js` (`@ts-check` covers the rest of the surface).

### Changed

- Modularized `backend/server.js` from 1421 → ~990 lines. Extracted concerns:
  - `backend/src/server/fileCache.js` — async background-refreshed engine/books/syzygy scanner.
  - `backend/src/server/httpRoutes.js` — `/healthz`, `/selfcheck`, eval-cache control, panel-static handler with proper Cache-Control.
  - `backend/src/server/evalPipeline.js` — book → cache → engine cascade as a standalone factory so the WS handler is no longer 600 lines deep.
- Graceful shutdown now drains the eval queue and awaits engine exit before letting Node exit. Refuses new `fen` / `switch_variant` / `switch_engine` frames during the grace window.
- `LichessBook` errors now bucket into `timeout` / `http_error` / `parse_error` / `not_found` / `network_error` instead of one anonymous bump of `fetchErrors`.
- `safeSend` logs dropped frames and emits a backpressure warning when the WS send buffer crosses 1 MiB. `broadcast` threads the message type into the log so `bestmove`/`info` no longer show as `<raw>`.
- Eval-cache disk format carries a `CACHE_SCHEMA_VERSION`; mismatched files are dropped on load instead of silently mis-keyed.
- Dashboard sets `Cache-Control: no-store` on HTML, `immutable` on Vite-hashed assets, `must-revalidate` elsewhere — backend upgrades stop stranding users on a stale dashboard.
- `scripts/doctor.mjs` now reports the engine `id name` line ("Stockfish 17", "Fairy-Stockfish 14", …) and warns when the extension manifest version drifts from the backend `package.json`. New `--skip-engine` flag for CI.

### Fixed

- Variant-switch race: `currentVariant` is now snapshotted into the eval-task closure at enqueue time so a result computed under variant A can never be returned tagged as variant B.
- rAF-coalescer dropped final bestmoves: the streaming-eval coalescer no longer routes definitive results, so a final result can't be silently overwritten by a subsequent streaming frame for a new position.
- `chrome.runtime.lastError` swallows in the popup are now wrapped in `consumeLastError(ctx)` and logged with context.
- Windows `format:check` failures: `.gitattributes` declares `eol=lf` for source files so `prettier`'s `endOfLine: lf` rule passes regardless of host `core.autocrlf` settings.
- `PORT=0` (ephemeral) now passes `Zod` validation and is preserved through the `??` default. The "[server] listening on http://..." log reads the actual port via `server.address().port`.
- `panel/index.html` `evalHistory` cap is now a named constant (`EVAL_HISTORY_MAX = 200`) and uses a `while`-loop trim for defense in depth.

### Performance

- rAF-coalesced overlay updates in the extension content script: streaming `info` frames at 5–20 Hz are batched into one repaint per browser frame instead of triggering full SVG geometry math + paint per frame.
- Async file-cache refresher: `fs.existsSync` / `readdirSync` / `readFileSync` replaced with `fs.promises`. A background poller refreshes every 10 s off the request path; the `/healthz` and `list_files` handlers no longer block the event loop on TTL expiry.

### Security

- POST origin gate already in place; this release routes it through the new `httpRoutes.js` so the rule is centralised.
- `LichessBook` parse failures and abort/timeout errors are now distinguished in logs; previously an outage and a malformed response looked identical.

### Tests / Build / CI

- CI matrix expanded to `[ubuntu-latest, windows-latest] × [Node 20, Node 22]`. The `e2e` job runs Playwright on Linux with `apt`-installed Stockfish.
- Dependabot enabled for `npm` and `github-actions` (weekly, grouped by ecosystem family — Vite, Playwright, React, ESLint, TypeScript).
- `npm run doctor -- --skip-engine` runs in the `check` matrix so doctor regressions are caught on every PR.
- Backend `tsconfig.json` `include` widened to `src/**/*.js`. 48 surfaced type errors fixed with JSDoc annotations.
- Extension typecheck integrated into the root `npm run typecheck`.
- `tests/fixtures/fake-stockfish.mjs` — minimal UCI engine for hermetic integration tests.
- `tests/fixtures/lichess/` — checked-in HTML fixtures for Lichess board-reader contract tests.
- `~520` unit + integration tests now pass on every PR (was ~407 at the start of the improvement cycle).

[Unreleased]: https://github.com/matisseduffield/chessbot/commits/main
