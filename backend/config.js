const path = require("path");
const fs = require("fs");
const { z } = require("zod");

// Validate env vars up front (improvement-plan §7.2). Invalid values
// fail fast with a human-readable message rather than silently falling
// through to runtime errors.
const EnvSchema = z.object({
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || (Number.isInteger(v) && v > 0 && v < 65536), {
      message: "PORT must be an integer in 1-65535",
    }),
  ENGINE_DIR: z.string().optional(),
  BOOKS_DIR: z.string().optional(),
  SYZYGY_DIR: z.string().optional(),
  STOCKFISH_PATH: z.string().optional(),
  FAIRY_STOCKFISH_PATH: z.string().optional(),
  OPENING_BOOK_PATH: z.string().optional(),
  SYZYGY_PATH: z.string().optional(),
  BIND_HOST: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
});
const envResult = EnvSchema.safeParse(process.env);
if (!envResult.success) {
   
  console.error("[config] invalid environment:", envResult.error.flatten().fieldErrors);
  process.exit(1);
}
const env = envResult.data;

// Auto-detect the first .bin book in books/
function findFirstBook(dir) {
  try {
    const files = fs.readdirSync(dir);
    const bin = files.find((f) => f.toLowerCase().endsWith(".bin"));
    return bin ? path.join(dir, bin) : null;
  } catch { return null; }
}

/**
 * Auto-detect an engine binary in the given directory.
 *
 * Looks for files whose name starts with the brand prefix (e.g. "stockfish",
 * "fairy-stockfish") and matches the host platform's executable convention.
 * On Windows we require .exe; elsewhere we accept extension-less binaries.
 * Returns the first match (full path) or null if none found.
 */
function findEngineBinary(dir, brandPrefix) {
  if (!fs.existsSync(dir)) return null;
  const want = brandPrefix.toLowerCase();
  const isWin = process.platform === "win32";
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }

  // Walk one level deep too so we can find ./engine/stockfish/<file>.
  const candidates = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isFile()) {
      candidates.push(abs);
    } else if (entry.isDirectory()) {
      try {
        for (const sub of fs.readdirSync(abs, { withFileTypes: true })) {
          if (sub.isFile()) candidates.push(path.join(abs, sub.name));
        }
      } catch { /* ignore unreadable sub-dir */ }
    }
  }

  const matches = candidates.filter((p) => {
    const base = path.basename(p).toLowerCase();
    if (!base.startsWith(want)) return false;
    if (isWin) return base.endsWith(".exe");
    // On *nix, accept either no extension or an explicit one; reject .exe
    return !base.endsWith(".exe");
  });

  if (matches.length === 0) return null;

  // Prefer binaries with CPU-feature suffixes our host likely supports.
  // This is best-effort — we just rank candidates; the user can still
  // override via STOCKFISH_PATH / FAIRY_STOCKFISH_PATH.
  const score = (p) => {
    const b = path.basename(p).toLowerCase();
    let s = 0;
    if (b.includes("avx2")) s += 3;
    if (b.includes("bmi2")) s += 3;
    if (b.includes("modern")) s += 2;
    if (b.includes("popcnt")) s += 1;
    return s;
  };
  matches.sort((a, b) => score(b) - score(a));
  return matches[0];
}

const engineDir = env.ENGINE_DIR || path.join(__dirname, "..", "engine");
const booksDir = env.BOOKS_DIR || path.join(__dirname, "..", "books");

// Sensible Windows defaults (preserved for backwards compat); on other
// platforms we rely on findEngineBinary's probe.
const winStockfishDefault = path.join(engineDir, "stockfish", "stockfish-windows-x86-64-avx2.exe");
const winFairyDefault = path.join(engineDir, "fairy-stockfish", "fairy-stockfish_x86-64-bmi2.exe");

function resolveStockfish() {
  if (env.STOCKFISH_PATH) return env.STOCKFISH_PATH;
  const probed = findEngineBinary(path.join(engineDir, "stockfish"), "stockfish")
    || findEngineBinary(engineDir, "stockfish");
  if (probed) return probed;
  // Last resort: fall back to the Windows default path so the existing
  // "binary not found" error message still points users somewhere obvious.
  return winStockfishDefault;
}

function resolveFairyStockfish() {
  if (env.FAIRY_STOCKFISH_PATH) return env.FAIRY_STOCKFISH_PATH;
  const probed = findEngineBinary(path.join(engineDir, "fairy-stockfish"), "fairy-stockfish")
    || findEngineBinary(engineDir, "fairy-stockfish");
  if (probed) return probed;
  return winFairyDefault;
}

module.exports = {
  // ── Directories (for scanning available files) ────────
  engineDir,

  booksDir,

  syzygyDir:
    env.SYZYGY_DIR ||
    path.join(__dirname, "..", "syzygy"),

  // ── Engine ────────────────────────────────────────────
  // Auto-detected from engineDir on non-Windows platforms; users can
  // always override with STOCKFISH_PATH / FAIRY_STOCKFISH_PATH.
  stockfishPath: resolveStockfish(),
  fairyStockfishPath: resolveFairyStockfish(),

  // ── Network ───────────────────────────────────────────
  // Default to loopback for safety. Set BIND_HOST=0.0.0.0 to expose
  // the dashboard to other devices on the LAN (see docs/streaming.md).
  bindHost: env.BIND_HOST || "127.0.0.1",

  // ── Opening Book (Polyglot .bin) ──────────────────────
  // Auto-detects the first .bin in books/ if OPENING_BOOK_PATH is not set.
  openingBookPath:
    env.OPENING_BOOK_PATH || findFirstBook(booksDir),

  // ── Syzygy Endgame Tablebases ─────────────────────────
  // Set to "" to disable. Separate multiple folders with ";".
  syzygyPath:
    env.SYZYGY_PATH ||
    path.join(__dirname, "..", "syzygy"),

  // ── Server ────────────────────────────────────────────
  port: env.PORT || 8080,

  // ── Logging ───────────────────────────────────────────
  logLevel: env.LOG_LEVEL || "info",

  // ── Analysis defaults ─────────────────────────────────
  defaultDepth: 15,
  searchMovetime: null,  // ms — set from panel
  searchNodes: null,     // node count — set from panel
};
