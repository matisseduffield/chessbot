import { describe, it, expect } from 'vitest';
import { parseClockText, classifyTimeControl, pickSafeMoveTime } from './clock';

describe('parseClockText', () => {
  it('parses MM:SS', () => {
    expect(parseClockText('1:23')).toBe(83_000);
    expect(parseClockText('01:23')).toBe(83_000);
    expect(parseClockText('0:30')).toBe(30_000);
  });
  it('parses H:MM:SS', () => {
    expect(parseClockText('1:02:30')).toBe(3_750_000);
  });
  it('parses fractional bullet clock "4.9"', () => {
    expect(parseClockText('4.9')).toBe(4900);
    expect(parseClockText('0.2')).toBe(200);
  });
  it('parses MM:SS.f', () => {
    expect(parseClockText('0:04.9')).toBe(4900);
    expect(parseClockText('1:23.4')).toBe(83_400);
  });
  it('returns null for nonsense', () => {
    expect(parseClockText('')).toBe(null);
    expect(parseClockText(null)).toBe(null);
    expect(parseClockText(undefined)).toBe(null);
    expect(parseClockText('abc')).toBe(null);
    expect(parseClockText('1:99')).toBe(null); // minutes ≥ 60
    expect(parseClockText('1:02:99')).toBe(null);
  });
  it('tolerates surrounding whitespace', () => {
    expect(parseClockText('  1:00  ')).toBe(60_000);
  });
});

describe('classifyTimeControl', () => {
  it('maps common presets', () => {
    expect(classifyTimeControl(15, 0)).toBe('ultrabullet');
    expect(classifyTimeControl(60, 0)).toBe('bullet');
    expect(classifyTimeControl(180, 0)).toBe('blitz');
    expect(classifyTimeControl(300, 0)).toBe('blitz');
    expect(classifyTimeControl(600, 0)).toBe('rapid');
    expect(classifyTimeControl(1800, 0)).toBe('classical');
  });
  it('accounts for increment in the budget', () => {
    // 2+1 -> 2*60 + 40*1 = 160 -> bullet
    expect(classifyTimeControl(120, 1)).toBe('bullet');
    // 3+2 -> 180 + 80 = 260 -> blitz
    expect(classifyTimeControl(180, 2)).toBe('blitz');
  });
});

describe('pickSafeMoveTime', () => {
  it('uses 10% of remaining time by default', () => {
    expect(pickSafeMoveTime(60_000)).toBe(5800); // (60000-2000)*0.1
  });
  it('honours hardCapMs', () => {
    expect(pickSafeMoveTime(120_000, { hardCapMs: 3000 })).toBe(3000);
  });
  it('returns null for no clock info', () => {
    expect(pickSafeMoveTime(null)).toBe(null);
    expect(pickSafeMoveTime(undefined)).toBe(null);
    expect(pickSafeMoveTime(0)).toBe(null);
  });
  it('falls back to minMs when reserve would starve the engine', () => {
    // 500 ms remaining - 2000 reserve = negative → minMs floor
    const out = pickSafeMoveTime(500);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(500);
  });
  it('respects custom fraction', () => {
    expect(pickSafeMoveTime(60_000, { fraction: 0.2 })).toBe(11_600);
  });
  it('never returns more than hardCap even with generous clock', () => {
    expect(pickSafeMoveTime(3_600_000, { hardCapMs: 1500 })).toBe(1500);
  });
});
