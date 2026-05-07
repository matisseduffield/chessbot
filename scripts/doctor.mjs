#!/usr/bin/env node
// Diagnose common setup issues. Run with: npm run doctor
//
// Checks:
//  • Node.js version meets the engines.node range in package.json.
//  • @chessbot/shared has been built (dist/index.js exists).
//  • A Stockfish binary can be found, is executable, and reports an
//    `id name` string (so we know which engine + version is running).
//  • Extension manifest.json version matches backend package.json
//    version — if they drift the popup may carry stale features that
//    don't line up with the running backend.
//  • Default port (8080) is free.
//
// Flags:
//  • --skip-engine   skip the Stockfish binary check (used by CI, which
//                    doesn't ship the engine).
//
// Exits 0 if everything looks good, 1 if any check fails.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipEngine = process.argv.includes('--skip-engine');

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => {
  console.log(`  ✗ ${msg}`);
  failed++;
};
const warn = (msg) => console.log(`  ! ${msg}`);

console.log('chessbot doctor\n');

// ── Node version ────────────────────────────────────────────────
console.log('Node.js');
try {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const need = pkg.engines?.node;
  const have = process.versions.node;
  if (!need) {
    warn(`engines.node not declared (running ${have})`);
  } else {
    const min = Number(need.replace(/[^\d.]/g, '').split('.')[0]);
    const cur = Number(have.split('.')[0]);
    if (Number.isFinite(min) && cur < min) bad(`Node ${have} is below required ${need}`);
    else ok(`Node ${have} satisfies ${need}`);
  }
} catch (e) {
  bad(`could not read package.json: ${e.message}`);
}

// ── @chessbot/shared build ──────────────────────────────────────
console.log('\nshared module');
const sharedDist = path.join(root, 'shared', 'dist', 'index.js');
if (existsSync(sharedDist)) ok(`built (${path.relative(root, sharedDist)})`);
else bad(`shared/dist/index.js missing — run \`npm run build:shared\``);

// ── Stockfish binary ────────────────────────────────────────────
console.log('\nStockfish');
const engineDir = path.join(root, 'engine', 'stockfish');
let stockfishPath = null;
if (skipEngine) {
  warn('skipped (--skip-engine)');
} else if (existsSync(engineDir)) {
  const isWin = process.platform === 'win32';
  const matches = readdirSync(engineDir).filter((f) => {
    const lower = f.toLowerCase();
    if (!lower.startsWith('stockfish')) return false;
    return isWin ? lower.endsWith('.exe') : !lower.endsWith('.exe');
  });
  if (matches.length === 0) {
    bad(`no Stockfish binary in ${path.relative(root, engineDir)}/ — see README step 2`);
  } else {
    stockfishPath = path.join(engineDir, matches[0]);
    ok(`found ${matches[0]}`);
  }
} else {
  bad(`engine/stockfish/ does not exist — see README step 2`);
}

if (stockfishPath) {
  try {
    const res = spawnSync(stockfishPath, [], {
      input: 'uci\nquit\n',
      timeout: 5_000,
      encoding: 'utf8',
    });
    const stdout = String(res.stdout || '');
    if (res.error) bad(`failed to run binary: ${res.error.message}`);
    else if (!stdout.includes('uciok')) bad(`binary did not respond with "uciok"`);
    else {
      ok(`binary speaks UCI`);
      // The `id name X` line is the engine's self-identification
      // (e.g. "Stockfish 17", "Fairy-Stockfish 14.0.0"). Surface it
      // so support tickets always include a version, and warn if
      // it's missing — that usually means the binary is corrupt or
      // a non-UCI executable that just happens to have the right name.
      const nameMatch = stdout.match(/^id\s+name\s+(.+)$/m);
      if (nameMatch) ok(`engine: ${nameMatch[1].trim()}`);
      else warn(`binary did not report an "id name" line — version unknown`);
    }
  } catch (e) {
    bad(`could not execute binary: ${e.message}`);
  }

  try {
    statSync(stockfishPath);
  } catch {
    /* already reported */
  }
}

// ── Extension / backend version match ─────────────────────────
// The extension popup's manifest.json carries a user-visible version
// number. If it falls behind the backend's package.json version,
// users may load an extension that's missing fields the backend now
// expects. Warn (not error) so a release in flight that intentionally
// bumps just one side doesn't fail doctor.
console.log('\nVersions');
try {
  const manifestPath = path.join(root, 'extension', 'public', 'manifest.json');
  const backendPkgPath = path.join(root, 'backend', 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const backendPkg = JSON.parse(readFileSync(backendPkgPath, 'utf8'));
  const extVer = manifest.version || '?';
  const bkVer = backendPkg.version || '?';
  if (extVer === bkVer) {
    ok(`extension v${extVer} matches backend v${bkVer}`);
  } else {
    warn(`extension v${extVer} ≠ backend v${bkVer} — bump one to match before tagging a release`);
  }
} catch (e) {
  warn(`could not compare extension / backend versions: ${e.message}`);
}

// ── Port 8080 ───────────────────────────────────────────────────
console.log('\nNetwork');
await new Promise((resolve) => {
  const srv = createServer();
  srv.once('error', (err) => {
    if (err.code === 'EADDRINUSE') bad(`port 8080 is already in use (another backend? set PORT=…)`);
    else warn(`port check failed: ${err.message}`);
    resolve();
  });
  srv.listen(8080, '127.0.0.1', () =>
    srv.close(() => {
      ok('port 8080 free');
      resolve();
    }),
  );
});

console.log();
if (failed === 0) {
  console.log('All checks passed. You should be able to run `npm start`.');
  process.exit(0);
} else {
  console.log(`${failed} check(s) failed. Fix the issues above and re-run \`npm run doctor\`.`);
  process.exit(1);
}
