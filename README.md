# Chess Analysis Helper

Real-time chess analysis overlay for **chess.com** and **lichess.org**. A Chrome extension reads the board from the page, sends positions to a local Stockfish backend, and draws best-move arrows directly on the board.

## Features

- **Best-move arrows** — green (your turn), red (opponent), gold (opening book)
- **Multi-PV display** — show multiple candidate lines with eval badges
- **Eval bar** — real-time evaluation bar alongside the board
- **Opening book** — Polyglot `.bin` book lookups before falling back to engine
- **Syzygy endgame tablebases** — perfect endgame play when configured
- **Dashboard panel** — full settings UI at `http://localhost:8080` with:
  - Depth, MultiPV, Threads, Hash, Skill Level controls
  - Engine / book / Syzygy file switching
  - Analyze for Me / Opponent / Both
  - Time (ms) and Nodes search limits
  - Display toggles (arrows, eval bar, voice)
- **Hotkeys** — `Alt+A` resume, `Alt+S` stop, `Alt+W` analyze for Me, `Alt+Q` analyze for Opponent
- **ECO classification** — opening names shown in the dashboard

## Architecture

```
┌──────────────────┐     WebSocket      ┌──────────────────┐
│  Chrome Extension │ ◄──────────────► │   Node.js Server  │
│  (content script) │   ws://localhost   │   (port 8080)     │
│                    │      :8080        │                    │
│ • reads board DOM  │                   │ • Stockfish UCI    │
│ • draws arrows     │                   │ • opening book     │
│ • turn detection   │                   │ • ECO database     │
│ • FEN conversion   │                   │ • Syzygy tables    │
└──────────────────┘                   └──────────────────┘
        ▲                                       ▲
        │                                       │
        ▼                                       ▼
┌──────────────────┐                   ┌──────────────────┐
│  Extension Popup  │                   │  Dashboard Panel  │
│  (toggle + logs)  │                   │  (localhost:8080)  │
└──────────────────┘                   └──────────────────┘
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

Download a Stockfish binary from [stockfishchess.org/download](https://stockfishchess.org/download) and place it in the `engine/stockfish/` directory:

```
engine/
  stockfish/
    stockfish-windows-x86-64-avx2.exe   # Windows
    stockfish                             # Linux / macOS
```

The server auto-detects the first `.exe` in `engine/`. You can also set `STOCKFISH_PATH` as an environment variable.

### 3. (Optional) Opening book

Place a Polyglot `.bin` opening book in the `books/` directory:

```
books/
  Perfect2023.bin
```

The server auto-detects the first `.bin` file. Set `OPENING_BOOK_PATH` to override.

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
│   ├── server.js           # HTTP + WebSocket server
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

For personal/educational use only.
