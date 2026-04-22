# WebSocket protocol

All messages between the backend, the content script, and the panel
are JSON objects with a required `type: string` field. The authoritative
schema is the zod model in
[`shared/src/messages.ts`](../shared/src/messages.ts); this page is a
human-readable summary.

The protocol is versioned by `PROTOCOL_VERSION` in
[`shared/src/version.ts`](../shared/src/version.ts). The backend sends
`server_hello` on every new connection; clients compare the reported
version against their bundled copy and warn loudly on mismatch (no
hard disconnect — the panel stays usable on stale installs).

## Transport

- URL: `ws://localhost:${PORT}` (default `8080`)
- Text frames only. Binary frames are ignored.
- No authentication — the backend is intended to be localhost-only.

## Rate limiting

Each connection is capped at **300 messages per 10 seconds**. A client
exceeding the limit receives one `error` frame with `code:"rate_limited"`
and then has subsequent frames silently dropped until the window rolls
over.

## Server → client frames

| `type`             | Purpose                          | Key fields                                        |
| ------------------ | -------------------------------- | ------------------------------------------------- |
| `server_hello`     | Handshake, first frame           | `protocolVersion`, `serverVersion`, `engine.name` |
| `bestmove`         | Final search result              | `fen`, `lines[]`, `streaming:false`               |
| `eval_progress`    | In-flight depth update           | `depth`, `targetDepth`, `nps`                     |
| `game_info`        | Player names / colours           | `white`, `black`, `moveNumber`, `flipped`         |
| `settings`         | Current server settings snapshot | variable                                          |
| `variant_switched` | Variant changed                  | `variant`, `activeEngine`                         |
| `server_logs`      | Reply to `get_server_logs`       | `logs`                                            |
| `set_*`            | Broadcast toggle updates         | `value`                                           |
| `error`            | Something went wrong             | `code`, `message`, optional `id`                  |

## Client → server frames

| `type`                                                  | Purpose                                             |
| ------------------------------------------------------- | --------------------------------------------------- |
| `fen`                                                   | New position to analyse (`fen`, optional `variant`) |
| `get_settings`                                          | Request current settings snapshot                   |
| `set_depth` / `set_search_limits` / `set_auto_move` / … | Mutate settings                                     |
| `switch_variant`                                        | Change active variant                               |
| `switch_engine`                                         | Swap engine binary                                  |
| `switch_book` / `switch_syzygy`                         | Swap resource                                       |
| `get_server_logs`                                       | Fetch rolling log buffer                            |
| `cancel_search`                                         | Abort an in-flight search                           |

## Error codes

Codes are stable identifiers so clients can branch without parsing
human text.

| Code                  | Meaning                                             |
| --------------------- | --------------------------------------------------- |
| `bad_frame`           | Non-object / wrong-shape JSON                       |
| `rate_limited`        | Connection exceeded message quota                   |
| `invalid_fen`         | FEN failed validation                               |
| `engine_not_ready`    | Search requested before UCI handshake completed     |
| `engine_error`        | Underlying UCI process error                        |
| `variant_unsupported` | Requested variant unknown or engine can't handle it |
| `resource_missing`    | Requested engine/book/syzygy file not found         |
| `switch_failed`       | Engine/book/syzygy switch threw                     |

Add new codes to this table and to the zod schema in `messages.ts` in
the same PR as the code that throws them.
