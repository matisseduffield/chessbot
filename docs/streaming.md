# Streaming with chessbot

This guide covers how to run the chessbot dashboard while streaming so that
the dashboard does **not** appear in your broadcast — and, if you want, how
to view the dashboard from a separate device entirely.

> **Status.** Today this relies on OBS source selection + (optionally) a
> separate viewing device on your LAN. A first-class "stealth window"
> built on Electron's `setContentProtection(true)` is on the roadmap (see
> `plans/improvement-plan-v2.md` §1).

## What gets captured?

OBS / Streamlabs captures whatever sources you add to a scene. The
dashboard is just a webpage served by the local backend, so:

- **Display Capture / Screen Capture** captures everything visible on the
  monitor — including the dashboard. Avoid this if you don't want the
  dashboard on stream.
- **Window Capture** only captures the window you select. As long as the
  dashboard isn't part of the selected scene, it won't be broadcast.
- **Game Capture** only sees the targeted game/process.

## Recommended setups

### A. Single PC — keep the dashboard off-stream

1. In OBS, use **Window Capture** or **Game Capture** — never **Display
   Capture** of the monitor that holds the dashboard.
2. Open the dashboard at `http://localhost:8080/` in any browser window.
   Keep that window off your captured scene.
3. (Optional) Move the dashboard to a second monitor that no scene
   captures.

### B. Single PC + secondary device (phone / tablet / laptop)

This is the most reliable way to keep the dashboard fully invisible to
your capture software, since it lives on a different device entirely.

1. Stop the backend if it's running.
2. Start it in LAN mode by setting `BIND_HOST=0.0.0.0`:

   PowerShell:

   ```powershell
   $env:BIND_HOST="0.0.0.0"; npm start
   ```

   Bash / zsh:

   ```bash
   BIND_HOST=0.0.0.0 npm start
   ```

3. Find your PC's LAN IP (e.g. `ipconfig` on Windows, `ip a` on Linux,
   `ifconfig` on macOS). Look for something like `192.168.1.42`.
4. **Pair the secondary device with the PIN.** When LAN mode is active the
   backend prints a 6-digit PIN to its log, e.g.
   `[server] LAN PIN: 147065`. On the secondary device, browse to
   `http://<your-lan-ip>:8080/?pin=147065` (or open `http://<your-lan-ip>:8080/`
   and type the PIN into the prompt page). The pairing is stored as a 30-day
   cookie so you only do this once per device.
5. Make sure your firewall allows inbound connections to port 8080 on
   the local network.

> **Heads-up.** The PIN gate covers HTTP requests and WebSocket upgrades,
> but anyone on the same Wi-Fi who guesses the 6-digit PIN gets in. Don't
> run with `BIND_HOST=0.0.0.0` on untrusted networks (coffee shop Wi-Fi,
> conferences, etc.).

## Things to double-check before going live

- Open your scene's preview, drag the dashboard window across the screen,
  and confirm it never appears in the preview.
- If you use multiple monitors, verify which monitor each Display Capture
  source covers.
- Test once with the actual stream/recording (not just the preview) — some
  capture modes behave differently when active.

## Troubleshooting

- **Dashboard isn't reachable from the secondary device.**
  Ensure `BIND_HOST=0.0.0.0`, that both devices are on the same network,
  and that the host firewall isn't blocking port 8080.
- **Secondary device shows a "pair this device" page.**
  That's expected — type the 6-digit PIN from the backend log into the
  prompt (or visit the URL with `?pin=…`). The PIN persists for the lifetime
  of the backend process; restarting the server rotates it.
- **OBS still captures the dashboard.**
  You're almost certainly using Display Capture. Switch to Window Capture
  or move the dashboard to a different monitor / device.
