import { captureBotPosition, SNAPSHOT_ATTRIBUTE, SNAPSHOT_EVENT } from './chesscomSnapshot.js';

let previousBoard,
  previousValue = '',
  lastPublished = 0;
function publish() {
  const board = document.querySelector('#board-play-computer');
  const snapshot = captureBotPosition(board, location.href);
  if (previousBoard && previousBoard !== board) previousBoard.removeAttribute(SNAPSHOT_ATTRIBUTE);
  previousBoard = board;
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
  if (changed) board.dispatchEvent(new CustomEvent(SNAPSHOT_EVENT, { bubbles: true }));
}
let interval = setInterval(publish, 250);
addEventListener('pagehide', () => {
  clearInterval(interval);
  interval = null;
  previousBoard?.removeAttribute(SNAPSHOT_ATTRIBUTE);
});
addEventListener('pageshow', () => {
  if (interval === null) interval = setInterval(publish, 250);
  previousValue = '';
  publish();
});
publish();
