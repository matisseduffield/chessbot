import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  DEPTH_CYCLE,
  MULTIPV_CYCLE,
  nextDepth,
  nextMultiPV,
  nextInCycle,
  isPlainKeystrokeOk,
  formatDepthForToast,
  formatMultiPVForToast,
} from './hotkeys.js';

describe('nextInCycle', () => {
  it('walks the cycle in order and wraps to the start', () => {
    expect(nextInCycle([1, 2, 3], 1)).toBe(2);
    expect(nextInCycle([1, 2, 3], 2)).toBe(3);
    expect(nextInCycle([1, 2, 3], 3)).toBe(1);
  });

  it('snaps to the closest cycle entry when current is outside the cycle', () => {
    expect(nextInCycle([10, 20, 30], 18)).toBe(20);
    expect(nextInCycle([10, 20, 30], 11)).toBe(10);
  });
});

describe('nextDepth', () => {
  it('cycles through DEPTH_CYCLE and back to the start', () => {
    let d = DEPTH_CYCLE[0];
    const seen = [d];
    for (let i = 0; i < DEPTH_CYCLE.length; i++) {
      d = nextDepth(d);
      seen.push(d);
    }
    // After length+1 steps we should have seen each entry once and
    // returned to the start.
    expect(seen[seen.length - 1]).toBe(DEPTH_CYCLE[0]);
    expect(new Set(seen).size).toBe(DEPTH_CYCLE.length);
  });

  it('treats 0 as a valid cycle entry (infinite analysis)', () => {
    expect(DEPTH_CYCLE).toContain(0);
    // From 0 we should advance to the first non-zero entry.
    const next = nextDepth(0);
    expect(next).toBe(DEPTH_CYCLE[0]);
  });

  it('snaps a non-cycle depth to the nearest cycle entry', () => {
    // 17 is closer to 15 than to 20.
    expect(nextDepth(17)).toBe(15);
  });
});

describe('nextMultiPV', () => {
  it('cycles 1 → 3 → 5 → 1', () => {
    expect(nextMultiPV(1)).toBe(3);
    expect(nextMultiPV(3)).toBe(5);
    expect(nextMultiPV(5)).toBe(1);
  });

  it('snaps a non-cycle multiPV to the nearest cycle entry', () => {
    expect(nextMultiPV(2)).toBe(1);
    expect(nextMultiPV(4)).toBe(3);
  });
});

describe('isPlainKeystrokeOk', () => {
  let dom, doc, win;

  beforeEach(() => {
    dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="page"></div>
      <input id="search" />
      <textarea id="chat"></textarea>
      <select id="dropdown"><option>x</option></select>
      <div id="rich" contenteditable="true"></div>
    </body></html>`);
    doc = dom.window.document;
    win = dom.window;
  });

  afterEach(() => {
    dom.window.close();
  });

  function fakeEvent({
    target,
    ctrlKey = false,
    metaKey = false,
    altKey = false,
    shiftKey = false,
  }) {
    return {
      target,
      ctrlKey,
      metaKey,
      altKey,
      shiftKey,
    };
  }

  it('returns true for plain key on a non-input element', () => {
    expect(isPlainKeystrokeOk(fakeEvent({ target: doc.getElementById('page') }))).toBe(true);
  });

  it('returns false when modifier keys are held', () => {
    const target = doc.getElementById('page');
    expect(isPlainKeystrokeOk(fakeEvent({ target, ctrlKey: true }))).toBe(false);
    expect(isPlainKeystrokeOk(fakeEvent({ target, metaKey: true }))).toBe(false);
    expect(isPlainKeystrokeOk(fakeEvent({ target, altKey: true }))).toBe(false);
    expect(isPlainKeystrokeOk(fakeEvent({ target, shiftKey: true }))).toBe(false);
  });

  it('returns false when typing into an input', () => {
    expect(isPlainKeystrokeOk(fakeEvent({ target: doc.getElementById('search') }))).toBe(false);
  });

  it('returns false when typing into a textarea', () => {
    expect(isPlainKeystrokeOk(fakeEvent({ target: doc.getElementById('chat') }))).toBe(false);
  });

  it('returns false when interacting with a select', () => {
    expect(isPlainKeystrokeOk(fakeEvent({ target: doc.getElementById('dropdown') }))).toBe(false);
  });

  it('returns false when target is contenteditable', () => {
    const rich = doc.getElementById('rich');
    expect(isPlainKeystrokeOk(fakeEvent({ target: rich }))).toBe(false);
  });

  it('returns true when target is null (page-level keystroke)', () => {
    expect(isPlainKeystrokeOk(fakeEvent({ target: null }))).toBe(true);
  });
});

describe('format helpers', () => {
  it('formats finite depth normally', () => {
    expect(formatDepthForToast(20)).toBe('depth 20');
  });

  it('renders depth=0 as infinite', () => {
    expect(formatDepthForToast(0)).toBe('depth ∞');
  });

  it('formats Multi-PV', () => {
    expect(formatMultiPVForToast(3)).toBe('Multi-PV 3');
  });
});
