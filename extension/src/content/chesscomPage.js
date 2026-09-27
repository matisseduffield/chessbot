import { startPositionPublisher } from './chesscomPublisher.js';

let stop = startPositionPublisher(document, window);
addEventListener('pagehide', () => {
  stop?.();
  stop = null;
});
addEventListener('pageshow', () => {
  if (!stop) stop = startPositionPublisher(document, window);
});
