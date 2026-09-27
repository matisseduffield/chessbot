import { it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { initWorkspaceView } from './workspaceView.js';
it('focus preserves access to advanced controls and remembers the selection', () => {
  const { window } = new JSDOM(
    '<button data-workspace-view="focus"></button><button data-workspace-view="all"></button><section class="settings-group" data-section-id="analysis"></section><section class="settings-group" data-section-id="appearance"></section>',
    { url: 'http://localhost' },
  );
  const doc = window.document,
    relayout = vi.fn();
  const stop = initWorkspaceView(doc, window.localStorage, relayout);
  expect(doc.querySelector('[data-section-id="analysis"]').hidden).toBe(false);
  expect(doc.querySelector('[data-section-id="appearance"]').hidden).toBe(true);
  doc.querySelector('[data-workspace-view="all"]').click();
  expect(doc.querySelector('[data-section-id="appearance"]').hidden).toBe(false);
  expect(window.localStorage.getItem('chessbot_workspace_view')).toBe('all');
  expect(relayout).toHaveBeenCalledTimes(2);
  stop();
});
