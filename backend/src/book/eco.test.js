import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const eco = require('./eco');

describe('parseTsv', () => {
  it('skips the header row', () => {
    const content =
      'eco\tname\tepd\nA00\tUncommon Opening\trnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -\n';
    const rows = eco.parseTsv(content);
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
    expect(rows[0][1]).toEqual({ code: 'A00', name: 'Uncommon Opening' });
  });

  it('strips UTF-8 BOM', () => {
    const content =
      '\uFEFFeco\tname\tepd\nB00\tKings Pawn\trnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3\n';
    const rows = eco.parseTsv(content);
    expect(rows).toHaveLength(1);
    expect(rows[0][1].code).toBe('B00');
  });

  it('ignores malformed rows', () => {
    const content = 'eco\tname\tepd\nA00\tOK\tepd1\nincomplete\nA01\tAnother\tepd2\n';
    const rows = eco.parseTsv(content);
    expect(rows).toHaveLength(2);
    expect(rows.map(([e]) => e)).toEqual(['epd1', 'epd2']);
  });

  it('returns empty for non-string input', () => {
    expect(eco.parseTsv(null)).toEqual([]);
    expect(eco.parseTsv(undefined)).toEqual([]);
  });
});

describe('lookup', () => {
  beforeEach(() => eco._reset());

  it('returns null when map is empty', () => {
    expect(eco.lookup('anything')).toBeNull();
  });

  it('returns seeded entry', () => {
    eco._seed([['EPD1', { code: 'C20', name: 'Kings Pawn Game' }]]);
    expect(eco.lookup('EPD1')).toEqual({ code: 'C20', name: 'Kings Pawn Game' });
    expect(eco.size()).toBe(1);
  });

  it('returns null for unknown epd', () => {
    eco._seed([['EPD1', { code: 'C20', name: 'Kings Pawn Game' }]]);
    expect(eco.lookup('UNKNOWN')).toBeNull();
  });

  it('returns null for bad input', () => {
    eco._seed([['EPD1', { code: 'C20', name: 'Kings Pawn Game' }]]);
    expect(eco.lookup('')).toBeNull();
    expect(eco.lookup(null)).toBeNull();
    expect(eco.lookup(42)).toBeNull();
  });
});
