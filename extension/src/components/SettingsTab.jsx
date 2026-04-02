import { useState, useEffect, useCallback } from 'react'

// ── UCI engine settings ──────────────────────────────────
const ENGINE_SETTINGS = [
  {
    key: 'depth',
    label: 'Search Depth',
    uciName: null,
    type: 'range',
    min: 1,
    max: 30,
    default: 15,
    desc: 'How many moves ahead the engine searches',
  },
  {
    key: 'multiPV',
    label: 'Lines (MultiPV)',
    uciName: 'MultiPV',
    type: 'range',
    min: 1,
    max: 5,
    default: 1,
    desc: 'Number of best lines to show on the board',
  },
  {
    key: 'threads',
    label: 'Threads',
    uciName: 'Threads',
    type: 'range',
    min: 1,
    max: navigator.hardwareConcurrency || 8,
    default: 1,
    desc: 'CPU threads for parallel search',
  },
  {
    key: 'hash',
    label: 'Hash (MB)',
    uciName: 'Hash',
    type: 'select',
    options: [16, 32, 64, 128, 256, 512, 1024],
    default: 16,
    desc: 'Transposition table memory',
  },
  {
    key: 'skillLevel',
    label: 'Skill Level',
    uciName: 'Skill Level',
    type: 'range',
    min: 0,
    max: 20,
    default: 20,
    desc: '0 = weakest, 20 = full strength',
  },
  {
    key: 'showWDL',
    label: 'Show Win/Draw/Loss',
    uciName: 'UCI_ShowWDL',
    type: 'toggle',
    default: true,
    desc: 'Display win probability bar',
  },
]

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, msg, (resp) => resolve(resp))
      } else {
        resolve(null)
      }
    })
  })
}

function sendOption(name, value) {
  chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'set_option', name, value })
    }
  })
}

function SectionHeader({ icon, title }) {
  return (
    <div className="section-header">
      <span className="section-icon">{icon}</span>
      <span className="section-title">{title}</span>
    </div>
  )
}

