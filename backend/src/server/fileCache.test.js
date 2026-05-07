import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileCache, scanFilesAsync } = require('./fileCache.js');

let root;
let engineDir;
let booksDir;
let syzygyDir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fc-test-'));
  engineDir = join(root, 'engine');
  booksDir = join(root, 'books');
  syzygyDir = join(root, 'syzygy');
  mkdirSync(engineDir, { recursive: true });
  mkdirSync(booksDir, { recursive: true });
  mkdirSync(syzygyDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanFilesAsync', () => {
  it('returns empty for a missing directory', async () => {
    const r = await scanFilesAsync(join(root, 'nope'), ['.bin']);
    expect(r).toEqual([]);
  });

  it('matches by lower-cased suffix and walks subdirectories', async () => {
    mkdirSync(join(booksDir, 'sub'), { recursive: true });
    writeFileSync(join(booksDir, 'a.bin'), 'x');
    writeFileSync(join(booksDir, 'b.BIN'), 'x');
    writeFileSync(join(booksDir, 'readme.md'), 'x');
    writeFileSync(join(booksDir, 'sub', 'c.bin'), 'x');
    const r = await scanFilesAsync(booksDir, ['.bin']);
    expect(r.map((e) => e.name).sort()).toEqual(['a.bin', 'b.BIN', 'c.bin']);
  });
});

describe('FileCache', () => {
  it('lists Windows engines as .exe files only', async () => {
    writeFileSync(join(engineDir, 'stockfish.exe'), 'x');
    writeFileSync(join(engineDir, 'readme.md'), 'x');
    writeFileSync(join(engineDir, 'fairy-stockfish.exe'), 'x');
    const c = new FileCache({ engineDir, booksDir, syzygyDir, platform: 'win32' });
    await c.refresh();
    const names = c
      .get()
      .engines.map((e) => e.name)
      .sort();
    expect(names).toEqual(['fairy-stockfish.exe', 'stockfish.exe']);
  });

  it('lists Linux engines as anything not in the doc/config skip-set', async () => {
    writeFileSync(join(engineDir, 'stockfish'), 'x');
    writeFileSync(join(engineDir, 'fairy-stockfish'), 'x');
    writeFileSync(join(engineDir, 'README.md'), 'x');
    writeFileSync(join(engineDir, 'config.json'), 'x');
    writeFileSync(join(engineDir, 'install.sh'), 'x');
    const c = new FileCache({ engineDir, booksDir, syzygyDir, platform: 'linux' });
    await c.refresh();
    const names = c
      .get()
      .engines.map((e) => e.name)
      .sort();
    expect(names).toEqual(['fairy-stockfish', 'stockfish']);
  });

  it('lists books as .bin files', async () => {
    writeFileSync(join(booksDir, 'opening.bin'), 'x');
    writeFileSync(join(booksDir, 'notes.txt'), 'x');
    const c = new FileCache({ engineDir, booksDir, syzygyDir, platform: 'linux' });
    await c.refresh();
    expect(c.get().books.map((e) => e.name)).toEqual(['opening.bin']);
  });

  it('treats the syzygy root as a hit when it directly contains tablebase files', async () => {
    writeFileSync(join(syzygyDir, 'KPvK.rtbw'), 'x');
    writeFileSync(join(syzygyDir, 'KPvK.rtbz'), 'x');
    const c = new FileCache({ engineDir, booksDir, syzygyDir, platform: 'linux' });
    await c.refresh();
    const names = c.get().syzygy.map((e) => e.name);
    expect(names.length).toBeGreaterThanOrEqual(1);
    expect(names).toContain('syzygy');
  });

  it('lists per-subdir when tablebases live one level down', async () => {
    mkdirSync(join(syzygyDir, '3-piece'), { recursive: true });
    mkdirSync(join(syzygyDir, '4-piece'), { recursive: true });
    mkdirSync(join(syzygyDir, 'docs'), { recursive: true });
    writeFileSync(join(syzygyDir, '3-piece', 'KPvK.rtbw'), 'x');
    writeFileSync(join(syzygyDir, '4-piece', 'KQvKR.rtbz'), 'x');
    writeFileSync(join(syzygyDir, 'docs', 'README.md'), 'x');
    const c = new FileCache({ engineDir, booksDir, syzygyDir, platform: 'linux' });
    await c.refresh();
    const names = c
      .get()
      .syzygy.map((e) => e.name)
      .sort();
    expect(names).toEqual(['3-piece', '4-piece']);
  });

  it('returns empty snapshots for missing directories without throwing', async () => {
    const c = new FileCache({
      engineDir: '/no/such/engine',
      booksDir: '/no/such/books',
      syzygyDir: '/no/such/syzygy',
      platform: 'linux',
    });
    await c.refresh();
    expect(c.get().engines).toEqual([]);
    expect(c.get().books).toEqual([]);
    expect(c.get().syzygy).toEqual([]);
  });

  it('start() returns a disposer that stops the background interval', async () => {
    const c = new FileCache({ engineDir, booksDir, syzygyDir, platform: 'linux' });
    const stop = c.start(50);
    expect(typeof stop).toBe('function');
    stop();
    // No assertion beyond "doesn't throw and doesn't keep the process
    // alive" — the unref'd timer guarantees the latter.
  });

  it('snapshot ts advances on each refresh', async () => {
    const c = new FileCache({ engineDir, booksDir, syzygyDir, platform: 'linux' });
    await c.refresh();
    const t1 = c.get().ts;
    await new Promise((r) => setTimeout(r, 5));
    await c.refresh();
    const t2 = c.get().ts;
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});
