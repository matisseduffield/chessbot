import { describe, expect, it } from 'vitest';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  parseClientMessage,
  parseServerMessage,
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
      type: 'search',
      id: 'abc',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      limits: { depth: 12, movetimeMs: 1500 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown message types', () => {
    const result = parseClientMessage({ type: 'not_a_message' });
    expect(result.success).toBe(false);
  });

  it('rejects malformed UCI moves', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'position',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      moves: ['e2e4', 'not-a-move'],
    });
    expect(result.success).toBe(false);
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
