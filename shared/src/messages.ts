import { z } from 'zod';

/**
 * Shared WebSocket message schemas.
 *
 * These are the single source of truth for the wire protocol between:
 *   - backend server (Node)
 *   - content script (browser extension)
 *   - dashboard panel (localhost web UI)
 *
 * Phase 1 scope: define the schemas without wiring them into the existing
 * runtime code. A follow-up task will replace the ad-hoc JSON shapes in
 * `backend/server.js` and `extension/src/content/content.js` with these
 * validators. See plans/improvement-plan.md §2.2 and §7.4.
 */

export const FenSchema = z.string().min(10);

export const UciMoveSchema = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/, 'invalid UCI move');

export const ChessSiteSchema = z.enum(['chesscom', 'lichess', 'unknown']);
export type ChessSite = z.infer<typeof ChessSiteSchema>;

export const ColorSchema = z.enum(['w', 'b']);
export type Color = z.infer<typeof ColorSchema>;

export const SearchLimitsSchema = z.object({
  depth: z.number().int().min(1).max(40).optional(),
  movetimeMs: z.number().int().min(50).max(600_000).optional(),
  nodes: z.number().int().min(1).optional(),
  multipv: z.number().int().min(1).max(5).default(1),
});
export type SearchLimits = z.infer<typeof SearchLimitsSchema>;

export const PvLineSchema = z.object({
  multipv: z.number().int().min(1),
  depth: z.number().int().min(0),
  seldepth: z.number().int().min(0).optional(),
  scoreCp: z.number().int().optional(),
  scoreMate: z.number().int().optional(),
  nodes: z.number().int().optional(),
  nps: z.number().int().optional(),
  timeMs: z.number().int().optional(),
  moves: z.array(UciMoveSchema),
});
export type PvLine = z.infer<typeof PvLineSchema>;

export const GameInfoSchema = z.object({
  site: ChessSiteSchema,
  url: z.string().url().optional(),
  fen: FenSchema,
  playerColor: ColorSchema.nullable().optional(),
  flipped: z.boolean().optional(),
  whiteName: z.string().optional(),
  blackName: z.string().optional(),
  whiteRating: z.number().int().optional(),
  blackRating: z.number().int().optional(),
  timeControl: z.string().optional(),
});
export type GameInfo = z.infer<typeof GameInfoSchema>;

export const HelloClientSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int(),
  client: z.enum(['extension', 'panel']),
  clientVersion: z.string(),
});

export const GameInfoMsgSchema = z.object({
  type: z.literal('game_info'),
  data: GameInfoSchema,
});

export const PositionMsgSchema = z.object({
  type: z.literal('position'),
  fen: FenSchema,
  moves: z.array(UciMoveSchema).default([]),
});

export const SearchRequestSchema = z.object({
  type: z.literal('search'),
  id: z.string(),
  fen: FenSchema,
  limits: SearchLimitsSchema,
});

export const CancelSearchSchema = z.object({
  type: z.literal('cancel_search'),
  id: z.string(),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloClientSchema,
  GameInfoMsgSchema,
  PositionMsgSchema,
  SearchRequestSchema,
  CancelSearchSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const HelloServerSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int(),
  serverVersion: z.string(),
  engine: z.object({
    name: z.string(),
    version: z.string().optional(),
  }),
});

export const SearchInfoSchema = z.object({
  type: z.literal('search_info'),
  id: z.string(),
  lines: z.array(PvLineSchema),
});

export const SearchBestMoveSchema = z.object({
  type: z.literal('bestmove'),
  id: z.string(),
  bestmove: UciMoveSchema,
  ponder: UciMoveSchema.optional(),
  line: PvLineSchema.optional(),
});

export const ErrorFrameSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  id: z.string().optional(),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  HelloServerSchema,
  SearchInfoSchema,
  SearchBestMoveSchema,
  ErrorFrameSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export function parseClientMessage(raw: unknown) {
  return ClientMessageSchema.safeParse(raw);
}

export function parseServerMessage(raw: unknown) {
  return ServerMessageSchema.safeParse(raw);
}
