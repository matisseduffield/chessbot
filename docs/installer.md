# Windows installer (Inno Setup)

Packaging for the backend + extension is done via [Inno Setup](https://jrsoftware.org/isinfo.php).

## Local build

```
choco install innosetup -y
npm ci
npm run build --workspace shared
npm run build --workspace extension
iscc installer\chessbot.iss
```

The resulting `chessbot-setup-<version>.exe` is written to `dist-installer\`.

## CI build

Pushing a `v*` tag triggers `.github/workflows/installer.yml`, which builds the
installer on a `windows-latest` runner and attaches the artifact to the GitHub
release.

## What users see when they run the installer

The installer ships **unsigned**. Windows SmartScreen will warn the
first time someone runs `chessbot-setup-<version>.exe`:

> _Windows protected your PC._
> _Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app might put your PC at risk._

This is expected — the warning means "we don't recognise the publisher,"
not "this file is malicious." To proceed:

1. Click **More info** in the dialog.
2. Click **Run anyway**.

After the first install Windows usually stops warning on the same
machine. If you want users to see no warning at all, see "Adding code
signing" below.

## Adding code signing (optional)

Signing is **not planned** for this project — a code-signing
certificate costs ~$50–400/year, which doesn't fit a free OSS tool.
The CI workflow keeps the signing step in place, commented out, so a
future maintainer can switch it on without re-deriving the steps:

1. Obtain an Authenticode certificate (`.pfx`).
2. Add two repository secrets:
   - `CERT_PFX_BASE64` — the `.pfx` file, base64-encoded
   - `CERT_PFX_PASSWORD` — the password
3. Uncomment the `Sign installer` step in `.github/workflows/installer.yml`.
4. Uncomment `SignTool=signtool` and `SignedUninstaller=yes` in
   `installer\chessbot.iss`.
