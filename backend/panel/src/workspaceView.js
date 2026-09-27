const KEY = 'chessbot_workspace_view';
const CORE = new Set(['analysis', 'search-limits', 'engine', 'training']);

export function initWorkspaceView(doc, storage, relayout) {
  const buttons = [...doc.querySelectorAll('[data-workspace-view]')];
  let view = 'focus';
  try {
    if (storage.getItem(KEY) === 'all') view = 'all';
  } catch {
    /* optional preference */
  }
  function apply(next) {
    view = next === 'all' ? 'all' : 'focus';
    for (const el of doc.querySelectorAll('.settings-group[data-section-id]'))
      el.hidden = view === 'focus' && !CORE.has(el.dataset.sectionId);
    for (const button of buttons)
      button.setAttribute('aria-pressed', String(button.dataset.workspaceView === view));
    const note = doc.querySelector('#workspace-note');
    if (note)
      note.textContent =
        view === 'focus'
          ? 'Search settings and training tools. Everything else is in All settings.'
          : 'All controls. Drag section headings to arrange your workspace.';
    try {
      storage.setItem(KEY, view);
    } catch {
      /* private browsing */
    }
    relayout();
  }
  const handlers = buttons.map((button) => {
    const handler = () => apply(button.dataset.workspaceView);
    button.addEventListener('click', handler);
    return [button, handler];
  });
  apply(view);
  return () =>
    handlers.forEach(([button, handler]) => button.removeEventListener('click', handler));
}
