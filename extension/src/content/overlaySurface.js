// Scale a finished answer with the board, including between engine messages.
export function sizeOverlay(svg, rect, dx = 0, dy = 0) {
  svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  Object.assign(svg.style, { left: `${dx}px`, top: `${dy}px`, width: '100%', height: '100%' });
}
