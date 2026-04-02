import { useState, useCallback } from 'react'

const SETTINGS = [
  {
    key: 'depth',
    label: 'Search Depth',
    uciName: null, // depth is sent per-request, not a UCI option
    type: 'range',
    min: 1,
    max: 30,
    default: 15,
    desc: 'How many moves ahead the engine looks',
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
    key: 'multiPV',
    label: 'Lines (MultiPV)',
    uciName: 'MultiPV',
    type: 'range',
    min: 1,
    max: 5,
    default: 1,
    desc: 'Number of best lines to calculate',
  },
  {
    key: 'skillLevel',
    label: 'Skill Level',
    uciName: 'Skill Level',
    type: 'range',
    min: 0,
    max: 20,
    default: 20,
    desc: '0 = weakest, 20 = maximum strength',
  },
  {
    key: 'showWDL',
    label: 'Show Win/Draw/Loss',
    uciName: 'UCI_ShowWDL',
    type: 'toggle',
    default: false,
    desc: 'Display win probability percentages',
  },
]

function sendToContentScript(name, value) {
  chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'set_option', name, value })
    }
  })
}

export default function SettingsTab() {
  const [values, setValues] = useState(() => {
    const stored = {}
    SETTINGS.forEach((s) => {
      const saved = localStorage.getItem(`chessbot_${s.key}`)
      stored[s.key] = saved !== null ? JSON.parse(saved) : s.default
    })
    return stored
  })

  const update = useCallback((setting, raw) => {
    const value = setting.type === 'toggle' ? raw : Number(raw)
    setValues((prev) => ({ ...prev, [setting.key]: value }))
    localStorage.setItem(`chessbot_${setting.key}`, JSON.stringify(value))

    if (setting.uciName) {
      const uciVal = setting.type === 'toggle' ? (value ? 'true' : 'false') : String(value)
      sendToContentScript(setting.uciName, uciVal)
    }
  }, [])

  return (
    <div className="settings-tab">
      {SETTINGS.map((s) => (
        <div className="setting-row" key={s.key}>
          <div className="setting-header">
            <label className="setting-label">{s.label}</label>
            <span className="setting-value">
              {s.type === 'toggle'
                ? (values[s.key] ? 'On' : 'Off')
                : values[s.key]}
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
    </div>
  )
}
