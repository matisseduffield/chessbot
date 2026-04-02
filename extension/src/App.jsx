import { useState, useEffect } from 'react'
import StatusTab from './components/StatusTab'
import SettingsTab from './components/SettingsTab'
import './App.css'

function App() {
  const [tab, setTab] = useState('status')
  const [enabled, setEnabled] = useState(true)
  const [connected, setConnected] = useState(false)

  // Check WS backend connectivity
  useEffect(() => {
    let ws
    try {
      ws = new WebSocket('ws://localhost:8080')
      ws.onopen = () => { setConnected(true); ws.close() }
      ws.onerror = () => setConnected(false)
    } catch {
      setConnected(false)
    }
    return () => { if (ws) ws.close() }
  }, [])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'toggle', enabled: next })
      }
    })
  }

  return (
    <div className="popup">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <span className="logo">&#9823;</span>
          <span className="title">Chess Helper</span>
        </div>
        <span className={`status-dot ${connected ? 'green' : 'red'}`} title={connected ? 'Connected' : 'Offline'} />
      </header>

      {/* Tab bar */}
      <nav className="tab-bar">
        <button
          className={`tab-btn ${tab === 'status' ? 'active' : ''}`}
          onClick={() => setTab('status')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          Status
        </button>
        <button
          className={`tab-btn ${tab === 'settings' ? 'active' : ''}`}
          onClick={() => setTab('settings')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          Settings
        </button>
      </nav>

      {/* Content */}
      <div className="tab-content">
        {tab === 'status' && (
          <StatusTab connected={connected} enabled={enabled} onToggle={toggle} />
        )}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  )
}

export default App
