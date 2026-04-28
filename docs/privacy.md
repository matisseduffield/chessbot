# Privacy Policy

ChessBot is a **fully local** chess analysis tool. No data is collected, tracked, or sent to any server operated by the project authors.

---

## What data stays on your machine

| Data                                           | Where stored                             |
| ---------------------------------------------- | ---------------------------------------- |
| Panel settings (depth, theme, piece set, etc.) | Browser `localStorage` on the panel page |
| Board positions (FENs)                         | In memory only — never persisted to disk |
| Analysis lines (PV output)                     | In memory only                           |
| Training stats                                 | Browser `localStorage`                   |

All of the above is stored locally in your browser and can be cleared at any time by clearing site data for `localhost`.

---

## What leaves your machine (and when)

The **only** external network request ChessBot makes is an optional call to the public [Lichess Opening Explorer API](https://lichess.org/api#tag/Opening-Explorer) when the opening book lookup is enabled:

- **URL**: `https://explorer.lichess.ovh/masters?fen=<fen>`
- **Data sent**: the board position (FEN string) — no user identity, no session tokens
- **Frequency**: at most once per unique board position; results are LRU-cached locally (1 hour TTL) to avoid repeated requests
- **Who receives it**: Lichess.org — see their [privacy policy](https://lichess.org/privacy)

If you disable the opening book (`OPENING_BOOK=false` in `.env`), **no network requests are made at all** and ChessBot operates fully offline.

---

## LAN mode

When you start the backend with `BIND_HOST=0.0.0.0` (LAN mode), the dashboard becomes accessible to other devices on your local network. A randomly-generated 6-digit PIN gates access — no external server is involved. The PIN and auth token are stored only in memory for the lifetime of the server process.

---

## Engine process

The Stockfish engine binary runs as a local child process. It does **not** make any network connections. All communication happens over stdin/stdout pipes on your machine.

---

## Browser extension

The ChessBot browser extension reads the board position from the chess site's DOM and sends it over a local WebSocket to `ws://localhost:8080`. It does **not** read passwords, account information, or any other page content — only piece positions and clock values where available.

---

## Contact

If you have privacy concerns or questions, open an issue at <https://github.com/matisseduffield/chessbot/issues>.
