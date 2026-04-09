# Chess Analysis Helper

Real-time chess analysis overlay for **chess.com** and **lichess.org**. A Chrome extension reads the board from the page, sends positions to a local Stockfish backend, and draws best-move arrows directly on the board.

## Features

### Board Analysis
- **Best-move arrows** — green (engine), gold (opening book), blue (Lichess Masters DB)
- **Multi-PV display** — colored candidate lines with eval badges; **red arrows and badges** for losing lines so bad moves are instantly obvious
- **Score formatting** — `+M2` (you deliver mate) vs `−M2` (you're getting mated) with green/red coloring
- **Eval bar** — real-time evaluation bar alongside the board with WDL (win/draw/loss) percentages
- **Opponent response arrows** — see the likely opponent reply after the best move
- **Infinite analysis mode** — set depth to 0 for unlimited depth streaming analysis
- **Endgame tablebase classification** — Win/Draw/Loss labels on the eval bar when ≤7 pieces remain
- **Display modes** — arrows, boxes, or both

### Opening Books & Databases
- **Multiple opening books** — select one or more Polyglot `.bin` books simultaneously with merged weight lookups
- **Lichess Masters DB** — query the Lichess opening explorer for master-level game moves
- **ECO classification** — opening names shown in the dashboard

### Training & Puzzles
- **Training mode** — progressive 3-stage hints (origin square → target file → full move) with accuracy tracking
- **Puzzle page auto-detection** — automatically activates analysis on chess.com puzzle, lesson, and lichess training pages
- **Training hotkey** — `Alt+T` to toggle training mode on/off

### Engine & Tablebases
- **Stockfish + Fairy-Stockfish** — standard and variant chess engine support
- **Settings preserved across engine switches** — Threads, Hash, MultiPV persist when switching between engines
- **Syzygy endgame tablebases** — perfect endgame play when configured
- **Variant chess support** — Chess960, Atomic, Crazyhouse, King of the Hill, Three-Check, Antichess, Horde, Racing Kings
- **Depth control** — panel depth setting is authoritative; scales eval timeout dynamically (up to 3 minutes for deep searches)

### Voice & Accessibility
- **Text-to-speech move announcements** — hear the best move spoken aloud
- **Voice speed control** — adjustable speech rate
- **Eval announcements** — optionally speak the evaluation score
- **Opening announcements** — optionally speak the detected opening name

### Dashboard Panel
- Full settings UI at `http://localhost:8080` with:
  - Depth, MultiPV, Threads, Hash, Skill Level controls
  - **Search depth badge** on each PV card (e.g. D25) so you know how deep the engine searched
  - **Winning/losing PV card styling** — green tint for winning, red tint + border for losing lines
  - Engine / book / Syzygy file switching
  - Multiple opening book selection (multi-select dropdown)
  - Lichess Masters DB toggle
  - Analyze for Me / Opponent / Both
  - Time (ms) and Nodes search limits
  - Display mode (arrows / boxes / both)
  - Opponent response toggle
  - Training mode toggle
  - Voice controls (on/off, speed, eval, opening announcements)

### Connection & Navigation
- **Auto-reconnect** — resilient WebSocket connection with exponential backoff and automatic position resend
- **SPA navigation detection** — handles chess.com and lichess page transitions without losing state

### Hotkeys
- `Alt+A` — resume analysis
- `Alt+S` — stop analysis
- `Alt+W` — analyze for Me
- `Alt+Q` — analyze for Opponent
- `Alt+T` — toggle training mode

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
└────────────────── ┘                   └──────────────────┘
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
2. Open a game on chess.com or lichess.org
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
