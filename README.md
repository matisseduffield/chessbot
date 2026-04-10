# Chess Analysis Helper

Real-time chess analysis overlay for online chess sites. A Chrome extension reads the board from the page, sends positions to a local Stockfish backend, and draws best-move arrows directly on the board.

## Supported Sites

| Site | Live Games | Puzzles | Variants |
|------|:----------:|:-------:|:--------:|
| [chess.com](https://www.chess.com) | ✅ | ✅ | ✅ |
| [lichess.org](https://lichess.org) | ✅ | ✅ | ✅ |
| [playstrategy.org](https://playstrategy.org) | ✅ | — | ✅ |
| [chesstempo.com](https://chesstempo.com) | ✅ | ✅ | — |

## Features

### Board Analysis
- **Best-move arrows** — green (engine), gold (opening book), blue (Lichess Masters DB)
- **Multi-PV display** — up to 8 colored candidate lines with eval badges; **red arrows and badges** for losing lines so bad moves are instantly obvious
- **Score formatting** — `+M2` (you deliver mate) vs `−M2` (you're getting mated) with green/red coloring
- **Eval bar** — real-time evaluation bar alongside the board (left side normally, right side for drop variants so it doesn't overlap the pocket)
- **WDL bar** — full-width Win/Draw/Loss percentage bar below the board on the panel with labeled segments
- **Opponent response arrows** — see the likely opponent reply after the best move
- **Infinite analysis mode** — set depth to 0 for unlimited depth streaming analysis
- **Endgame tablebase classification** — Win/Draw/Loss labels on the eval bar when ≤7 pieces remain
- **Display modes** — arrows, boxes, or both
- **Eval caching** — positions cached for 5 minutes (up to 500 entries) to avoid re-analysis

### Auto-Move (Bot Mode)
- **Automatic move execution** — the bot plays the engine's best move on the board for you
- **Humanization** — configurable random delays (min/max ms), occasional selection of 2nd/3rd best move, and premove-style timing to mimic human play
- **Humanization chance** — 0–50% probability slider for picking suboptimal moves
- **Per-site support** — works on chess.com (shadow DOM events), lichess.org (chessground pointer events), playstrategy.org, and chesstempo.com
- **Dashboard controls** — toggle auto-move on/off, adjust delay range and humanization settings from the panel

### Opening Books & Databases
- **Multiple opening books** — select one or more Polyglot `.bin` books simultaneously with merged weight lookups
- **Lichess Masters DB** — query the Lichess opening explorer for master-level game moves (rate-limited, 5s timeout)
- **ECO classification** — Encyclopedia of Chess Openings lookup; opening names shown in the dashboard and panel

### Training Mode
- **Progressive 3-stage hints** — piece to move → destination zone → full move reveal
- **Difficulty levels** — Easy (skips to zone hint), Medium (shows piece hint first), Hard (piece hint only, no hint button)
- **Accuracy tracking** — correct/total percentage, consecutive streak counter with 🔥 indicator
- **Audio feedback** — optional sound effects for correct/incorrect moves
- **Strict mode** — only accepts the exact top engine move
- **Auto-reveal** — automatically shows the correct move after the player's attempt
- **Puzzle page auto-detection** — activates analysis on chess.com puzzle/lesson pages and lichess training pages

### Variant Chess Support

70+ variants supported via Fairy-Stockfish automatic engine switching:

| Category | Variants |
|----------|----------|
| **Standard** | Chess, Chess960 |
| **Popular** | Atomic, Crazyhouse, King of the Hill, Three-Check, Five-Check, Antichess, Horde, Racing Kings |
| **Drop Variants** | Crazyhouse, Bughouse, Chessgi, S-House, Loop, Pocket Knight, Shogun, Grandhouse, Placement |
| **Chess Variants** | Almost Chess, Amazon Chess, Armageddon, Chigorin, Codrus, Coregal, Extinction, Giveaway, Grasshopper Chess, Hoppel-Poppel, Kinglet, Knightmate, Koedem, Losers, New Zealand, Nightrider Chess, No Castling, Seirawan (S-Chess), Suicide Chess, Three Kings |
| **Regional/Historical** | Ai-Wok, ASEAN Chess, Cambodian Chess, Chaturanga, Kar Ouk, Makpong, Makruk, Shatar, Shatranj, Sittuyin |
| **Shogi** | Dobutsu Shogi, Euro Shogi, Goro Goro Shogi, Judkins Shogi, Kyoto Shogi, Minishogi, Tori Shogi |
| **Mini Games** | Gardner's Minichess, Los Alamos Chess, Micro Chess, Mini Chess, Mini Xiangqi |
| **Other** | Ataxx, Breakthrough, Clobber |

Drop variants feature full pocket piece detection and drop-move suggestions with animated visual indicators showing the piece type and target square.

### Engine & Tablebases
- **Stockfish + Fairy-Stockfish** — auto-switches engine based on detected variant
- **Settings preserved across engine switches** — Threads, Hash, MultiPV persist
- **Syzygy endgame tablebases** — perfect endgame play when configured (≤7 pieces)
- **Depth control** — 0 (infinite) to 30 ply; scales eval timeout dynamically up to 3 minutes for deep searches
- **Search limits** — optional time (100ms–30s) and node limits; best move at reached depth shown if time cuts search short
- **Core settings** — Threads (1–16), Hash (16–1024 MB), Skill Level (0–20), Clear Hash

### Voice & Accessibility
- **Text-to-speech move announcements** — hear the best move spoken aloud via Web Speech API
- **Voice speed control** — 0.5×–2× adjustable speech rate
- **Eval announcements** — optionally speak the evaluation score
- **Opening announcements** — optionally speak the detected opening name
- **Repetition prevention** — same move/opening not announced twice in a row

### Dashboard Panel
Full settings UI at `http://localhost:8080` with three settings columns:

**Analysis**
- Variant picker (searchable, grouped dropdown)
- Depth slider (0–30)
- Multi-PV slider (1–8)
- Analyze for Me / Opponent / Both
- Time limit toggle & slider
- Node limit toggle & input
- Current FEN display

**Engine & Training**
- Engine selector (auto-populated from `engine/` directory)
- Threads, Hash, Skill Level controls
- Clear Hash button
- Training mode toggle with difficulty picker
- Training stats (accuracy %, streak 🔥, score)
- Training options (auto-reveal, sound, strict mode)

**Display & Automation**
- Auto-move toggle with delay range (min/max ms)
- Humanization toggle & chance slider (0–50%)
- Voice toggles (voice, speak eval, speak opening) & speed slider
- Eval bar toggle
- PV cards toggle
- Opponent response toggle
- Display mode (Arrow / Box / Both)
- Opening book multi-select
- Lichess Masters DB toggle
- Syzygy tablebase selector

**Panel Board View**
- Live SVG board preview with piece rendering
- PV cards with rank, score, move sequence, source badge, depth indicator, nodes/NPS
- Green tint for winning lines, red tint + border for losing lines
- ECO opening label below the board

### Connection & Navigation
- **Auto-reconnect** — resilient WebSocket connection with exponential backoff (3s → 30s max) and automatic position resend
- **SPA navigation detection** — handles chess.com and lichess page transitions without losing state
- **Variant re-detection** — re-detects variant on page navigation and notifies the server to switch engines

### Hotkeys

| Hotkey | Action |
|--------|--------|
| `Alt+A` | Resume analysis |
| `Alt+S` | Stop analysis |
| `Alt+W` | Analyze for Me |
| `Alt+Q` | Analyze for Opponent |
| `Alt+T` | Toggle Training Mode |
| `Alt+M` | Toggle Auto-Move |

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

## Prerequisites

- **Node.js** 18+
- **Stockfish** binary (any UCI-compatible engine)
- **Google Chrome** (or Chromium-based browser)

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/matisseduffield/chessbot.git
cd chessbot
```

### 2. Download Stockfish

Download a Stockfish binary from [stockfishchess.org/download](https://stockfishchess.org/download) and place it in the `engine/stockfish/` directory. For variant chess support, also download [Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish/releases):

```
engine/
  stockfish/
    stockfish-windows-x86-64-avx2.exe   # Standard chess
  fairy-stockfish/
    fairy-stockfish-largeboard_x86-64-bmi2.exe  # Variant chess
```

The server auto-detects engines in `engine/`. You can switch between them from the dashboard.

### 3. (Optional) Opening books

Place one or more Polyglot `.bin` opening books in the `books/` directory:

```
books/
  Perfect2023.bin
  Cerebellum.bin
```

Multiple books can be selected simultaneously from the dashboard. The server auto-detects `.bin` files. Set `OPENING_BOOK_PATH` to override the default.

### 4. (Optional) Syzygy tablebases

Place Syzygy tablebase files (`.rtbw`, `.rtbz`) in the `syzygy/` directory for perfect endgame play.

### 5. Install backend dependencies

```bash
cd backend
npm install
```

### 6. Build the Chrome extension

```bash
cd extension
npm install
npm run build
```

### 7. Load the extension in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/dist` folder

### 8. Start the backend server

```bash
cd backend
node server.js
```

The server starts on `http://localhost:8080`. Open this URL in a browser tab to access the settings dashboard.

## Usage

1. Start the backend server
2. Open a game on any supported site (chess.com, lichess.org, playstrategy.org, chesstempo.com)
3. The extension automatically connects and shows best-move arrows
4. Click the extension popup icon to toggle analysis on/off
5. Open `http://localhost:8080` to adjust engine settings

## Configuration

All settings can be changed at runtime via the dashboard panel. Environment variables for initial config:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Server port |
| `STOCKFISH_PATH` | Auto-detect in `engine/` | Path to Stockfish binary |
| `OPENING_BOOK_PATH` | Auto-detect in `books/` | Path to Polyglot `.bin` book |
| `SYZYGY_PATH` | `syzygy/` | Path to Syzygy tablebase directory |
| `ENGINE_DIR` | `engine/` | Directory to scan for engine binaries |
| `BOOKS_DIR` | `books/` | Directory to scan for opening books |
| `SYZYGY_DIR` | `syzygy/` | Directory to scan for tablebases |

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
│   └── dist/                # Built extension (load this in Chrome)
├── engine/                  # Stockfish binaries (gitignored)
├── books/                   # Opening books (gitignored)
└── syzygy/                  # Endgame tablebases (gitignored)
```

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE.md). See the [LICENSE.md](LICENSE.md) file for details.
