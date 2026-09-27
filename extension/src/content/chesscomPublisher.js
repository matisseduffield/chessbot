import { captureBotPosition, SNAPSHOT_ATTRIBUTE, SNAPSHOT_EVENT } from './chesscomSnapshot.js';

// Observe the board, not the whole page. Publish on the next frame; retain
// the 250 ms fallback for API-only changes and board replacement.
export function startPositionPublisher(doc, host) {
  let previousBoard,
    previousValue = '',
    lastPublished = 0,
    frame = null;
  let observedShadow = null;
  const ownNode = (node) => node.nodeType === 3 || !!node.closest?.('[id^="chessbot-"]');
  const observerOptions = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  };
  const observer = new host.MutationObserver((mutations) => {
    if (
      mutations.every(
        (m) =>
          ownNode(m.target) ||
          (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(ownNode)),
      )
    )
      return;
    if (frame === null)
      frame = host.requestAnimationFrame(() => {
        frame = null;
        publish();
      });
  });
  function publish() {
    const board = doc.querySelector('#board-play-computer');
    if (board !== previousBoard) {
      previousBoard?.removeAttribute(SNAPSHOT_ATTRIBUTE);
      observer.disconnect();
      observedShadow = null;
      previousValue = '';
      if (board) observer.observe(board, observerOptions);
      previousBoard = board;
    }
    if (board?.shadowRoot && board.shadowRoot !== observedShadow) {
      observedShadow = board.shadowRoot;
      observer.observe(observedShadow, observerOptions);
    }
    const snapshot = captureBotPosition(board, doc.location.href);
    if (!snapshot) {
      board?.removeAttribute(SNAPSHOT_ATTRIBUTE);
      previousValue = '';
      return;
    }
    const value = JSON.stringify({ ...snapshot, at: 0 });
    const changed = value !== previousValue;
    if (!changed && snapshot.at - lastPublished < 1000) return;
    board.setAttribute(SNAPSHOT_ATTRIBUTE, JSON.stringify(snapshot));
    lastPublished = snapshot.at;
    previousValue = value;
    if (changed) board.dispatchEvent(new host.CustomEvent(SNAPSHOT_EVENT, { bubbles: true }));
  }
  const interval = host.setInterval(publish, 250);
  publish();
  return () => {
    host.clearInterval(interval);
    if (frame !== null) host.cancelAnimationFrame(frame);
    observer.disconnect();
    previousBoard?.removeAttribute(SNAPSHOT_ATTRIBUTE);
  };
}
