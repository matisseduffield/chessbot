# Chess Analysis Helper

Real-time chess analysis overlay for online chess sites. A Chrome extension reads the board, sends positions to a local Stockfish backend, and draws best-move arrows directly on the board.

![Dashboard Overview](screenshots/dashboard.png)

## Supported Sites

| Site | Live Games | Puzzles | Variants |
|------|:----------:|:-------:|:--------:|
| [chess.com](https://www.chess.com) | ✅ | ✅ | ✅ |
| [lichess.org](https://lichess.org) | ✅ | ✅ | ✅ |
| [playstrategy.org](https://playstrategy.org) | ✅ | — | ✅ |
| [chesstempo.com](https://chesstempo.com) | ✅ | ✅ | — |

## Features

### Board Analysis

![Best-move arrows on Chess.com](screenshots/arrows.png)

- **Best-move arrows** — green (engine), gold (opening book), blue (Lichess Masters DB); **red arrows** for losing lines
- **Multi-PV** — up to 8 candidate lines with eval badges, depth, nodes/NPS
- **Eval bar & WDL bar** — real-time evaluation alongside the board, plus Win/Draw/Loss percentage bar in the panel
- **Opponent response arrows** — see the likely opponent reply after the best move
- **Infinite analysis** — set depth to 0 for unlimited streaming analysis
- **Eval caching** — positions cached for 5 min (up to 500 entries) to avoid re-analysis

### Auto-Move (Bot Mode)

![Auto-move settings](screenshots/auto-move.png)

- **Automatic move execution** — plays the engine's best move on the board for you
- **Humanization** — configurable random delays (min/max ms) and 0–50% chance of picking a suboptimal move
- **Bullet mode** — zero delay, no humanize, fast 500ms search limit for blitz/bullet
- Works on all supported sites via native DOM events

### Opening Books & Endgame Tables

- **Multiple Polyglot books** — select one or more `.bin` books simultaneously with merged weight lookups
- **Lichess Masters DB** — query the Lichess opening explorer for master-level moves
- **ECO classification** — opening names shown in the dashboard
- **Syzygy tablebases** — perfect endgame play when ≤7 pieces remain

### Training Mode

![Training mode](screenshots/training.png)

- **Progressive 3-stage hints** — piece to move → destination zone → full move reveal
- **Difficulty levels** — Easy, Medium, Hard
- **Accuracy tracking** — correct/total %, streak counter with 🔥 indicator
- **Audio feedback** — optional sound effects for correct/incorrect moves

### 70+ Chess Variants

![Variant picker](screenshots/variants.png)

Automatic engine switching between Stockfish and Fairy-Stockfish based on the selected variant.

| Category | Variants |
|----------|----------|
| **Standard** | Chess, Chess960 |
| **Popular** | Atomic, Crazyhouse, King of the Hill, Three-Check, Five-Check, Antichess, Horde, Racing Kings |
| **Drop** | Crazyhouse, Bughouse, Chessgi, S-House, Loop, Pocket Knight, Shogun, Grandhouse, Placement |
| **Regional** | Makruk, Shatar, Shatranj, Sittuyin, Cambodian Chess, and more |
| **Shogi** | Minishogi, Judkins Shogi, Kyoto Shogi, Tori Shogi, and more |
| **Other** | Ataxx, Breakthrough, Clobber, Los Alamos, Micro Chess, and more |

Drop variants feature full pocket piece detection and drop-move suggestions with animated indicators.

### Dashboard Panel

![Dashboard settings panel](screenshots/settings.png)

Full settings UI at `http://localhost:8080` with a live board preview and three settings columns. All slider values are clickable for direct keyboard input.

**Column 1 — Analysis:** Variant picker, depth (0–30), multi-PV (1–8), analyze for me/opponent/both, time & node limits, FEN display.

**Column 2 — Engine & Training:** Engine selector, threads (1–16), hash (16–1024 MB), skill level (0–20), training mode with stats.

**Column 3 — Display & Automation:** Auto-move with humanization, voice controls, eval bar/PV toggles, display mode, opening books, Syzygy tablebases.

### Extension Popup

![Chrome popup](screenshots/popup.png)

Quick-access popup for toggling analysis on/off, checking connection status, switching display modes, and opening the dashboard.

### Voice & Accessibility

- **Text-to-speech** — hear the best move spoken aloud via Web Speech API
- **Configurable speed** — 0.5×–2× speech rate
- **Eval & opening announcements** — optionally speak the evaluation score and opening name

### Hotkeys

| Hotkey | Action |
|--------|--------|
| `Alt+A` | Resume analysis |
| `Alt+S` | Stop analysis |
| `Alt+W` | Analyze for Me |
| `Alt+Q` | Analyze for Opponent |
| `Alt+T` | Toggle Training Mode |
| `Alt+M` | Toggle Auto-Move |
| `Alt+B` | Toggle Bullet Mode |

## Architecture

```
┌───────────────────┐     WebSocket     ┌──────────────────┐
│  Chrome Extension │ ◄──────────────►  │   Node.js Server │
│  (content script) │   ws://localhost  │   (port 8080)    │
│                   │      :8080        │                  │
│ • reads board DOM │                   │ • Stockfish UCI  │
│ • draws arrows    │                   │ • opening book   │
│ • turn detection  │                   │ • ECO database   │
│ • FEN conversion  │                   │ • Syzygy tables  │
└───────────────────┘                   └──────────────────┘
        ▲                                       ▲
        │                                       │
        ▼                                       ▼
┌───────────────────┐                   ┌──────────────────┐
│  Extension Popup  │                   │  Dashboard Panel │
│  (toggle + logs)  │                   │  (localhost:8080)│
└───────────────────┘                   └──────────────────┘
```

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/matisseduffield/chessbot.git
cd chessbot
cd backend && npm install
cd ../extension && npm install && npm run build
```

### 2. Download engines

Place engine binaries in the `engine/` directory:

```
engine/
  stockfish/
    stockfish-windows-x86-64-avx2.exe
  fairy-stockfish/
    fairy-stockfish-largeboard_x86-64-bmi2.exe
```

Download from [stockfishchess.org](https://stockfishchess.org/download) and [Fairy-Stockfish releases](https://github.com/fairy-stockfish/Fairy-Stockfish/releases).

### 3. (Optional) Add resources

- **Opening books** — place `.bin` Polyglot books in `books/`
- **Syzygy tablebases** — place `.rtbw`/`.rtbz` files in `syzygy/`

### 4. Load the extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `extension/dist`

### 5. Start the server

```bash
cd backend
node server.js
```

### 6. Play

Open a game on any supported site. The extension auto-connects and shows best-move arrows. Open `http://localhost:8080` for the full settings dashboard.

## Configuration

All settings are adjustable at runtime from the dashboard. Environment variables for initial config:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Server port |
| `STOCKFISH_PATH` | Auto-detect | Path to Stockfish binary |
| `OPENING_BOOK_PATH` | Auto-detect | Path to Polyglot book |
| `SYZYGY_PATH` | `syzygy/` | Syzygy tablebase directory |
| `ENGINE_DIR` | `engine/` | Engine binary directory |
| `BOOKS_DIR` | `books/` | Opening books directory |
| `SYZYGY_DIR` | `syzygy/` | Tablebases directory |

## Project Structure

```
chessbot/
├── backend/
│   ├── server.js            # HTTP + WebSocket server
│   ├── stockfishBridge.js   # UCI engine communication
│   ├── openingBook.js       # Polyglot book reader
│   ├── eco.js               # ECO opening database
│   ├── config.js            # Configuration
│   ├── eco/                 # TSV opening classification files
│   └── panel/index.html     # Dashboard UI
├── extension/
│   ├── src/
│   │   ├── content/
│   │   │   ├── content.js   # Board reader + overlay renderer
│   │   │   └── content.css  # Overlay styles
│   │   ├── App.jsx          # Popup UI
│   │   └── main.jsx         # Popup entry point
│   ├── public/
│   │   └── manifest.json    # Chrome MV3 manifest
│   └── dist/                # Built extension (load in Chrome)
├── engine/                  # Engine binaries
├── books/                   # Opening books
├── syzygy/                  # Endgame tablebases
└── screenshots/             # README images
```

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE.md). See the [LICENSE.md](LICENSE.md) file for details.
