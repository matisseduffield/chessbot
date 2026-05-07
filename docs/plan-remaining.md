# Improvement plan — remaining work

The four-phase plan in `/root/.claude/plans/create-a-plan-to-sequential-stardust.md` is largely shipped. This file lists what's left, why each item couldn't be finished from the assistant's terminal session, and where to pick it up.

## Phase 4 — needs maintainer access

### Code-sign the Windows installer

**Blocked on:** purchasing an Authenticode certificate and adding two GitHub repository secrets. Neither can be done from the assistant's environment.

**Where to go:**

1. Buy a code-signing cert (~$50–300/year — DigiCert, Sectigo, SSL.com all sell EV and standard certs).
2. Repository → Settings → Secrets and variables → Actions → New repository secret:
   - `CERT_PFX_BASE64` — the `.pfx`, base64-encoded (`certutil -encode cert.pfx cert.b64` on Windows; `base64 -w0 cert.pfx` on Linux).
   - `CERT_PFX_PASSWORD` — the PFX password.
3. Edit `.github/workflows/installer.yml`:
   - Uncomment the `Sign installer` step (lines 38–47).
4. Edit `installer/chessbot.iss`: uncomment `SignTool=signtool` and `SignedUninstaller=yes`.
5. Push a `v*` tag to trigger `installer.yml`. Download the artifact and confirm SmartScreen no longer warns. Step-by-step is in `docs/installer.md` § "Code signing".

### Cut the first tagged release

**Blocked on:** push to `main` + tag-push permission. CHANGELOG.md is ready — its `[Unreleased]` section captures everything Phases 1–3 added.

**Where to go:**

1. Decide a version (`v0.1.0` makes sense for the first public tagged build).
2. Replace `## [Unreleased]` with `## [0.1.0] — YYYY-MM-DD` and start a new empty `[Unreleased]` block above it.
3. Bump `package.json` versions (root + `backend`, `extension`, `shared`, `backend/panel`) to `0.1.0`.
4. Commit, tag (`git tag -a v0.1.0 -m "v0.1.0"`), push (`git push --follow-tags`).
5. The `installer.yml` workflow takes the tag-push as the trigger and attaches the (now-signed) installer to the GitHub release.

### Refresh README screenshots

**Blocked on:** running Chrome with the extension loaded against a live chess.com / lichess game.

**Where to go:** load the unpacked `extension/dist` in Chrome → open a chess.com daily puzzle, a lichess study, a playstrategy game → screenshot the overlay (arrows + box + eval bar) and the dashboard cards → save under `screenshots/` and update `README.md` references.

## Phase 3 — needs in-browser tuning

### Eval-bar / multi-PV visual polish

The hotkeys (`d`, `m`, `f`) and the underlying overlay rebuild are shipped. Animation curves, transition timing, and multi-PV stacking density need to be tweaked while watching a real engine stream — that requires Chrome with Stockfish running, which the assistant can't drive headlessly. Pick this up locally with `npm run dev` and a chess.com game; the relevant block in `extension/src/content/content.js` is the SVG overlay rebuild (search for `requestAnimationFrame` coalescer).

## Plan items that have natural follow-ups (could land in another assistant session)

These are unblocked but didn't fit the current scope. Each is a one-PR follow-up.

| Item                                                               | What's there now                                                                   | What's missing                                                                                                                                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Auto-show flip prompt on `'unknown'`**                           | `extension/src/content/flipPrompt.js` (PR #27) and `flipOverride` storage (PR #28) | `content.js` doesn't yet call `resolveFlip()` automatically when `detectFlipConfidence()` returns `'unknown'`. Currently the popup is the only entry point for setting the override. |
| **Lift chess.com variant detection into `chesscomBoardReader.js`** | Variant detection lives inline in `content.js`                                     | `lichessBoardReader.js` already exposes a clean reader interface; chess.com hasn't been factored the same way.                                                                       |
| **Add Dependabot config**                                          | None                                                                               | Add `.github/dependabot.yml` with weekly npm + github-actions update PRs. Mentioned in plan §2 but not yet shipped.                                                                  |

## What's done

For reference, these landed earlier in the cycle and are no longer pending:

- Phase 1: WS heartbeat, async file IO, eval-cache depth fallback, variant-switch race fix, SVG-overlay rAF coalescer, lichess book error taxonomy, all six "quick wins".
- Phase 2: `server.js` modularization (1421 → ~990 lines), `stockfishBridge.test.js`, `server.integration.test.js`, lichess + playstrategy contract tests, extension `// @ts-check` scaffold, backend `tsconfig` widened to `src/**/*.js`, CI matrix on Win+Linux × Node 20+22, e2e step.
- Phase 3: Site-adapter registry (`siteAdapters.js`), tri-state `detectFlipConfidence`, `flipPrompt.js`, dashboard `withCard` error boundaries, Zod-validated popup settings, annotated PGN export, popup flipOverride persistence + content-script wiring.
- Phase 4: CHANGELOG bootstrapped, doctor extended (Stockfish version, port 8080, manifest-vs-package version drift), protocol-mismatch banner.
