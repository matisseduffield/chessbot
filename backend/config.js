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

const booksDir = env.BOOKS_DIR || path.join(__dirname, "..", "books");

module.exports = {
  // ── Directories (for scanning available files) ────────
  engineDir:
    env.ENGINE_DIR ||
    path.join(__dirname, "..", "engine"),

  booksDir,

  syzygyDir:
    env.SYZYGY_DIR ||
    path.join(__dirname, "..", "syzygy"),

  // ── Engine ────────────────────────────────────────────
  stockfishPath:
    env.STOCKFISH_PATH ||
    path.join(__dirname, "..", "engine", "stockfish", "stockfish-windows-x86-64-avx2.exe"),

  fairyStockfishPath:
    env.FAIRY_STOCKFISH_PATH ||
    path.join(__dirname, "..", "engine", "fairy-stockfish", "fairy-stockfish_x86-64-bmi2.exe"),

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

  // ── Analysis defaults ─────────────────────────────────
  defaultDepth: 15,
  searchMovetime: null,  // ms — set from panel
  searchNodes: null,     // node count — set from panel
};
