import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyVariant, chooseFairyBinary, LARGEBOARD_VARIANTS } = require('./engineSelect');

const STD = { name: 'fairy-stockfish_x86-64-modern.exe', path: '/e/fairy.exe' };
const LARGE = { name: 'fairy-stockfish-largeboard_x86-64-modern.exe', path: '/e/fairy-large.exe' };
const SF = { name: 'stockfish_x86-64.exe', path: '/e/sf.exe' };

const isCurated = (k) =>
  ['chess', 'duck', 'atomic', 'crazyhouse', 'xiangqi', 'capablanca', 'makruk'].includes(k);

describe('classifyVariant', () => {
  it('marks large-board variants as large', () => {
    expect(classifyVariant('xiangqi', isCurated)).toBe('large');
    expect(classifyVariant('capablanca', isCurated)).toBe('large');
    expect(classifyVariant('grand', isCurated)).toBe('large');
  });
  it('marks curated 8x8 variants as standard', () => {
    expect(classifyVariant('duck', isCurated)).toBe('standard');
    expect(classifyVariant('atomic', isCurated)).toBe('standard');
    expect(classifyVariant('makruk', isCurated)).toBe('standard');
  });
  it('marks unknown (non-curated, non-large) variants as unknown', () => {
    expect(classifyVariant('someEngineOnlyVariant', isCurated)).toBe('unknown');
  });
});

describe('chooseFairyBinary', () => {
  it('duck (standard) prefers the non-largeboard build when both exist', () => {
    expect(chooseFairyBinary([SF, STD, LARGE], 'standard')).toBe(STD.path);
  });
  it('xiangqi (large) prefers the largeboard build when both exist', () => {
    expect(chooseFairyBinary([SF, STD, LARGE], 'large')).toBe(LARGE.path);
  });
  it('falls back to the only fairy build available (standard-only)', () => {
    expect(chooseFairyBinary([SF, STD], 'large')).toBe(STD.path);
  });
  it('falls back to the only fairy build available (largeboard-only)', () => {
    expect(chooseFairyBinary([SF, LARGE], 'standard')).toBe(LARGE.path);
  });
  it('returns null when no fairy binary is present', () => {
    expect(chooseFairyBinary([SF], 'standard')).toBeNull();
    expect(chooseFairyBinary([], 'large')).toBeNull();
  });
  it('returns null (keep current) for unknown classification', () => {
    expect(chooseFairyBinary([STD, LARGE], 'unknown')).toBeNull();
  });
  it('ignores plain Stockfish binaries', () => {
    expect(chooseFairyBinary([SF], 'large')).toBeNull();
  });
});

describe('LARGEBOARD_VARIANTS coverage', () => {
  it('includes the >8x8 variants and excludes 8x8 ones', () => {
    for (const k of ['xiangqi', 'janggi', 'capablanca', 'grand', 'shako', 'courier', 'modern']) {
      expect(LARGEBOARD_VARIANTS.has(k)).toBe(true);
    }
    for (const k of ['duck', 'atomic', 'shogun', 'torpedo', 'makruk', 'minishogi']) {
      expect(LARGEBOARD_VARIANTS.has(k)).toBe(false);
    }
  });
});
