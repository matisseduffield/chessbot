export default function StatusTab({ connected, enabled, onToggle }) {
  return (
    <div className="status-tab">
      <div className="status-card">
        <div className="status-icon-wrap">
          <div className={`status-icon ${connected ? 'online' : 'offline'}`}>
            {connected ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <circle cx="12" cy="20" r="1" fill="currentColor" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
                <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <circle cx="12" cy="20" r="1" fill="currentColor" />
              </svg>
            )}
          </div>
        </div>
        <div className="status-text">
          <span className="status-label">{connected ? 'Engine Online' : 'Engine Offline'}</span>
          <span className="status-sub">
            {connected ? 'Stockfish is ready for analysis' : 'Run: cd backend && npm start'}
          </span>
        </div>
      </div>

      <button
        className={`power-btn ${enabled ? 'on' : 'off'}`}
        onClick={onToggle}
        title={enabled ? 'Disable analysis' : 'Enable analysis'}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
          <line x1="12" y1="2" x2="12" y2="12" />
        </svg>
        <span>{enabled ? 'Analysis On' : 'Analysis Off'}</span>
      </button>

      <div className="info-cards">
        <div className="info-card">
          <span className="info-icon">♟</span>
          <div>
            <span className="info-title">chess.com</span>
            <span className="info-sub">Supported</span>
          </div>
        </div>
        <div className="info-card">
          <span className="info-icon">♞</span>
          <div>
            <span className="info-title">lichess.org</span>
            <span className="info-sub">Supported</span>
          </div>
        </div>
      </div>
    </div>
  )
}
