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

## Code signing

The installer currently ships **unsigned**. To enable signing:

1. Obtain an Authenticode certificate (`.pfx`).
2. Add two repository secrets:
   - `CERT_PFX_BASE64` — the `.pfx` file, base64-encoded
   - `CERT_PFX_PASSWORD` — the password
3. Uncomment the `Sign installer` step in `.github/workflows/installer.yml`.
4. Uncomment `SignTool=signtool` and `SignedUninstaller=yes` in
   `installer\chessbot.iss`.
