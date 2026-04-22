import { describe, it, expect } from 'vitest';
import { filterGhostPieces } from './pieceFilter.js';

describe('filterGhostPieces', () => {
  it('keeps real piece elements', () => {
    const pieces = [{ className: 'piece white pawn' }, { className: 'piece black king' }];
    expect(filterGhostPieces(pieces)).toHaveLength(2);
  });

  it('drops ghost pieces (word boundary)', () => {
    const pieces = [{ className: 'piece white pawn' }, { className: 'piece ghost white pawn' }];
    const kept = filterGhostPieces(pieces);
    expect(kept).toHaveLength(1);
    expect(kept[0].className).toBe('piece white pawn');
  });

  it('drops premove pieces', () => {
    const pieces = [{ className: 'piece premove' }, { className: 'piece white pawn' }];
    expect(filterGhostPieces(pieces)).toHaveLength(1);
  });

  it('is case-insensitive', () => {
    const pieces = [{ className: 'GHOST piece' }];
    expect(filterGhostPieces(pieces)).toHaveLength(0);
  });

  it("does not drop pieces whose className merely contains 'ghostly' etc.", () => {
    const pieces = [{ className: 'piece ghostly-effect' }];
    expect(filterGhostPieces(pieces)).toHaveLength(1);
  });

  it('falls back to getAttribute when className is not a string', () => {
    const pieces = [
      {
        className: { baseVal: 'piece ghost' },
        getAttribute: (name) => (name === 'class' ? 'piece ghost' : null),
      },
      {
        className: { baseVal: 'piece white' },
        getAttribute: (name) => (name === 'class' ? 'piece white' : null),
      },
    ];
    expect(filterGhostPieces(pieces)).toHaveLength(1);
  });

  it('handles empty and iterable inputs', () => {
    expect(filterGhostPieces([])).toEqual([]);
  });
});
