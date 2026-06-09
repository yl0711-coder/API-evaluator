import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const LOG_EXTENSIONS = new Set([".log", ".txt", ".json", ".jsonl"]);
const DEFAULT_MAX_FILES = 30;
const HARD_MAX_FILES = 80;
const DEFAULT_MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 12 * 1024 * 1024;

export async function readClientLogDirectory(directoryPath, options = {}) {
  const root = resolve(String(directoryPath || "").trim());
  if (!String(directoryPath || "").trim()) {
    throw new Error("请填写本机日志目录路径。");
  }

  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error("填写的路径不是目录。");
  }

  const maxFiles = clampInteger(options.maxFiles, DEFAULT_MAX_FILES, 1, HARD_MAX_FILES);
  const maxBytesPerFile = clampInteger(
    options.maxBytesPerFile,
    DEFAULT_MAX_BYTES_PER_FILE,
    1024,
    DEFAULT_MAX_BYTES_PER_FILE,
  );
  const recursive = Boolean(options.recursive);
  const candidates = await collectLogFiles(root, { recursive, maxFiles: HARD_MAX_FILES });
  const selected = candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);

  const parts = [];
  const files = [];
  let totalBytes = 0;

  for (const item of selected) {
    if (totalBytes >= HARD_MAX_TOTAL_BYTES) break;
    const remaining = HARD_MAX_TOTAL_BYTES - totalBytes;
    const readLimit = Math.min(maxBytesPerFile, remaining);
    const content = await readFile(item.path, "utf8");
    const sliced = content.slice(0, readLimit);
    const truncated = content.length > sliced.length;
    totalBytes += Buffer.byteLength(sliced, "utf8");
    files.push({
      name: item.name,
      path: item.path,
      size: item.size,
      readBytes: Buffer.byteLength(sliced, "utf8"),
      truncated,
      modifiedAt: new Date(item.mtimeMs).toISOString(),
    });
    parts.push(`# file: ${item.name}\n${sliced}`);
  }

  return {
    directoryPath: root,
    sourceName: basename(root) || "客户端日志目录",
    fileCount: files.length,
    totalBytes,
    maxFiles,
    maxBytesPerFile,
    truncated: selected.length < candidates.length || files.some((item) => item.truncated),
    files,
    logText: parts.join("\n\n"),
  };
}

async function collectLogFiles(root, options, depth = 0) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (options.recursive && depth < 2) {
        files.push(...await collectLogFiles(fullPath, options, depth + 1));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (!LOG_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const info = await stat(fullPath);
    files.push({
      name: depth > 0 ? fullPath.slice(root.length + 1) : entry.name,
      path: fullPath,
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
    if (files.length >= options.maxFiles) break;
  }
  return files;
}

function clampInteger(value, fallback, min, max) {
  const number = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
