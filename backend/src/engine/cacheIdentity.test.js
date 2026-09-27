import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
const { cacheIdentity } = createRequire(import.meta.url)('./cacheIdentity');
it('separates binaries, strength and budgets, while permitting deeper search reuse', () => {
  const key = cacheIdentity('sf', { Hash: 16, MultiPV: 1 }, { depth: 15 });
  expect(cacheIdentity('sf', { MultiPV: 1, Hash: 16 }, { depth: 20 })).toBe(key);
  expect(cacheIdentity('fairy', { Hash: 16, MultiPV: 1 }, {})).not.toBe(key);
  expect(cacheIdentity('sf', { Hash: 16, MultiPV: 1, UCI_Elo: 1500 }, {})).not.toBe(key);
  expect(cacheIdentity('sf', { Hash: 16, MultiPV: 1 }, { movetime: 100 })).not.toBe(key);
});
