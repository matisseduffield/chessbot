# Chess Analysis Helper

Chrome extension + local backend for live chess analysis on supported web boards. The
extension reads the current position from the page, streams it to a local
Stockfish/Fairy-Stockfish server, and overlays engine guidance directly on the board while
also exposing a dashboard at `http://localhost:8080`.

![Dashboard Overview](screenshots/dashboard.png?v=2)

## Supported sites

| Site | Live games | Puzzles / training | Variants |
| --- | :---: | :---: | :---: |
| [chess.com](https://www.chess.com) | ✅ | ✅ | ✅ |
| [lichess.org](https://lichess.org) | ✅ | ✅ | ✅ |
| [playstrategy.org](https://playstrategy.org) | ✅ | — | ✅ |
| [chesstempo.com](https://chesstempo.com) | ✅ | ✅ | — |

## Highlights

- **Live analysis overlay** - best-move arrows, Multi-PV lines, eval badges, eval bar, WDL,
  opponent replies, and optional infinite analysis.
- **Automation and training** - auto-move, bullet mode, progressive hint stages, accuracy and
  streak tracking, hotkeys, and optional voice announcements.
- **Books and endgames** - Polyglot opening books, Lichess Masters lookups, ECO naming,
  Syzygy tablebases, and a persistent evaluation cache.
- **Variant support** - standard chess, Chess960, and many Fairy-Stockfish variants including
  Atomic, Crazyhouse, King of the Hill, Three-check, Horde, Racing Kings, Makruk, and more.
- **Local dashboard and popup** - runtime settings, cache tools, PGN import/export, blunder
  alerts, and connection controls.

## Architecture

```text
┌────────────────────────┐      WebSocket / HTTP      ┌──────────────────────┐
│ Chrome extension       │ ─────────────────────────► │ Node.js backend      │
│ - content script       │                            │ - Express + ws       │
│ - popup UI             │ ◄───────────────────────── │ - Stockfish bridge   │
└────────────────────────┘                            │ - books / Syzygy     │
          │                                           └──────────┬───────────┘
          │                                                      │
          ▼                                                      ▼
  Supported chess sites                                  Dashboard at :8080
```

## Workspace layout

| Path | Purpose |
| --- | --- |
| `shared\` | Shared TypeScript utilities, FEN / PGN helpers, WS schemas |
| `backend\` | Local HTTP + WebSocket server, engine bridge, book / cache logic |
| `backend\panel\` | Vite-built dashboard served by the backend |
| `extension\` | Chrome MV3 extension: popup UI and board overlay content script |
| `tests\e2e\` | Playwright smoke tests against the local dashboard |
| `docs\` | Architecture, protocol, installer, and fallback notes |

## Requirements

- **Node.js 20+**
- **Chrome or another Chromium-based browser**
- **Stockfish binary** for standard chess
- **Fairy-Stockfish binary** for non-standard variants
- Optional: **Polyglot opening books** in `books\` and **Syzygy tablebases** in `syzygy\`

## Quick start

### 1. Install dependencies

```powershell
git clone https://github.com/matisseduffield/chessbot.git
cd chessbot
npm install
```

### 2. Add engine binaries (required)

**The repo does not ship Stockfish or Fairy-Stockfish — you must download them yourself.**
Without them the backend will exit on startup with an `ENOENT` error.

The fastest path is to run:

```powershell
npm run setup:engine
```

This prints the recommended download URL for your OS and verifies any binary you've already
placed in `engine\stockfish\`. Manual steps:

1. Download Stockfish from <https://stockfishchess.org/download/> (and Fairy-Stockfish from
   <https://fairy-stockfish.github.io/> if you want non-standard variants).
2. Drop the binaries into `engine\` so the layout matches the Windows defaults below:

```text
engine\
  stockfish\
    stockfish-windows-x86-64-avx2.exe
  fairy-stockfish\
    fairy-stockfish_x86-64-bmi2.exe
```

On macOS / Linux, just drop the platform-appropriate binary into the same folder — the backend
auto-detects any file starting with `stockfish` (and `chmod +x` it after extracting).

If your binaries live elsewhere or use different filenames, copy `.env.example` to `.env` and
set `STOCKFISH_PATH` / `FAIRY_STOCKFISH_PATH`.

> **Tip.** Run `npm run doctor` at any time to verify your Node version, shared build, engine
> binary, and that port 8080 is free.

### 3. Optional resources

- Put `.bin` Polyglot books in `books\`
- Put `.rtbw` / `.rtbz` Syzygy files in `syzygy\`

### 4. Build the workspace

```powershell
npm run build
```

This builds the shared package, dashboard, and unpacked extension output.

### 5. Start the local backend

```powershell
npm start
```

The backend listens on `http://localhost:8080`, serves the dashboard, and accepts extension
connections from supported sites. The root `npm start` script also rebuilds the shared package
first, so it works on a clean checkout.

> If you prefer to target the workspace explicitly, you can also run
> `npm start --workspace backend`.

### 6. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `extension\dist`

### 7. Open a supported board

Visit one of the supported sites, start a game or puzzle, and open
`http://localhost:8080` for the full dashboard.

## Development

### Root commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Build all workspaces that expose a build script |
| `npm run lint` | Run ESLint across the repository |
| `npm run test` | Run the Vitest suite from `config\vitest.config.ts` |
| `npm run e2e` | Run Playwright smoke tests against the backend dashboard |
| `npm run typecheck` | Type-check the root TS build and backend project |
| `npm run format` | Apply Prettier formatting |
| `npm run format:check` | Check formatting without writing changes |

### Common workspace workflows

```powershell
npm start
npm run dev --workspace @chessbot/panel
npm run build --workspace extension
npm run dev --workspace extension
```

- `npm start` builds `@chessbot/shared` and runs the backend on `http://localhost:8080`
- `@chessbot/panel` runs a Vite dev server on `http://localhost:5174` and proxies API / WS
  traffic to the backend
- `extension build` refreshes the unpacked extension assets in `extension\dist`
- `extension dev` starts the popup Vite server for popup-only UI work

## Diagnostics

Run `npm run doctor` from the repo root to verify your Node version, shared build, Stockfish
binary, and that port 8080 is free. The script prints actionable hints for anything that fails.

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Backend status, engine readiness, book state, connected clients |
| `GET /selfcheck` | Short canned engine evaluation for end-to-end verification |
| `GET /api/cache/stats` | Eval cache size, capacity, TTL, and persistence path |
| `POST /api/cache/clear` | Clear the eval cache |

## Configuration

Most runtime settings live in the dashboard. For startup-time configuration, copy `.env.example`
to `.env` in the repo root.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Backend HTTP / WS port |
| `BIND_HOST` | `127.0.0.1` | Address to bind to. Set to `0.0.0.0` for LAN access (see `docs\streaming.md`) |
| `LOG_LEVEL` | `info` | `fatal` / `error` / `warn` / `info` / `debug` / `trace` / `silent` |
| `ENGINE_DIR` | `engine\` | Directory scanned for engine binaries |
| `BOOKS_DIR` | `books\` | Directory scanned for Polyglot books |
| `SYZYGY_DIR` | `syzygy\` | Directory scanned for tablebase folders |
| `STOCKFISH_PATH` | auto-detect | Explicit Stockfish binary path |
| `FAIRY_STOCKFISH_PATH` | auto-detect | Explicit Fairy-Stockfish binary path |
| `OPENING_BOOK_PATH` | first `.bin` in `BOOKS_DIR` | Explicit opening-book path |
| `SYZYGY_PATH` | `syzygy\` | Value passed to the engine `SyzygyPath` UCI option |
| `CHESSBOT_DATA_DIR` | `%USERPROFILE%\.chessbot` | Directory used for persistent eval-cache data |

## Hotkeys

| Hotkey | Action |
| --- | --- |
| `Alt+A` | Resume analysis |
| `Alt+S` | Stop analysis |
| `Alt+W` | Analyze for Me |
| `Alt+Q` | Analyze for Opponent |
| `Alt+T` | Toggle Training Mode |
| `Alt+M` | Toggle Auto-Move |
| `Alt+B` | Toggle Bullet Mode |

## Related docs

- `docs\architecture.md`
- `docs\protocol.md`
- `docs\installer.md`
- `docs\wasm-fallback.md`
- `docs\streaming.md` — keeping the dashboard off-stream

## License

Licensed under the [GNU General Public License v3.0](LICENSE.md).
