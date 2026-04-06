import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [enabled, setEnabled] = useState(true)
  const [connected, setConnected] = useState(false)
  const [copied, setCopied] = useState(false)

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
    const next = !enabled
    setEnabled(next)
    chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'toggle', enabled: next }, () => {
          void chrome.runtime.lastError
        })
      }
    })
  }

  const openPanel = () => {
    chrome.tabs.create({ url: 'http://localhost:8080' })
  }

  const copyLogs = () => {
    chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'get_logs' }, (resp) => {
          if (chrome.runtime.lastError || !resp?.logs) {
            navigator.clipboard.writeText('No logs available (content script not loaded)')
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

  return (
    <div className="popup">
      <header className="header">
        <div className="header-left">
          <span className="logo">&#9823;</span>
          <span className="title">Chess Helper</span>
        </div>
        <span className={`status-dot ${connected ? 'green' : 'red'}`} title={connected ? 'Connected' : 'Offline'} />
      </header>

      <div className="popup-body">
        <button
          className={`power-btn ${enabled ? 'on' : 'off'}`}
          onClick={toggle}
          title={enabled ? 'Disable analysis' : 'Enable analysis'}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
          <span>{enabled ? 'Analysis On' : 'Analysis Off'}</span>
        </button>

        <button className="panel-btn" onClick={openPanel}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
          </svg>
          <span>Open Dashboard</span>
        </button>

        <button className={`panel-btn ${copied ? 'copied' : ''}`} onClick={copyLogs}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          <span>{copied ? 'Copied!' : 'Copy Logs'}</span>
        </button>
      </div>
    </div>
  )
}

export default App
