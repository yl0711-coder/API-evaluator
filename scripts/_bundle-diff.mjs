// Extract string literals + identifiers from unminified vite bundle for equivalence comparison.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const assets = readdirSync("dist/assets");
const jsFile = assets.find((f) => f.endsWith(".js") && f.startsWith("index-"));
if (!jsFile) {
  console.error("No JS bundle found");
  process.exit(1);
}
const code = readFileSync(`dist/assets/${jsFile}`, "utf8");

// String literals (double + single quoted)
const dq = [...code.matchAll(/"(?:\\.|[^"\\])*"/g)].map((m) => m[0]).sort();
const sq = [...code.matchAll(/'(?:\\.|[^'\\])*'/g)].map((m) => m[0]).sort();
writeFileSync(`dist/_baseline-strings.txt`, [...dq, ...sq].join("\n"));

// Identifiers (>= 3 chars)
const idents = [...new Set([...code.matchAll(/[a-zA-Z_$][a-zA-Z0-9_$]{2,}/g)].map((m) => m[0]))].sort();
writeFileSync(`dist/_baseline-idents.txt`, idents.join("\n"));

console.log(`Bundle: ${code.length} bytes`);
console.log(`Strings: ${dq.length + sq.length}`);
console.log(`Unique idents (>=3 chars): ${idents.length}`);
