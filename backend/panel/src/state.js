// Shared mutable state for the panel UI.
// Plan §2.1: prerequisite for moving stateful renderers
// (renderEvalGraph/renderBoard/renderPVs) out of backend/panel/index.html
// into their own modules. All renderers read/write this single object so
// ES modules can share state without circular imports or a global pollution
// hack.
//
// Kept intentionally untyped (plain object) so the panel monolith can keep
// mutating properties via `state.xxx = ...` during its incremental refactor.

export const state = {
  // WebSocket
  ws: null,
  wsBackoff: 1000,

  // Engine / search data
  currentData: {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    lines: [],
  },
  selectedPV: 1,
  evalHistory: /** @type {Array<{ cp: number }>} */ ([]),

  // Search config
  searchMovetime: /** @type {number | null} */ (null),
  searchNodes: /** @type {number | null} */ (null),

  // TTS
  voiceEnabled: false,
  lastSpoken: '',

  // Game metadata
  gameInfo: {
    white: { name: '', clock: '' },
    black: { name: '', clock: '' },
    moveNumber: 0,
  },

  // Board appearance (keys into BOARD_THEMES / PIECE_SETS in ./board.js)
  currentBoardTheme: 'classic',
  currentPieceSet: 'classic',
};
