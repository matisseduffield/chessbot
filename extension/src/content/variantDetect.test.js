import { describe, it, expect } from 'vitest';
import { matchVariant, variantFromUrl, variantFromText } from './variantDetect.js';

describe('variantFromUrl — chessground (lichess / playstrategy)', () => {
  const cases = [
    ['/atomic/abcd', 'atomic'],
    ['/crazyhouse/abcd', 'crazyhouse'],
    ['/chess960/abcd', 'chess960'],
    ['/kingofthehill/abcd', 'kingofthehill'],
    ['/threecheck/abcd', '3check'],
    ['/three-check/abcd', '3check'],
    ['/antichess/abcd', 'antichess'],
    ['/giveaway/abcd', 'giveaway'],
    ['/horde/abcd', 'horde'],
    ['/racingkings/abcd', 'racingkings'],
    ['/racing-kings/abcd', 'racingkings'],
    ['/bughouse/abcd', 'bughouse'],
  ];
  for (const [path, key] of cases) {
    it(`maps ${path} → ${key}`, () => {
      expect(variantFromUrl(path, 'chessground')).toBe(key);
    });
  }

  it('maps five-check to its own backend variant (not folded into 3check)', () => {
    expect(variantFromUrl('/fivecheck/abcd', 'chessground')).toBe('5check');
    expect(variantFromUrl('/five-check/abcd', 'chessground')).toBe('5check');
  });

  it('maps no-castling to the nocastle backend variant', () => {
    expect(variantFromUrl('/nocastling/abcd', 'chessground')).toBe('nocastle');
    expect(variantFromUrl('/no-castling/abcd', 'chessground')).toBe('nocastle');
  });

  it('returns null for a plain game id', () => {
    expect(variantFromUrl('/AbCdEfGh', 'chessground')).toBe(null);
  });
});

describe('variantFromUrl — chess.com', () => {
  const cases = [
    ['/variants/chess960', 'chess960'],
    ['/play/atomic', 'atomic'],
    ['/live/crazyhouse', 'crazyhouse'],
    ['/variants/kingofthehill', 'kingofthehill'],
    ['/variants/king-of-the-hill', 'kingofthehill'],
    ['/variants/3-check', '3check'],
    ['/variants/antichess', 'antichess'],
    ['/variants/horde', 'horde'],
    ['/variants/racingkings', 'racingkings'],
    ['/variants/bughouse', 'bughouse'],
  ];
  for (const [path, key] of cases) {
    it(`maps ${path} → ${key}`, () => {
      expect(variantFromUrl(path, 'chesscom')).toBe(key);
    });
  }

  it('detects duck chess', () => {
    expect(variantFromUrl('/variants/duck', 'chesscom')).toBe('duck');
  });

  it('returns null for a plain game url', () => {
    expect(variantFromUrl('/game/live/123456', 'chesscom')).toBe(null);
  });
});

describe('variantFromText', () => {
  it('detects chess.com variants from a title', () => {
    expect(variantFromText(['Atomic • alice vs bob'], 'chesscom')).toBe('atomic');
    expect(variantFromText(['Duck Chess • alice vs bob'], 'chesscom')).toBe('duck');
  });

  it('folds chess.com "antichess" label into giveaway', () => {
    expect(variantFromText(['Antichess • alice vs bob'], 'chesscom')).toBe('giveaway');
  });

  it('maps chess.com "fischer random" to chess960', () => {
    expect(variantFromText(['Fischer Random • a vs b'], 'chesscom')).toBe('chess960');
  });

  it('detects lichess/playstrategy variants from label text', () => {
    expect(variantFromText(['ATOMIC'], 'chessground')).toBe('atomic');
    expect(variantFromText(['King of the Hill'], 'chessground')).toBe('kingofthehill');
    expect(variantFromText(['Five-check'], 'chessground')).toBe('5check');
    expect(variantFromText(['No Castling'], 'chessground')).toBe('nocastle');
  });

  it('matches hrefs with stripSpaces (e.g. /variant/kingofthehill)', () => {
    expect(variantFromText(['/variant/kingofthehill'], 'chessground', { stripSpaces: true })).toBe(
      'kingofthehill',
    );
  });

  it('returns the first matching candidate', () => {
    expect(variantFromText(['nothing here', 'Horde game'], 'chessground')).toBe('horde');
  });

  it('returns null when nothing matches', () => {
    expect(variantFromText(['just a normal game'], 'chesscom')).toBe(null);
    expect(variantFromText([], 'chessground')).toBe(null);
  });
});

describe('matchVariant', () => {
  it('returns null for non-string / empty input', () => {
    expect(matchVariant(CHESSGROUND_FIXTURE, null)).toBe(null);
    expect(matchVariant(CHESSGROUND_FIXTURE, '')).toBe(null);
  });
  it('respects order (first hit wins)', () => {
    const patterns = [
      ['check', 'first'],
      ['three-check', 'second'],
    ];
    expect(matchVariant(patterns, 'three-check')).toBe('first');
  });
});

const CHESSGROUND_FIXTURE = [['/atomic', 'atomic']];
