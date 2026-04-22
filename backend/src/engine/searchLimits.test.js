import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require2 = createRequire(import.meta.url);
const { pickSearchLimits } = require2('./searchLimits.js');

describe('pickSearchLimits', () => {
  it('uses per-request depth over config default', () => {
    const r = pickSearchLimits({ depth: 12 }, { defaultDepth: 20 });
    expect(r.depth).toBe(12);
  });

  it('falls back to config defaultDepth when none supplied', () => {
    const r = pickSearchLimits({}, { defaultDepth: 18 });
    expect(r.depth).toBe(18);
  });

  it('honours per-request movetime (bullet-mode regression)', () => {
    const r = pickSearchLimits({ depth: 12, movetime: 1500 }, { searchMovetime: 9999 });
    expect(r.depth).toBe(12);
    expect(r.options.movetime).toBe(1500);
    expect(r.options.nodes).toBeUndefined();
  });

  it('movetime takes precedence over nodes', () => {
    const r = pickSearchLimits({ movetime: 800, nodes: 1_000_000 }, {});
    expect(r.options.movetime).toBe(800);
    expect(r.options.nodes).toBeUndefined();
  });

  it('coerces string numeric inputs', () => {
    const r = pickSearchLimits({ depth: '10', movetime: '500' }, {});
    expect(r.depth).toBe(10);
    expect(r.options.movetime).toBe(500);
  });

  it('returns empty options when nothing is set', () => {
    const r = pickSearchLimits({}, {});
    expect(r.options).toEqual({});
    expect(r.depth).toBe(0);
  });

  it('uses config.searchNodes when movetime absent', () => {
    const r = pickSearchLimits({}, { searchNodes: 500_000 });
    expect(r.options.nodes).toBe(500_000);
    expect(r.options.movetime).toBeUndefined();
  });

  it('accepts depth=0 explicitly (infinite search signal)', () => {
    const r = pickSearchLimits({ depth: 0 }, { defaultDepth: 18 });
    expect(r.depth).toBe(0);
  });
});
