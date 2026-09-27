# Analysis accuracy, latency and board overlays

This pass keeps the existing dashboard and search settings. It repairs how engine answers are assembled, published and positioned.

## Accuracy

- MultiPV updates publish only after all available candidate lines finish the same depth, with distinct moves. Previously, ranks from consecutive depths could be mixed while Stockfish reordered candidates.
- Final results match the first PV and its score to the engine's actual `bestmove`, including a stop during reranking. If that move has no score, the result remains unscored rather than borrowing another move's evaluation.
- UCI lower/upper score bounds are excluded from exact-score displays. Standard-chess positions with fewer legal moves than the requested MultiPV still receive updates.
- A configured Syzygy directory does not establish a proven root result. The previous inferred win/draw/loss label is removed; native engine probing remains enabled. Cache schema 3 invalidates older results assembled with the previous rules.
- Null terminal moves clear the board indicators. Chess.com bot results and progress are compared with the current authoritative full FEN before display, preserving castling and en-passant distinctions.

## Detection and rendering

The read-only Chess.com bot bridge now watches board mutations and publishes the authoritative position on the next animation frame. Its 250 ms poll remains as a fallback for API-only changes and board replacement. Validated snapshots go straight to the content reader rather than waiting an additional 75 ms. DOM-derived boards retain their animation checks.

Foreground and background SVGs use a board-relative size and viewBox. Existing arrows resize with the board between engine responses. Candidate ranks remain visually distinct in losing positions; destination badges show rank and evaluation, and promotions identify the piece. The optional depth badge survives final rendering and distinguishes Searching, Ready and Cached.

## Reproducible engine benchmark

Run `node scripts/benchmark-analysis.mjs` with the configured native engine. It checks that suggested moves are legal and that the mate-in-one case ends in checkmate. It reports time to first update, total search time, update count and inconsistent ranking count.

On this Windows machine with Stockfish 19, one thread, 16 MB hash, three PVs, depth 15 and a 1,000 ms cap:

| Position           | Updates before → after | Mixed-depth/duplicate updates before → after | Search time before → after |
| ------------------ | ---------------------- | -------------------------------------------- | -------------------------- |
| Starting position  | 43 → 15                | 28 → 0                                       | 214 → 225 ms               |
| Middlegame fixture | 43 → 15                | 28 → 0                                       | 352 → 364 ms               |
| Mate in one        | 43 → 15                | 28 → 0                                       | 1 → 1 ms                   |

Final moves and depth 15 were unchanged in all three cases. This is about 65% fewer update callbacks, not a claim that Stockfish searches faster. Single-run timings include machine variance. The bridge's shorter event path addresses time before search begins; it does not weaken the requested depth or silently enable streaming.

Regression coverage exercises reranking, score bounds, forced moves, terminal output, publisher cleanup and SVG reuse. Installed-extension browser tests check actual arrow source/tip placement, board resizing, flipped orientation, an en-passant position, persistent depth badges, sessions and training. These use controlled fixtures and do not establish complete live coverage of every supported site or variant. The existing overlay coordinate system remains limited to 8×8 boards.
