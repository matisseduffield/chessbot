const fs = require("fs");
const path = require("path");

const openings = new Map();

function loadEco(dir) {
  if (!fs.existsSync(dir)) {
    console.log("[eco] directory not found:", dir);
    return;
  }
  let count = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".tsv")) continue;
    const full = path.join(dir, file);
    const lines = fs.readFileSync(full, "utf-8").split("\n");
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split("\t");
      if (parts.length >= 3) {
        // parts[0]=eco code, parts[1]=name, parts[2]=fen/epd
        openings.set(parts[2].trim(), { code: parts[0].trim(), name: parts[1].trim() });
        count++;
      }
    }
  }
  console.log(`[eco] loaded ${count} openings`);
}

/** Look up an EPD string (FEN without move counters) and return { code, name } or null. */
function lookup(epd) {
  return openings.get(epd) || null;
}

module.exports = { loadEco, lookup };
