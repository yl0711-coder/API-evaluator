import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoots = [
  "server.mjs",
  "vite.config.js",
  "playwright.config.mjs",
  "index.html",
  "package.json",
  "server",
  "src",
  "shared",
  "scripts",
  "tests",
  "e2e",
  "deploy",
  ".github",
];
const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".service", ".sh", ".timer", ".yml", ".yaml"]);

async function collectTextFiles(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTextFiles(entryPath)));
    else if (entry.isFile() && textExtensions.has(extname(entry.name).toLowerCase())) files.push(entryPath);
  }
  return files;
}

const files = [];
for (const sourcePath of sourceRoots) {
  const path = join(root, sourcePath);
  const extension = extname(sourcePath).toLowerCase();
  if (textExtensions.has(extension)) files.push(path);
  else files.push(...(await collectTextFiles(path)));
}

const violations = [];
for (const path of files) {
  const bytes = await readFile(path);
  for (let offset = bytes.indexOf(0); offset !== -1; offset = bytes.indexOf(0, offset + 1)) {
    violations.push(`${relative(root, path).replaceAll("\\", "/")}:${offset + 1}`);
  }
}

if (violations.length) {
  console.error(`Raw NUL bytes are not allowed in text source files:\n${violations.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${files.length} text source files: no raw NUL bytes found.`);
}
