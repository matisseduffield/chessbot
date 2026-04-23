'use strict';
// @ts-check

/**
 * Zod schemas for inbound WebSocket frames the backend actually handles.
 *
 * Unlike the aspirational schemas in @chessbot/shared/messages.ts (which
 * describe a future, cleaner protocol), these match the real wire format
 * in backend/server.js. Plan §11: validate all inbound frames, reject
 * unknown types with a typed error so clients can't silently no-op.
 *
 * Each schema is intentionally permissive where the server already branches
 * on `msg.type` + extra field presence — validation exists to prevent
 * malformed or hostile payloads, not to tighten semantics.
 */

const { z } = require('zod');

const FenStr = z.string().min(10).max(200);
const SafeName = z.string().max(200);

const FenMsg = z.object({
  type: z.literal('fen'),
  fen: FenStr,
  flipped: z.boolean().optional(),
  requestId: z.union([z.string(), z.number()]).optional(),
  depth: z.number().int().min(0).max(40).optional(),
  multipv: z.number().int().min(1).max(8).optional(),
});

const SetOptionMsg = z.object({
  type: z.literal('set_option'),
  name: SafeName,
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const ClearHashMsg = z.object({ type: z.literal('clear_hash') });

const GameInfoMsg = z
  .object({
    type: z.literal('game_info'),
    white: z.any().optional(),
    black: z.any().optional(),
    moveNumber: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const BroadcastMsg = z.object({
  type: z.literal('broadcast'),
  payload: z.record(z.any()),
});

const SetLichessBookMsg = z.object({
  type: z.literal('set_lichess_book'),
  enabled: z.boolean().optional(),
  speeds: z.array(z.string()).optional(),
  ratings: z.array(z.number()).optional(),
});

const GetSettingsMsg = z.object({ type: z.literal('get_settings') });
const GetServerLogsMsg = z.object({ type: z.literal('get_server_logs') });

const SwitchVariantMsg = z.object({
  type: z.literal('switch_variant'),
  variant: SafeName,
  isChess960: z.boolean().optional(),
});

const ListFilesMsg = z.object({
  type: z.literal('list_files'),
  kind: z.enum(['engine', 'book', 'syzygy']).optional(),
});

const SwitchEngineMsg = z.object({ type: z.literal('switch_engine'), name: SafeName });
const SwitchBookMsg = z.object({
  type: z.literal('switch_book'),
  name: z.union([SafeName, z.null()]),
});
const SwitchSyzygyMsg = z.object({
  type: z.literal('switch_syzygy'),
  name: z.union([SafeName, z.null()]),
});

const HelloMsg = z
  .object({
    type: z.literal('hello'),
    protocolVersion: z.number().int().optional(),
    client: z.string().optional(),
    clientVersion: z.string().optional(),
  })
  .passthrough();

const InboundMessage = z.discriminatedUnion('type', [
  FenMsg,
  SetOptionMsg,
  ClearHashMsg,
  GameInfoMsg,
  BroadcastMsg,
  SetLichessBookMsg,
  GetSettingsMsg,
  GetServerLogsMsg,
  SwitchVariantMsg,
  ListFilesMsg,
  SwitchEngineMsg,
  SwitchBookMsg,
  SwitchSyzygyMsg,
  HelloMsg,
]);

/**
 * Parse and validate an inbound WS frame.
 * @param {unknown} raw
 * @returns {{ ok: true, msg: any } | { ok: false, code: string, message: string }}
 */
function validateInbound(raw) {
  if (raw == null || typeof raw !== 'object') {
    return { ok: false, code: 'invalid_frame', message: 'frame must be an object' };
  }
  const t = /** @type {any} */ (raw).type;
  if (typeof t !== 'string') {
    return { ok: false, code: 'invalid_frame', message: 'frame.type missing' };
  }
  const result = InboundMessage.safeParse(raw);
  if (!result.success) {
    const known = [
      'fen',
      'set_option',
      'clear_hash',
      'game_info',
      'broadcast',
      'set_lichess_book',
      'get_settings',
      'get_server_logs',
      'switch_variant',
      'list_files',
      'switch_engine',
      'switch_book',
      'switch_syzygy',
      'hello',
    ];
    if (!known.includes(t)) {
      return { ok: false, code: 'unknown_type', message: `unknown message type: ${t}` };
    }
    const first = result.error.issues[0];
    return {
      ok: false,
      code: 'invalid_payload',
      message: `${first.path.join('.') || '(root)'}: ${first.message}`,
    };
  }
  return { ok: true, msg: result.data };
}

module.exports = { validateInbound, InboundMessage };
