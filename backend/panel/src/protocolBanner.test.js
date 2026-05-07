import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { showProtocolMismatchBanner, hideProtocolMismatchBanner } from './protocolBanner.js';

let dom;
let doc;

beforeEach(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body><main>panel content</main></body></html>');
  doc = dom.window.document;
});

afterEach(() => {
  dom.window.close();
});

describe('panel protocolBanner', () => {
  it('renders both version numbers in the message', () => {
    showProtocolMismatchBanner({ panelVersion: 1, serverVersion: 3, doc });
    const el = doc.getElementById('chessbot-panel-protocol-banner');
    expect(el).not.toBeNull();
    expect(el.textContent).toContain('v1');
    expect(el.textContent).toContain('v3');
  });

  it('inserts the banner as the first child of body so it sits above the dashboard', () => {
    showProtocolMismatchBanner({ panelVersion: 1, serverVersion: 2, doc });
    expect(doc.body.firstElementChild?.id).toBe('chessbot-panel-protocol-banner');
  });

  it('is idempotent — second call updates in place', () => {
    showProtocolMismatchBanner({ panelVersion: 1, serverVersion: 2, doc });
    showProtocolMismatchBanner({ panelVersion: 1, serverVersion: 5, doc });
    const matches = doc.querySelectorAll('#chessbot-panel-protocol-banner');
    expect(matches.length).toBe(1);
    expect(matches[0].textContent).toContain('v5');
  });

  it('Dismiss button removes the banner and fires onDismiss', () => {
    let dismissed = 0;
    showProtocolMismatchBanner({
      panelVersion: 1,
      serverVersion: 2,
      doc,
      onDismiss: () => dismissed++,
    });
    doc.getElementById('chessbot-panel-protocol-banner').querySelector('button').click();
    expect(doc.getElementById('chessbot-panel-protocol-banner')).toBeNull();
    expect(dismissed).toBe(1);
  });

  it('hide is a no-op when no banner is present', () => {
    expect(() => hideProtocolMismatchBanner({ doc })).not.toThrow();
  });
});
