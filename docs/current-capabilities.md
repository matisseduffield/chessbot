# Capability baseline and implementation map

This is the pre-implementation audit. The resolved gaps and current behavior are described in
[the training and reliability update](training-reliability-update.md). The findings below remain
as the baseline used to choose the work; they are not all outstanding issues.

Reviewed 27 September 2026 against base `7110989`, with the retained Chess.com snapshot,
WASM helper and build changes. The dashboard and popup have been restored to that base.
This is an implementation and wiring review, not a claim that every external site and
variant has been tested live.

## What the product already is

ChessBot already combines live engine analysis, training, optional move automation and a
configurable dashboard. Training is an existing feature, not something this refresh adds.
The original interface exposes eleven sections: Analysis, Search Limits, Engine, Resources,
Auto-Move, Training, Appearance, Dashboard Layout, Voice, Position and Tools.

| Area              | Existing implementation                                                                                                                                               | Main sources                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board detection   | Chess.com, Lichess, PlayStrategy and ChessTempo readers; board orientation, turn detection, player names/clocks, puzzle and variant detection                         | [content.js](../extension/src/content/content.js), [siteAdapters.js](../extension/src/content/siteAdapters.js), board readers, `turnDetect.js`, `variantDetect.js`, `gameInfo.js` |
| Analysis overlay  | Best move, arrows/square highlights/both, multiple candidate lines, opponent reply, scores, evaluation bar, WDL and optional depth badge                              | [content.js](../extension/src/content/content.js), `boardMath.js`, `evalFormat.js`, `moveText.js`                                                                                 |
| Training          | Three difficulty levels, staged hints, move checking, accuracy/streak/score, sound, visual feedback, optional answer reveal, statistics reset                         | [Training implementation](../extension/src/content/content.js#L3696), [dashboard controls](../backend/panel/index.html#L2845)                                                     |
| Native analysis   | Stockfish/Fairy-Stockfish via UCI, depth/time/node limits, MultiPV, threads, hash, strength, engine/variant switching and cancellation                                | [stockfishBridge.js](../backend/stockfishBridge.js), [server.js](../backend/server.js), `src/engine/`                                                                             |
| Move automation   | Optional auto-move, delay range, optional alternative candidate selection, bullet mode, turn checks, stale-position checks and retry/board-change verification        | [scheduleAutoMove](../extension/src/content/content.js#L5252) and site-specific execution functions above it                                                                      |
| Opening resources | Local Polyglot books, optional Lichess Masters lookup, ECO opening labels                                                                                             | [openingBook.js](../backend/openingBook.js), [lichess.js](../backend/src/book/lichess.js), [eco.js](../backend/src/book/eco.js)                                                   |
| Endgames/cache    | Syzygy engine configuration; persistent bounded evaluation cache, expiry, deeper-result reuse, statistics and clear control                                           | [evalPipeline.js](../backend/src/server/evalPipeline.js), [evalCache.js](../backend/src/engine/evalCache.js)                                                                      |
| Dashboard         | Board preview, selectable PV cards, eval graph/bar, WDL, player bars, opening name, engine progress, FEN copy, themes/pieces/accent, section arrangement and resizing | [index.html](../backend/panel/index.html), [render helpers](../backend/panel/src/panelRender.js), `board.js`, `pvCards.js`, `evalGraph.js`, `evalBar.js`, `playerBars.js`         |
| Popup             | Analysis on/off, connection status, Arrow/Box/Both, dashboard shortcut and log copy                                                                                   | [App.jsx](../extension/src/App.jsx), [popupSettings.js](../extension/src/popupSettings.js)                                                                                        |
| Voice/shortcuts   | Move announcements, optional score/opening speech, speed control and keyboard toggles including training, auto-move and bullet mode                                   | [content.js](../extension/src/content/content.js), [hotkeys.js](../extension/src/content/hotkeys.js)                                                                              |
| Tools             | Basic eval-drop alerts, annotated PGN export, PGN import preview, cache management and diagnostics; limitations below                                                 | [dashboard tools](../backend/panel/index.html#L3164), [pgn.js](../backend/panel/src/pgn.js), [httpRoutes.js](../backend/src/server/httpRoutes.js)                                 |

## How existing training works

The dashboard broadcasts training settings through the backend to the content script;
`Alt+T` also toggles training. The content script stores the last final best move, the FEN
it was computed for and up to three returned candidate lines. The renderer then replaces
the normal final-result overlay with a training hint.

| Difficulty | Initial display                              | Hint progression                         |
| ---------- | -------------------------------------------- | ---------------------------------------- |
| Easy       | Source piece and destination zone            | Full move reveal                         |
| Medium     | Source piece and a question mark             | Destination zone, then full move reveal  |
| Hard       | Subtle board border and “Find the best move” | No hint button or source-piece highlight |

Destination zones depend on the piece: pawn/king can show the destination square,
diagonal movers a diagonal, straight movers rank/file regions, with a file fallback for
other moves. Drop moves have a separate “Drop a piece” path rather than the normal
source-piece hint sequence.

When the board changes, `checkTrainingAccuracy()` applies the stored UCI recommendation
to the stored FEN and compares the resulting piece placement with the observed board.
Strict mode accepts only the best move; non-strict mode additionally accepts the second
or third returned PV when available. It does not automatically request three PVs, so the
default one-PV search provides only one accepted move even with strict mode off.

Correct moves increment the correct count and streak; mistakes reset the streak. The
dashboard shows correct/total, percentage accuracy and streak. Feedback includes a
green/red board flash and optional Web Audio tones. Optional auto-reveal shows the correct
move after a wrong answer, beginning after 600 ms and clearing after another 2.5 seconds.

Training preferences persist in Chrome storage. Counters live in the content script's
memory and are broadcast to the dashboard; this is not a saved learning-history database.
The scheduler explicitly refuses to schedule auto-moves while training is active.

Training judges agreement with the selected recommendation. A recommendation can come
from an opening book as well as an engine, and this is not a centipawn-loss coaching or
natural-language explanation system. The existing voice setting speaks before the
training branch, and streaming responses use ordinary move rendering; either can expose
an answer when enabled. Those are existing integration limitations, left unchanged here.

## Runtime and ownership of state

```text
Website board
  -> content script (board reading, overlays, training, interaction)
  -> Chrome runtime port
  -> background service worker (WebSocket relay)
  -> local Express/WebSocket server
  -> opening resources / evaluation cache / native UCI engine
  -> content overlay and dashboard

Popup -> active-tab messages + Chrome storage
Dashboard -> direct WebSocket -> server options / broadcast content settings
```

- Four npm workspaces: shared TypeScript utilities, backend, dashboard and extension.
- `extension/public/manifest.json` selects site permissions and scripts.
  `extension/public/background.js` owns the extension's socket transport and reconnection.
  Most feature orchestration remains in the large `content.js` and dashboard `index.html`.
- Board changes are detected through observers plus polling and navigation checks. The
  content script filters stale responses, waits through board transitions and coalesces
  streaming overlay work with animation frames. The new bot snapshot supplements these
  existing readers on standard Chess.com `/play/computer` boards only.
- The backend owns one native engine, per-connection evaluation queues, a global
  evaluation lock and variant-generation checks. Settings/results use broad broadcasts;
  multiple open games are not independent isolated engine sessions.
- Dashboard preferences/layout use local storage; extension preferences use Chrome
  storage; engine runtime settings live in the server process. These are distinct stores,
  with dashboard reconnect logic rebroadcasting saved settings.
- The actual inbound protocol is defined in
  [validateMessage.js](../backend/src/ws/validateMessage.js). The shared `messages.ts`
  describes a different, intended protocol and is not the server's runtime validator.

## What produces a recommendation

For standard chess/Chess960 in the first 15 full moves, the backend tries a local book,
then the optional Lichess opening service. A local book chooses the continuation with the
highest combined weight across loaded books; the Lichess service chooses by game count.
These are book choices, not a fresh engine calculation.

Otherwise it checks the evaluation cache and then searches with the native engine.
The cache defaults to 500 entries and a five-minute TTL, persists to disk, and can reuse
a deeper entry for the same FEN, variant and MultiPV request. A native search is bounded
by the configured depth and any active time/node limits, with clock-based caps. The
backend supports infinite analysis but the extension's zero-depth handling has a gap
described below. Search depth does not establish a globally optimal chess move.

Stockfish handles standard chess/Chess960. Other variants require an appropriate
Fairy-Stockfish binary, and large-board variants may need a different build. The menu
contains many variants, but menu presence is not evidence that every reader, board size,
piece representation and move executor is complete for that variant.

## Confirmed gaps and incomplete integration

These findings are recorded for future work. This review does not change their behavior.

| Finding                                                     | Evidence and practical consequence                                                                                                                                                                      | Verification                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- | ----------------------------------- |
| Live engine output toggle is rejected                       | Dashboard sends `set_live_engine_stream`; server has a handler, but the inbound validator omits that type.                                                                                              | Direct validator probe returned `unknown_type`.                        |
| Dashboard book selector payload is rejected                 | Dashboard sends `switch_book.name` as an array; validator accepts only a string or null, despite the handler and book class supporting multiple books.                                                  | Direct array probe returned `invalid_payload`; string control passed.  |
| Book switching retains an old pipeline reference            | `createEvalPipeline()` captures the initial book object; the switch handler closes it and assigns a new object to the server variable.                                                                  | Code tracing; file-backed switch not exercised live.                   |
| Infinite depth does not survive the content setting handler | Both content handlers use `Number(msg.value)                                                                                                                                                            |                                                                        | 15`, converting requested zero into 15. | Direct inspection of both handlers. |
| Streaming/voice can reveal training answers                 | Training's renderer branch requires `!msg.streaming`; ordinary arrows handle streaming frames. Voice announcement happens before the training branch.                                                   | Control-flow review; not a full live training-session test.            |
| Non-strict training depends on returned PVs                 | It checks at most three stored lines but does not raise the engine's MultiPV setting. Book replies can lack candidate lines.                                                                            | Training handler and scoring code traced.                              |
| Drop-move training has a limited hint path                  | The drop branch returns before the ordinary progressive hint button is created.                                                                                                                         | Renderer review.                                                       |
| PGN import is a preview stub                                | Import strips/counts tokens and changes a status label; it does not replay moves, load a game or analyze it.                                                                                            | Import event handler reviewed.                                         |
| PGN export needs contiguous legal history                   | Export reconstructs SAN using chess.js and stops at a gap. Its default start is the standard position; the dashboard does not pass a custom start FEN. Midgame/variant histories are therefore limited. | Caller and `buildPgnFromHistory()` traced; existing unit suite passed. |
| Browser WASM fallback is not integrated                     | Helper and tests exist, but no production caller imports it. Improvements to its cancellation/retry behavior do not make backend-free analysis available.                                               | Production import search plus helper review/tests.                     |
| Flip prompt is not connected                                | A tested prompt helper and persisted override support exist; the production popup has no side-selection control and no production caller uses the prompt helper.                                        | Import/caller search and popup review.                                 |
| Blunder alerts are simpler than the helper library suggests | Dashboard compares successive centipawn updates. Separate classification helpers are not connected to a full per-move game review workflow.                                                             | Dashboard callback and production caller search.                       |

Several README/changelog/plan statements describe intended or partial features as complete.
Use the wiring above when planning changes. In particular, avoid creating another training
mode or replacing the interface to expose functionality that already exists.

## Operations, packaging and verification boundary

The server defaults to loopback and serves the built dashboard, `/healthz`, `/selfcheck`,
cache statistics and cache clearing. It includes WebSocket validation, rate limiting,
heartbeat, protocol-version banners, logging, engine shutdown and recovery. Optional LAN
binding has a PIN/QR flow. The setup and doctor scripts check the environment and engine;
native engine/book/tablebase files remain external resources.

CI includes unit/type/lint/build checks on Linux and Windows plus Chromium dashboard smoke
tests on Linux. An Inno Setup installer workflow exists, but its code-signing step is
disabled and its installer was not built or certified during this review.

Current local verification: **733 tests passed, 6 skipped on Windows**; the skipped tests
are the platform-gated fake-executable server integration tests. Type checking passed
(the dashboard workspace itself reports that it has no typecheck). The restored dashboard
and popup sources match base `7110989` exactly. See
[refresh validation](bot-refresh-validation.md) for the retained patch's browser/build checks.
The whole training session, every site/variant and auto-move execution have not all been
tested live; code understanding and a passing helper suite are distinct from that coverage.
