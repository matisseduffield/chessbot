import { useState, useEffect } from 'react'
import './App.css'
import {
  loadPopupSettings,
  savePopupSettings,
  subscribePopupSettings,
  DEFAULT_SETTINGS,
} from './popupSettings.js'

// Reads and clears chrome.runtime.lastError after a sendMessage callback.
// Returns true when an error was present so callers can early-return.
// Logs to the popup console with context so silent failures stop happening.
function consumeLastError(ctx) {
  const err = chrome.runtime?.lastError
  if (err) {
    console.warn(`[chessbot popup] ${ctx}:`, err.message || err)
    return true
  }
  return false
}

function App() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [connected, setConnected] = useState(false)
  const [copied, setCopied] = useState(false)

  // Load persisted state through the validated schema (popupSettings.js
  // applies defaults + repairs invalid storage entries), then query the
  // content script for live state. Cross-tab changes flow through the
  // subscription so two open popups stay consistent.
  useEffect(() => {
    let active = true
    loadPopupSettings(chrome.storage?.local).then(({ settings: loaded, repaired }) => {
      if (!active) return
      setSettings(loaded)
      if (repaired.length > 0) {
        // Heal storage so the bad values don't keep tripping the schema.
        savePopupSettings(chrome.storage?.local, loaded)
        console.warn('[chessbot popup] repaired invalid settings:', repaired)
      }
    })
    chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'get_status' }, (resp) => {
          if (consumeLastError('get_status') || !resp) return
          if (!active) return
          const live = {}
          if (typeof resp.enabled === 'boolean') live.enabled = resp.enabled
          if (resp.displayMode) live.displayMode = resp.displayMode
          if (Object.keys(live).length > 0) {
            setSettings((s) => ({ ...s, ...live }))
            // savePopupSettings drops any field that fails validation.
            savePopupSettings(chrome.storage?.local, live)
          }
          if (typeof resp.connected === 'boolean') setConnected(resp.connected)
        })
      }
    })
    const dispose = subscribePopupSettings(chrome.storage?.local, (next) => {
      if (!active) return
      setSettings((s) => ({ ...s, ...next }))
    })
    return () => {
      active = false
      dispose()
    }
  }, [])

  useEffect(() => {
    let ws
    const check = () => {
      try {
        ws = new WebSocket('ws://localhost:8080')
        ws.onopen = () => { setConnected(true); ws.close() }
        ws.onerror = () => setConnected(false)
      } catch {
        setConnected(false)
      }
    }
    check()
    const interval = setInterval(check, 5000)
    return () => {
      clearInterval(interval)
      if (ws && ws.readyState <= 1) ws.close()
    }
  }, [])

  const toggle = () => {
    const next = !settings.enabled
    setSettings((s) => ({ ...s, enabled: next }))
    savePopupSettings(chrome.storage?.local, { enabled: next })
    chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'toggle', enabled: next }, () => {
          consumeLastError('toggle')
        })
      }
    })
  }

  const openPanel = () => {
    chrome.tabs.create({ url: 'http://localhost:8080' })
  }

  const changeDisplayMode = async (mode) => {
    const r = await savePopupSettings(chrome.storage?.local, { displayMode: mode })
    if (!r.ok) {
      console.warn('[chessbot popup] rejected displayMode change:', r.error)
      return
    }
    setSettings((s) => ({ ...s, displayMode: mode }))
    chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'set_display_mode', value: mode }, () => {
          consumeLastError('set_display_mode')
        })
      }
    })
  }

  const copyLogs = () => {
    chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'get_all_logs' }, (resp) => {
          if (consumeLastError('get_all_logs') || !resp?.logs) {
            navigator.clipboard.writeText('No logs available (content script not loaded on this page)')
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
            return
          }
          navigator.clipboard.writeText(resp.logs).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          })
        })
      }
    })
  }

  const { enabled, displayMode } = settings

  return (
    <div className="popup">
      <header className="header">
        <div className="header-left">
          <img className="logo-icon" src="icons/icon128.png" alt="ChessBot" />
          <span className="title">ChessBot</span>
        </div>
        <div className="status-badge">
          <span className={`status-dot ${connected ? 'green' : 'red'}`} />
          <span className="status-text">{connected ? 'Connected' : 'Offline'}</span>
        </div>
      </header>

      <div className="popup-body">
        <button
          className={`power-btn ${enabled ? 'on' : 'off'}`}
          onClick={toggle}
          title={enabled ? 'Disable analysis' : 'Enable analysis'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
          <span>{enabled ? 'Analysis On' : 'Analysis Off'}</span>
        </button>

        <div className="divider" />

        <div className="display-mode">
          <span className="display-mode-label">Display Mode</span>
          <div className="display-mode-btns">
            <button
              className={`mode-btn ${displayMode === 'arrow' ? 'active' : ''}`}
              onClick={() => changeDisplayMode('arrow')}
              title="Show arrows only"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
              Arrow
            </button>
            <button
              className={`mode-btn ${displayMode === 'box' ? 'active' : ''}`}
              onClick={() => changeDisplayMode('box')}
              title="Show square highlights only"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
              Box
            </button>
            <button
              className={`mode-btn ${displayMode === 'both' ? 'active' : ''}`}
              onClick={() => changeDisplayMode('both')}
              title="Show both arrows and square highlights"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="7" y1="12" x2="17" y2="12" />
                <polyline points="13 8 17 12 13 16" />
              </svg>
              Both
            </button>
          </div>
        </div>

        <div className="divider" />

        <div className="action-btns">
          <button className="panel-btn primary" onClick={openPanel}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="9" y1="21" x2="9" y2="9" />
            </svg>
            <span>Dashboard</span>
          </button>

          <button className={`panel-btn ${copied ? 'copied' : ''}`} onClick={copyLogs}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <span>{copied ? 'Copied!' : 'Logs'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
