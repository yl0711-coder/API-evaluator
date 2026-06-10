// server/utils.mjs
// 通用纯函数工具：JSON 安全解析、文本脱敏与摘要、JSONL 追加写与尾部读取（带大小封顶）、
// 数值/百分比统计与格式化等，供各模块复用。
import { appendFile, open, readFile, stat, writeFile } from "node:fs/promises";

export const DEFAULT_JSONL_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_JSONL_TAIL_BYTES = 4 * 1024 * 1024;

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}(?:-[A-Za-z0-9_-]+)*\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/g,
  /\b(api[_-]?key|authorization|password|secret|token|x-api-key)\s*[:=]\s*["']?[^"',\s}]{8,}/gi,
];

export function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseLooseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const direct = safeJson(raw);
  if (direct) return direct;
  const match = raw.match(/\{[\s\S]*\}/);
  return match ? safeJson(match[0]) : null;
}

export function summarizeText(text) {
  return redactSensitiveText(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function redactSensitiveText(text) {
  return SECRET_VALUE_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, "[redacted-secret]"),
    String(text || ""),
  );
}

export async function appendJsonLine(file, value, { maxBytes = DEFAULT_JSONL_MAX_BYTES, tailBytes = DEFAULT_JSONL_TAIL_BYTES } = {}) {
  await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
  await trimJsonLinesFile(file, { maxBytes, tailBytes });
}

export async function readTextTail(file, maxBytes = DEFAULT_JSONL_TAIL_BYTES) {
  const info = await stat(file);
  if (info.size <= maxBytes) {
    return readFile(file, "utf8");
  }

  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    await handle.read(buffer, 0, maxBytes, info.size - maxBytes);
    const raw = buffer.toString("utf8");
    const firstLineBreak = raw.indexOf("\n");
    return firstLineBreak >= 0 ? raw.slice(firstLineBreak + 1) : raw;
  } finally {
    await handle.close();
  }
}

async function trimJsonLinesFile(file, { maxBytes, tailBytes }) {
  try {
    const info = await stat(file);
    if (info.size <= maxBytes) {
      return;
    }
    const tail = await readTextTail(file, tailBytes);
    await writeFile(file, tail, "utf8");
  } catch {
    // Log rotation is best-effort. Never fail a test because cleanup failed.
  }
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

export function compactDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

// 可种子化 PRNG（mulberry32）。确定性、同 seed 同序列，用于 bootstrap 重抽样
// 与裁判答案位置随机化的可复现。PRNG 必须逐位一致才能复现，故统一一处实现。
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(values) {
  const clean = values.filter(isFiniteNumber).map(Number);
  if (clean.length === 0) return null;
  return Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length);
}

export function percentile(values, ratio) {
  const clean = values.filter(isFiniteNumber).map(Number).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const index = Math.ceil(clean.length * ratio) - 1;
  return clean[Math.max(0, Math.min(clean.length - 1, index))];
}

export function sumNullable(values) {
  const clean = values.filter(isFiniteNumber).map(Number);
  if (clean.length === 0) return null;
  return clean.reduce((sum, value) => sum + value, 0);
}

export function groupBy(values, getKey) {
  const groups = {};
  for (const value of values) {
    const key = getKey(value);
    groups[key] = groups[key] || [];
    groups[key].push(value);
  }
  return groups;
}

export function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

export function requiredString(value, label) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`${label} 不能为空。`);
  }
  return text;
}

export function escapeHtmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function escapeMarkdownTable(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

export function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

export function hasProxyEnv() {
  return [
    "all_proxy",
    "ALL_PROXY",
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
  ].some((key) => Boolean(process.env[key]));
}
