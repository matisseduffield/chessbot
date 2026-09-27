import { describe, expect, it } from 'vitest';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  parseClientMessage,
  parseServerMessage,
  UciMoveSchema,
} from './index';

describe('shared protocol version', () => {
  it('has a positive integer version', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('client message schema', () => {
  it('accepts a valid search request', () => {
    const result = parseClientMessage({
      type: 'fen',
      requestId: 'abc',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      depth: 12,
      movetime: 1500,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown message types', () => {
    const result = parseClientMessage({ type: 'not_a_message' });
    expect(result.success).toBe(false);
  });

  it('preserves variant notation while rejecting protocol injection', () => {
    for (const move of ['P@e4', 'e2e4,a1a2', 'a10b10', 'e7e8q'])
      expect(UciMoveSchema.safeParse(move).success).toBe(true);
    expect(UciMoveSchema.safeParse('e2e4\nquit').success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'broadcast', payload: {} }).success).toBe(false);
  });
});

describe('server message schema', () => {
  it('accepts a bestmove frame', () => {
    const result = parseServerMessage({
      type: 'bestmove',
      id: 'abc',
      bestmove: 'e2e4',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an error frame', () => {
    const result = ServerMessageSchema.safeParse({
      type: 'error',
      code: 'engine_unavailable',
      message: 'Stockfish not ready',
    });
    expect(result.success).toBe(true);
  });
});
