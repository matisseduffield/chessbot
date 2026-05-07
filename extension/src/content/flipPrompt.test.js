import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { showFlipPrompt, hideFlipPrompt, resolveFlip } from './flipPrompt.js';

let dom;
let doc;

beforeEach(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  doc = dom.window.document;
});

afterEach(() => {
  dom.window.close();
});

describe('showFlipPrompt', () => {
  it('appends a single badge to the body', () => {
    showFlipPrompt({ onSelect: () => {}, doc });
    expect(doc.querySelectorAll('#chessbot-flip-prompt').length).toBe(1);
  });

  it('is idempotent — second call updates in place', () => {
    showFlipPrompt({ onSelect: () => {}, doc });
    showFlipPrompt({ onSelect: () => {}, doc });
    expect(doc.querySelectorAll('#chessbot-flip-prompt').length).toBe(1);
  });

  it('renders a White button that calls onSelect("w") and removes the badge', () => {
    const fn = vi.fn();
    showFlipPrompt({ onSelect: fn, doc });
    const buttons = doc.querySelectorAll('#chessbot-flip-prompt button');
    // First two buttons are White / Black; third is Skip.
    /** @type {HTMLButtonElement} */ (buttons[0]).click();
    expect(fn).toHaveBeenCalledWith('w');
    expect(doc.getElementById('chessbot-flip-prompt')).toBeNull();
  });

  it('renders a Black button that calls onSelect("b")', () => {
    const fn = vi.fn();
    showFlipPrompt({ onSelect: fn, doc });
    const buttons = doc.querySelectorAll('#chessbot-flip-prompt button');
    /** @type {HTMLButtonElement} */ (buttons[1]).click();
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('Skip button calls onDismiss and removes the badge', () => {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    showFlipPrompt({ onSelect, onDismiss, doc });
    const buttons = doc.querySelectorAll('#chessbot-flip-prompt button');
    /** @type {HTMLButtonElement} */ (buttons[2]).click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
    expect(doc.getElementById('chessbot-flip-prompt')).toBeNull();
  });
});

describe('hideFlipPrompt', () => {
  it('removes the badge if present', () => {
    showFlipPrompt({ onSelect: () => {}, doc });
    hideFlipPrompt({ doc });
    expect(doc.getElementById('chessbot-flip-prompt')).toBeNull();
  });

  it('is a no-op when no badge is present', () => {
    expect(() => hideFlipPrompt({ doc })).not.toThrow();
  });
});

describe('resolveFlip', () => {
  it('resolves synchronously to true when confidence is "flipped"', () => {
    const fn = vi.fn();
    resolveFlip({ confidence: 'flipped', onResolve: fn, doc });
    expect(fn).toHaveBeenCalledWith(true);
    expect(doc.getElementById('chessbot-flip-prompt')).toBeNull();
  });

  it('resolves synchronously to false when confidence is "unflipped"', () => {
    const fn = vi.fn();
    resolveFlip({ confidence: 'unflipped', onResolve: fn, doc });
    expect(fn).toHaveBeenCalledWith(false);
  });

  it('shows the prompt when confidence is "unknown"', () => {
    const fn = vi.fn();
    resolveFlip({ confidence: 'unknown', onResolve: fn, doc });
    // Prompt is up; resolver hasn't fired yet.
    expect(doc.getElementById('chessbot-flip-prompt')).not.toBeNull();
    expect(fn).not.toHaveBeenCalled();
    // User clicks Black → resolver gets `true`.
    const buttons = doc.querySelectorAll('#chessbot-flip-prompt button');
    /** @type {HTMLButtonElement} */ (buttons[1]).click();
    expect(fn).toHaveBeenCalledWith(true);
  });

  it('returns a cancel function that hides the prompt for "unknown"', () => {
    const fn = vi.fn();
    const cancel = resolveFlip({ confidence: 'unknown', onResolve: fn, doc });
    expect(doc.getElementById('chessbot-flip-prompt')).not.toBeNull();
    cancel();
    expect(doc.getElementById('chessbot-flip-prompt')).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns a no-op cancel for synchronous resolutions', () => {
    const cancel = resolveFlip({ confidence: 'flipped', onResolve: () => {}, doc });
    expect(typeof cancel).toBe('function');
    expect(() => cancel()).not.toThrow();
  });
});
