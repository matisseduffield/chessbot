#!/usr/bin/env node
// Diagnose common setup issues. Run with: npm run doctor
//
// Checks:
//  • Node.js version meets the engines.node range in package.json.
//  • @chessbot/shared has been built (dist/index.js exists).
//  • A Stockfish binary can be found and is executable.
//  • Default port (8080) is free.
//
// Exits 0 if everything looks good, 1 if any check fails.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
if (existsSync(engineDir)) {
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
    if (res.error) bad(`failed to run binary: ${res.error.message}`);
    else if (!String(res.stdout).includes('uciok')) bad(`binary did not respond with "uciok"`);
    else ok(`binary speaks UCI`);
  } catch (e) {
    bad(`could not execute binary: ${e.message}`);
  }

  try {
    statSync(stockfishPath);
  } catch {
    /* already reported */
  }
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
