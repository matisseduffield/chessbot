import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateInbound } = require('./validateMessage');

describe('validateInbound', () => {
  it('rejects non-objects', () => {
    expect(validateInbound(null).ok).toBe(false);
    expect(validateInbound('hi').ok).toBe(false);
    expect(validateInbound(42).ok).toBe(false);
  });

  it('rejects frames without a string type', () => {
    const r = validateInbound({ foo: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_frame');
  });

  it('reports unknown_type for unrecognised type strings', () => {
    const r = validateInbound({ type: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unknown_type');
  });

  it('accepts a well-formed fen frame', () => {
    const r = validateInbound({
      type: 'fen',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      flipped: false,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a fen frame missing fen', () => {
    const r = validateInbound({ type: 'fen' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_payload');
  });

  it('rejects a fen frame with absurd depth', () => {
    const r = validateInbound({
      type: 'fen',
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      depth: 999,
    });
    expect(r.ok).toBe(false);
  });

  it('accepts set_option with string / number / boolean values', () => {
    expect(validateInbound({ type: 'set_option', name: 'Threads', value: 4 }).ok).toBe(true);
    expect(validateInbound({ type: 'set_option', name: 'SyzygyPath', value: '/foo' }).ok).toBe(
      true,
    );
    expect(validateInbound({ type: 'set_option', name: 'Ponder', value: true }).ok).toBe(true);
  });

  it('accepts broadcast with any payload object', () => {
    expect(
      validateInbound({ type: 'broadcast', payload: { type: 'set_depth', value: 15 } }).ok,
    ).toBe(true);
  });

  it('rejects broadcast without payload', () => {
    expect(validateInbound({ type: 'broadcast' }).ok).toBe(false);
  });

  it('accepts clear_hash / get_settings / get_server_logs bare frames', () => {
    expect(validateInbound({ type: 'clear_hash' }).ok).toBe(true);
    expect(validateInbound({ type: 'get_settings' }).ok).toBe(true);
    expect(validateInbound({ type: 'get_server_logs' }).ok).toBe(true);
  });

  it('accepts switch_variant / switch_engine / switch_book / switch_syzygy', () => {
    expect(validateInbound({ type: 'switch_variant', variant: 'chess' }).ok).toBe(true);
    expect(validateInbound({ type: 'switch_engine', name: 'stockfish' }).ok).toBe(true);
    expect(validateInbound({ type: 'switch_book', name: 'Balsa' }).ok).toBe(true);
    expect(validateInbound({ type: 'switch_book', name: null }).ok).toBe(true);
    expect(validateInbound({ type: 'switch_syzygy', name: null }).ok).toBe(true);
  });

  it('accepts game_info with arbitrary extra fields (passthrough)', () => {
    expect(
      validateInbound({
        type: 'game_info',
        white: { name: 'Hikaru', clock: '1:00' },
        black: { name: 'Magnus' },
        customField: 'x',
      }).ok,
    ).toBe(true);
  });
});
