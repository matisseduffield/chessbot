import { z } from 'zod';

// Actual production wire contract. Variant FEN and moves must remain compatible
// with drops, compound moves, extra counters and non-8x8 boards.
export const FenSchema = z
  .string()
  .min(10)
  .max(2048)
  .regex(/^[^\r\n]+$/);
export const UciMoveSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-zA-Z0-9@,+-]+$/);
const name = z
  .string()
  .max(200)
  .regex(/^[^\r\n]*$/);
const id = z.union([z.string().max(160), z.number()]);
const route = { sessionId: z.string().max(160).optional(), requestId: id.optional() };
const limits = {
  depth: z.number().int().min(0).max(50).optional(),
  movetime: z.number().int().min(1).max(600000).optional(),
  nodes: z.number().int().positive().optional(),
  multipv: z.number().int().min(1).max(8).optional(),
};
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('fen'),
    ...route,
    ...limits,
    fen: FenSchema,
    variant: name.optional(),
    flipped: z.boolean().optional(),
    training: z.boolean().optional(),
    remainingClockMs: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('set_option'),
    ...route,
    name,
    value: z.union([name, z.number().finite(), z.boolean()]),
  }),
  z.object({
    type: z.literal('broadcast'),
    ...route,
    payload: z.object({ type: name.min(1) }).passthrough(),
  }),
  z.object({ type: z.literal('game_info'), ...route }).passthrough(),
  z.object({
    type: z.literal('set_lichess_book'),
    ...route,
    value: z.boolean().optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({ type: z.literal('set_live_engine_stream'), ...route, value: z.boolean() }),
  z.object({
    type: z.literal('switch_variant'),
    ...route,
    variant: name,
    isChess960: z.boolean().optional(),
  }),
  z.object({ type: z.literal('switch_engine'), ...route, name }),
  z.object({
    type: z.literal('switch_book'),
    ...route,
    name: z.union([name, z.array(name).max(32), z.null()]),
  }),
  z.object({ type: z.literal('switch_syzygy'), ...route, name: name.nullable() }),
  z.object({
    type: z.literal('list_files'),
    ...route,
    kind: z.enum(['engine', 'book', 'syzygy']).optional(),
  }),
  z.object({ type: z.literal('get_settings'), ...route }),
  z.object({ type: z.literal('get_server_logs'), ...route }),
  z.object({ type: z.literal('clear_hash'), ...route }),
  z.object({
    type: z.literal('hello'),
    ...route,
    protocolVersion: z.number().int(),
    client: z.enum(['extension', 'panel']),
    site: name.optional(),
  }),
  z.object({ type: z.literal('focus_session'), ...route }),
  z.object({ type: z.literal('subscribe_session'), ...route, followFocus: z.boolean().optional() }),
  z.object({ type: z.literal('cancel_search'), ...route }),
  z.object({ type: z.literal('get_training_history'), ...route }),
  z.object({ type: z.literal('clear_training_history'), ...route }),
  z.object({ type: z.literal('delete_training_attempt'), ...route, id: z.string().max(160) }),
  z.object({
    type: z.literal('training_attempt'),
    ...route,
    attempt: z.object({
      id: z.string().max(160),
      before: FenSchema,
      after: FenSchema,
      variant: name,
      site: name,
      player: z.enum(['w', 'b']),
      recommendation: UciMoveSchema,
      playedMove: UciMoveSchema.nullable(),
      correct: z.boolean().nullable(),
      assisted: z.boolean(),
      timestamp: z.number(),
    }),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export const ServerMessageSchema = z.object({ type: z.string(), ...route }).passthrough();
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export const parseClientMessage = (raw: unknown) => ClientMessageSchema.safeParse(raw);
export const parseServerMessage = (raw: unknown) => ServerMessageSchema.safeParse(raw);
export function validateInbound(
  raw: unknown,
): { ok: true; msg: ClientMessage } | { ok: false; code: string; message: string } {
  if (!raw || typeof raw !== 'object' || !('type' in raw) || typeof raw.type !== 'string')
    return { ok: false, code: 'invalid_frame', message: 'frame.type missing' };
  const result = parseClientMessage(raw);
  if (result.success) return { ok: true, msg: result.data };
  const issue = result.error.issues[0];
  const known = ClientMessageSchema.options.some((s) => s.shape.type.value === raw.type);
  return {
    ok: false,
    code: known ? 'invalid_payload' : 'unknown_type',
    message: `${issue.path.join('.') || 'frame'}: ${issue.message}`,
  };
}
