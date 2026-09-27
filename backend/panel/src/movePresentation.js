// Shared colours keep the selected board arrow and its answer card in sync.
export const PV_COLORS = [
  '#2ecc71',
  '#00bcd4',
  '#f39c12',
  '#e74c3c',
  '#9b59b6',
  '#e67e22',
  '#1abc9c',
  '#e84393',
];

/** Human-readable coordinates without interpreting unverified variant rules. */
export function moveRoute(move = '') {
  const drop = move.match(/^([a-z])@([a-z]\d+)$/i);
  if (drop) return `${drop[1].toUpperCase()} @ ${drop[2]}`;
  const squares = move.match(/^([a-z]\d+)([a-z]\d+)([a-z])?$/i);
  if (!squares) return move;
  return `${squares[1]} → ${squares[2]}${squares[3] ? ` =${squares[3].toUpperCase()}` : ''}`;
}
