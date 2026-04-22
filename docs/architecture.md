# Architecture

High-level map of the Chessbot codebase. For product docs see
[`README.md`](../README.md); for the WS wire protocol see
[`protocol.md`](./protocol.md).

## Monorepo layout

```
chessbot/
├── shared/              # Pure, no-I/O helpers + wire protocol schemas
│   └── src/
│       ├── fen.ts       # FEN parsing/validation (variant-aware)
│       ├── messages.ts  # zod schemas for WS frames
│       └── version.ts   # PROTOCOL_VERSION constant
│
├── backend/             # Node + Express + ws + chess.js + Stockfish
│   ├── server.js        # HTTP + WS bootstrap; WS message dispatcher
│   ├── stockfishBridge.js  # UCI process wrapper (single long-lived child)
│   ├── eco.js           # Re-export shim → src/book/eco.js
│   ├── openingBook.js   # Polyglot .bin reader
│   ├── config.js        # zod-validated env loader
│   ├── panel/           # Static dashboard (served by Express)
│   └── src/
│       ├── book/
│       │   ├── eco.js         # ECO TSV → in-memory map
│       │   └── lichess.js     # Lichess explorer HTTP adapter
│       ├── engine/
│       │   ├── uciParser.js   # Pure parser for `info` / `bestmove`
│       │   └── evalCache.js   # LRU + TTL cache keyed by FEN+variant
│       ├── ws/
│       │   ├── send.js        # safeSend + broadcast helpers
│       │   └── rateLimit.js   # per-connection token bucket
│       └── lib/
│           └── logger.js      # pino factory (per-module children)
│
└── extension/           # React popup + Chrome MV3 content script
    └── src/
        └── content/
            ├── content.js         # Monolith (plan §2.1 splits this)
            ├── selectors.js       # chess.com/lichess DOM selector registry
            └── utils/
                ├── timing.js      # debounce/throttle/sleep
                └── logger.js      # [chessbot]-tagged console wrapper
```

Tests live next to source as `*.test.ts` / `*.test.js` and are collected
by a root `vitest.config.ts`. CI runs them on every push (see
`.github/workflows/ci.yml`).

## Runtime data flow

```
chess.com / lichess DOM
         │
         ▼  MutationObserver
 extension/src/content/content.js   ◄─── user settings (localStorage)
         │
         ▼  WebSocket (ws://localhost:8080, JSON frames)
 backend/server.js  ──────► stockfishBridge.js ──► stockfish.exe (UCI)
         │                         ▲
         ▼                         │ evalCache hit avoids child roundtrip
 backend/panel/index.html (Dashboard)
```

The panel and the content script are **separate** WS clients; the
backend fans messages out to all clients.

## Where to start reading

- For a WS protocol change: `shared/src/messages.ts` + `version.ts`.
- For engine tuning: `backend/stockfishBridge.js` + `backend/src/engine/*`.
- For DOM scraping bugs: `extension/src/content/content.js` (see the
  `detect*` family of functions; use `utils/logger.debug` to trace).
- For dashboard rendering: `backend/panel/index.html` (inline until the
  Vite rewrite planned in `plans/improvement-plan.md` §2.1).
