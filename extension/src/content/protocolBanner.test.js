import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  showProtocolMismatchBanner,
  hideProtocolMismatchBanner,
  isProtocolMismatch,
} from './protocolBanner.js';

// `isProtocolMismatch` is re-exported from @chessbot/shared by
// protocolBanner.js so call sites have one import; the predicate
// itself is tested in shared/src/version.test.ts. We keep a small
// smoke test here to lock the re-export in.

let dom;
let doc;

beforeEach(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  doc = dom.window.document;
});

afterEach(() => {
  dom.window.close();
});

describe('isProtocolMismatch', () => {
  it('returns false for matching versions', () => {
    expect(isProtocolMismatch(1, 1)).toBe(false);
  });
  it('returns true for differing numeric versions', () => {
    expect(isProtocolMismatch(1, 2)).toBe(true);
    expect(isProtocolMismatch(2, 1)).toBe(true);
  });
  it('returns false for non-numeric server values (older backend, no signal)', () => {
    expect(isProtocolMismatch(1, undefined)).toBe(false);
    expect(isProtocolMismatch(1, null)).toBe(false);
    expect(isProtocolMismatch(1, '1')).toBe(false);
    expect(isProtocolMismatch(1, NaN)).toBe(false);
    expect(isProtocolMismatch(1, Infinity)).toBe(false);
  });
});

describe('showProtocolMismatchBanner', () => {
  it('appends a banner with both version numbers', () => {
    showProtocolMismatchBanner({ extensionVersion: 1, serverVersion: 2, doc });
    const el = doc.getElementById('chessbot-protocol-banner');
    expect(el).not.toBeNull();
    expect(el.textContent).toContain('v1');
    expect(el.textContent).toContain('v2');
  });

  it('is idempotent — second call updates in place rather than stacking', () => {
    showProtocolMismatchBanner({ extensionVersion: 1, serverVersion: 2, doc });
    showProtocolMismatchBanner({ extensionVersion: 1, serverVersion: 3, doc });
    const all = doc.querySelectorAll('#chessbot-protocol-banner');
    expect(all.length).toBe(1);
    expect(all[0].textContent).toContain('v3');
  });

  it('renders a Dismiss button that removes the banner', () => {
    showProtocolMismatchBanner({ extensionVersion: 1, serverVersion: 2, doc });
    const btn = doc.getElementById('chessbot-protocol-banner').querySelector('button');
    expect(btn.textContent).toBe('Dismiss');
    btn.click();
    expect(doc.getElementById('chessbot-protocol-banner')).toBeNull();
  });

  it('invokes onDismiss when the user clicks Dismiss', () => {
    let dismissed = 0;
    showProtocolMismatchBanner({
      extensionVersion: 1,
      serverVersion: 2,
      onDismiss: () => dismissed++,
      doc,
    });
    doc.getElementById('chessbot-protocol-banner').querySelector('button').click();
    expect(dismissed).toBe(1);
  });

  it('does not interpret version values as HTML', () => {
    // Defence in depth — versions are numeric but we should still
    // textContent-set so a future field can't slip XSS in.
    showProtocolMismatchBanner({
      extensionVersion: 1,
      // @ts-expect-error — we deliberately pass a string for this test
      serverVersion: '<img src=x onerror=alert(1)>',
      doc,
    });
    const el = doc.getElementById('chessbot-protocol-banner');
    expect(el.querySelector('img')).toBeNull();
  });
});

describe('hideProtocolMismatchBanner', () => {
  it('removes the banner if present', () => {
    showProtocolMismatchBanner({ extensionVersion: 1, serverVersion: 2, doc });
    expect(doc.getElementById('chessbot-protocol-banner')).not.toBeNull();
    hideProtocolMismatchBanner({ doc });
    expect(doc.getElementById('chessbot-protocol-banner')).toBeNull();
  });

  it('is a no-op when no banner is present', () => {
    expect(() => hideProtocolMismatchBanner({ doc })).not.toThrow();
  });
});
