# Training and reliability update

This update extends the existing training mode and preserves the original dashboard and popup. It adds a compact board selector in Position and a collapsed Mistake review section in Training. The existing sites, bot/game/puzzle routes, Fairy-Stockfish selection and variant notation remain supported by the code.

## Controls and training

- Streaming and Lichess explorer controls use the real shared protocol. Settings acknowledgements are correlated with requests; failures refresh the controls from the server.
- Book selection is read at evaluation time. Failed book loads retain the previous book. Depth zero remains infinite analysis for the focused board when no finite budget applies.
- Training uses engine analysis rather than book suggestions. Non-strict mode requests at least three candidate lines while preserving normal MultiPV settings. Strict mode still accepts only the first move.
- Streaming, queued overlay frames and voice cannot reveal the answer before a hint reveal. Delayed training feedback and autoplay are cancelled when the position, mode, connection or page changes.
- Standard-chess grading requires exactly one legal player move. Opponent replies, takebacks and incomplete board transitions do not count. Variant transitions whose rules are not verified remain explicitly ungraded. Drop hints have a reveal control without assuming a source square.

## Sessions and engine ownership

Each extension tab/frame has a session identifier. Replies carry that identifier plus a request identifier. The dashboard follows the focused board or can be pinned to another open board. Engine results never broadcast into another board's content script.

One scheduler serializes searches, option changes, engine switches and review work. Pending positions replace older pending work for that session. Live foreground analysis takes priority over background analysis and review; background and training searches receive a finite time budget. Cancellation waits for the previous owner to release the engine.

Cache keys include binary identity, engine options, variant, MultiPV and search budgets. A time-limited result is stored at its achieved depth, not its requested depth. The dashboard labels cached results. This is engine analysis at the reported search depth, not a mathematical proof of the best possible chess move.

## Local mistake review

The backend stores at most 500 attempts and statistics for 50 sessions in `training-history.json` beside the evaluation cache (or under `CHESSBOT_DATA_DIR`). It records positions, move/recommendation, site, variant, assisted status, time and feedback; no chess account credentials are involved.

Post-move feedback evaluates the before/after positions from the same player's perspective with depth 15 and a 1,500 ms limit per position. It reports achieved depths and labels evaluation loss as estimated. Mate transitions are shown explicitly instead of converted into a centipawn loss. Interrupted reviews are marked unavailable. Unsupported variant evaluation interpretations are marked ungraded.

Review position changes only the dashboard preview. Return to live board restores the newest live result. Deleting an attempt or clearing history does not reset aggregate statistics; Reset Stats remains a separate action. Assisted and unassisted attempts are counted separately.

Review controls use the existing dashboard colours, typography, borders and spacing. Saved history has a bounded scrolling list and a filter for mistakes/ungraded moves or all attempts, including correct moves. Each row separates its outcome, moves, evaluation and actions. History remains available without an open chess board. Deletion asks for confirmation and preserves statistics; deleting the currently previewed attempt returns the dashboard to live analysis.

A banner above the board identifies a saved-position preview and provides Return to live board. Saved lines are labelled SAVED. The live position, player details and orientation continue to update in the background and are restored on return. A disconnected pinned board keeps its selector available so the dashboard can follow another board. Narrow dashboard columns wrap the existing visibility toggles instead of spilling into adjacent columns.

## Maintenance and verification

The shared package now defines the actual client message contract, including bounded variant FEN and move notation, rather than a separate unused protocol. Protocol version is **2**: reload both the backend and extension together.

Board replacement reuses one observer setup. Geometry caching includes board identity and screen position. The service worker owns WebSocket reconnects; the content script replaces its runtime port only if that port disconnects. Page suspension cancels work and observers, and restoration reconnects.

Regression coverage includes actual backend WebSocket sessions, engine scheduling, cache depth/identity, training timers and legal transitions, persistent history, score perspective, session isolation, and local-only review. The installed MV3 Chromium test uses local Chess.com and Lichess fixtures, the real service worker/content worlds and native Stockfish. It does not interact with a real chess account.

Run `node scripts/benchmark-scheduler.mjs` for the bounded-work workload: 1,000 queued positions for one busy session retain one pending search and cancel 999 obsolete requests. Elapsed time is machine-specific scheduler overhead, not an engine-speed benchmark. Browser bundle size increases because legal transition validation uses chess.js; no blanket CPU or memory speedup is claimed.

Full PGN replay/import, browser-only WASM integration, new variants and installer certification remain outside this update. A live fixture test is not a guarantee that every third-party site layout or Fairy-Stockfish variant has been tested in a real game.
