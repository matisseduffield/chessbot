#!/usr/bin/env node
// Helper that points users at the right Stockfish download for their host
// and verifies a binary they have already extracted into engine/stockfish/.
//
// We deliberately do NOT auto-download by default: Stockfish releases are
// large, hosted on GitHub, and licensed (GPL-3.0) — users should make an
// informed choice. Running this script with `--print-url` just prints the
// recommended URL; running it with no args verifies the binary works.

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'engine', 'stockfish');
mkdirSync(engineDir, { recursive: true });

const platform = process.platform;
const arch = process.arch;
const isWin = platform === 'win32';

// Recommended assets from the official Stockfish release page. Update as new
// versions ship — this is best-effort guidance, not a strict pin.
const RELEASE_PAGE = 'https://stockfishchess.org/download/';

function recommend() {
  if (isWin && arch === 'x64') {
    return {
      filename: 'stockfish-windows-x86-64-avx2.exe',
      url: 'https://stockfishchess.org/download/windows/  (pick the AVX2 build)',
    };
  }
  if (platform === 'darwin') {
    return {
      filename:
        arch === 'arm64' ? 'stockfish-macos-m1-apple-silicon' : 'stockfish-macos-x86-64-modern',
      url: 'https://stockfishchess.org/download/mac/',
    };
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      filename: 'stockfish-ubuntu-x86-64-avx2',
      url: 'https://stockfishchess.org/download/linux/',
    };
  }
  return { filename: '(see release page)', url: RELEASE_PAGE };
}

const rec = recommend();

if (process.argv.includes('--print-url')) {
  console.log(rec.url);
  process.exit(0);
}

console.log(`Detected: ${platform}/${arch}`);
console.log(`Recommended binary: ${rec.filename}`);
console.log(`Download from: ${rec.url}\n`);

// Look for any stockfish-* binary already in engine/stockfish/
let entries = [];
try {
  entries = readdirSync(engineDir);
} catch {
  /* dir was just created */
}

const wantsExe = isWin;
const found = entries.find((f) => {
  const lower = f.toLowerCase();
  if (!lower.startsWith('stockfish')) return false;
  return wantsExe ? lower.endsWith('.exe') : !lower.endsWith('.exe');
});

if (!found) {
  console.log(`No Stockfish binary found in ${path.relative(root, engineDir)}/.`);
  console.log('Steps:');
  console.log(`  1. Download Stockfish from the URL above.`);
  console.log(`  2. Extract / move the binary into ${path.relative(root, engineDir)}${path.sep}`);
  if (!isWin)
    console.log(`  3. Make it executable:  chmod +x ${path.relative(root, engineDir)}/stockfish*`);
  console.log(`  ${isWin ? 3 : 4}. Re-run \`npm run setup:engine\` to verify.`);
  process.exit(1);
}

const bin = path.join(engineDir, found);
console.log(`Verifying ${found} ...`);

if (!existsSync(bin)) {
  console.error(`Binary missing: ${bin}`);
  process.exit(1);
}

const res = spawnSync(bin, [], { input: 'uci\nquit\n', timeout: 5_000, encoding: 'utf8' });
if (res.error) {
  console.error(`Could not execute binary: ${res.error.message}`);
  if (!isWin) console.error('Hint: chmod +x the file and ensure your shell can execute it.');
  process.exit(1);
}
if (!String(res.stdout).includes('uciok')) {
  console.error('Binary did not respond with `uciok`. Output was:\n');
  console.error(res.stdout || '(empty)');
  process.exit(1);
}

console.log('✓ Stockfish is installed and speaks UCI. You can now run `npm start`.');