export default function SettingsTab() {
  const [values, setValues] = useState(() => {
    const stored = {}
    ENGINE_SETTINGS.forEach((s) => {
      const saved = localStorage.getItem(`chessbot_${s.key}`)
      stored[s.key] = saved !== null ? JSON.parse(saved) : s.default
    })
    return stored
  })

  const [engines, setEngines] = useState([])
  const [books, setBooks] = useState([])
  const [syzygy, setSyzygy] = useState([])
  const [activeEngine, setActiveEngine] = useState('')
  const [activeBook, setActiveBook] = useState('')
  const [activeSyzygy, setActiveSyzygy] = useState('')
  const [switching, setSwitching] = useState(null)

  useEffect(() => {
    sendMsg({ type: 'list_files' }).then((resp) => {
      if (resp && resp.type === 'files') {
        setEngines(resp.engines || [])
        setBooks(resp.books || [])
        setSyzygy(resp.syzygy || [])
        setActiveEngine(resp.activeEngine || '')
        setActiveBook(resp.activeBook || '')
        setActiveSyzygy(resp.activeSyzygy || '')
      }
    })
  }, [])

  const update = useCallback((setting, raw) => {
    const value = setting.type === 'toggle' ? raw : Number(raw)
    setValues((prev) => ({ ...prev, [setting.key]: value }))
    localStorage.setItem(`chessbot_${setting.key}`, JSON.stringify(value))
    if (setting.key === 'depth') {
      sendMsg({ type: 'set_depth', value: Number(value) })
    } else if (setting.uciName) {
      const uciVal = setting.type === 'toggle' ? (value ? 'true' : 'false') : String(value)
      sendOption(setting.uciName, uciVal)
    }
  }, [])

  const switchResource = useCallback(async (type, name) => {
    setSwitching(type)
    const resp = await sendMsg({ type: `switch_${type}`, name })
    setSwitching(null)
    if (resp?.type === 'error') return
    if (type === 'engine') setActiveEngine(name)
    if (type === 'book') setActiveBook(name || '')
    if (type === 'syzygy') setActiveSyzygy(name || '')
  }, [])

  return (
    <div className="settings-tab">

      <SectionHeader icon="⚙" title="Engine Settings" />

      {ENGINE_SETTINGS.map((s) => (
        <div className="setting-row" key={s.key}>
          <div className="setting-header">
            <label className="setting-label">{s.label}</label>
            <span className="setting-value">
              {s.type === 'toggle' ? (values[s.key] ? 'On' : 'Off') : values[s.key]}
            </span>
          </div>

          {s.type === 'range' && (
            <input
              type="range"
              min={s.min}
              max={s.max}
              value={values[s.key]}
              onChange={(e) => update(s, e.target.value)}
              className="setting-slider"
            />
          )}

          {s.type === 'select' && (
            <select
              value={values[s.key]}
              onChange={(e) => update(s, e.target.value)}
              className="setting-select"
            >
              {s.options.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          )}

          {s.type === 'toggle' && (
            <button
              className={`mini-toggle ${values[s.key] ? 'on' : 'off'}`}
              onClick={() => update(s, !values[s.key])}
            >
              <span className="mini-toggle-thumb" />
            </button>
          )}

          <p className="setting-desc">{s.desc}</p>
        </div>
      ))}

      <SectionHeader icon="📂" title="Resources" />

      <div className="setting-row">
        <div className="setting-header">
          <label className="setting-label">Engine</label>
          {switching === 'engine'
            ? <span className="setting-badge switching">Switching…</span>
            : activeEngine && <span className="setting-badge active">Active</span>}
        </div>
        {engines.length > 0 ? (
          <select
            value={activeEngine}
            onChange={(e) => switchResource('engine', e.target.value)}
            className="setting-select"
            disabled={switching === 'engine'}
          >
            {engines.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
        ) : (
          <p className="setting-empty">No engines found in engine/</p>
        )}
        <p className="setting-desc">Place engine executables in the engine/ folder</p>
      </div>

      <div className="setting-row">
        <div className="setting-header">
          <label className="setting-label">Opening Book</label>
          {switching === 'book'
            ? <span className="setting-badge switching">Switching…</span>
            : activeBook && <span className="setting-badge active">Active</span>}
        </div>
        <select
          value={activeBook}
          onChange={(e) => switchResource('book', e.target.value)}
          className="setting-select"
          disabled={switching === 'book'}
        >
          <option value="">None (disabled)</option>
          {books.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <p className="setting-desc">Place Polyglot .bin files in books/</p>
      </div>

      <div className="setting-row">
        <div className="setting-header">
          <label className="setting-label">Endgame Tablebases</label>
          {switching === 'syzygy'
            ? <span className="setting-badge switching">Switching…</span>
            : activeSyzygy && <span className="setting-badge active">Active</span>}
        </div>
        <select
          value={activeSyzygy}
          onChange={(e) => switchResource('syzygy', e.target.value)}
          className="setting-select"
          disabled={switching === 'syzygy'}
        >
          <option value="">None (disabled)</option>
          {syzygy.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <p className="setting-desc">Place Syzygy .rtbw/.rtbz files in syzygy/</p>
      </div>

      <SectionHeader icon="⬇" title="Downloads" />

      <div className="download-links">
        <a href="https://stockfishchess.org/download/" target="_blank" rel="noreferrer" className="download-link">
          <span className="dl-icon">♚</span>
          <div>
            <span className="dl-title">Stockfish Engine</span>
            <span className="dl-sub">stockfishchess.org/download</span>
          </div>
        </a>
        <a href="https://rebel13.nl/download/books.html" target="_blank" rel="noreferrer" className="download-link">
          <span className="dl-icon">📖</span>
          <div>
            <span className="dl-title">Opening Books</span>
            <span className="dl-sub">rebel13.nl — Polyglot .bin</span>
          </div>
        </a>
        <a href="https://syzygy-tables.info/" target="_blank" rel="noreferrer" className="download-link">
          <span className="dl-icon">🗄</span>
          <div>
            <span className="dl-title">Syzygy Tablebases</span>
            <span className="dl-sub">syzygy-tables.info — 3-5 piece</span>
          </div>
        </a>
      </div>
    </div>
  )
}
