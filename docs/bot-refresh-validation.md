# Bot-board compatibility refresh

Validated on Windows with Node 24.18.0 and official Stockfish 19, 27 September 2026.

## Changes

- On standard Chess.com computer boards, a small MAIN-world script reads only the game position, player side, orientation and game-over flag. The isolated content script validates a bounded, fresh DOM snapshot before using it. Other pages and variants retain the existing readers.
- Complete FEN metadata survives midgame loads, including lost castling rights and en passant. Manual board orientation and player color are distinct; explicit player-side overrides retain priority.
- The original dashboard and popup are retained byte-for-byte in Git against base `7110989`, including existing training mode and settings. See [current capabilities](current-capabilities.md) for the runtime review.
- The optional WASM helper rejects cancelled searches, isolates new requests from old worker messages, times out hung workers and permits retry after startup failure.
- The root build compiles the dashboard once. Node requirements match the existing build dependencies. Windows setup guidance points to the official universal engine build.

## Verification

- Full unit suite: 733 passed, 6 skipped. The skipped tests are the existing fake-executable server integration tests on Windows.
- Type checking, ESLint (zero errors; 26 existing warnings), production build and diff whitespace checks passed.
- Live Chess.com bot-board snapshot exactly matched the site's FEN and orientation.
- The production content bundle ran in a temporary isolated browser world with a test transport replacing Chrome's runtime port. Its emitted FEN went to the real local backend; the real response rendered the e2-e4 hint, score and c7-c5 reply correctly. No game moves were made.
- Native backend WebSocket checks returned a legal starting move and the forced Qh4 mate in Fool's Mate at depth 12. Captured bot-board analysis completed at depth 15.
- The restored dashboard and popup were visually inspected in Chrome. No responsive redesign is included.

## Limits and installation

This is a bot-board compatibility refresh, not certification of every existing site, variant or automation mode. Chess.com's internal game getters are undocumented. The optional WASM helper remains separate from the unfinished fallback integration. Search depth is evidence of search effort, not a proof of a globally optimal chess move.

The Chrome extension was built and tested with a development transport, not installed through Chrome's extension manager. After building, load or reload `extension/dist` in `chrome://extensions`, then refresh the bot tab. The standalone popup preview confirms the original appearance and localhost connection indicator; active-tab controls still require the installed extension.

Run `npm run setup:engine` to check your binary, `npm run build` to build the dashboard and extension, then `npm start`. Open `http://localhost:8080` for the dashboard. This checkout has an official Stockfish binary in the ignored `engine/stockfish` directory; engine binaries are not included in Git.
