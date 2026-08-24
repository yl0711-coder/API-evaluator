// server/utils.mjs
// 通用纯函数工具：JSON 安全解析、文本脱敏与摘要、JSONL 追加写与尾部读取（带大小封顶）、
// 数值/百分比统计与格式化等，供各模块复用。
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { HttpRequestError } from "./http-request.mjs";

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
  return redactSensitiveText(text).replace(/\s+/g, " ").trim().slice(0, 500);
}

export function redactSensitiveText(text) {
  return SECRET_VALUE_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[redacted-secret]"), String(text || ""));
}

// 原子写：建目录 → 写【唯一】同目录临时文件 → rename 到位。rename 在同一文件系统上是原子的，
// 【进程】写一半崩溃时目标文件要么是旧内容完好、要么是新内容完好，绝不留下半截文件——
// 否则加载器 try/catch 会把损坏文件静默回落成空/默认（密钥库损坏更会令全部渠道 Key 变不可读）。
// 注：这里不 fsync 临时文件 / 目录，故只保证抗【进程崩溃】，不保证抗【主机断电】——掉电可能丢失
// 尚在页缓存里的数据或 rename。本平台的容错前提是重启/重部署（进程级），断电级持久化不在保证范围内。
// 临时名带 pid + 递增序号：并发写同一文件时各用各的临时文件、互不覆盖；失败时清掉残留临时文件。
let atomicWriteSeq = 0;
export async function writeFileAtomic(file, data, options = "utf8") {
  await mkdir(dirname(file), { recursive: true });
  atomicWriteSeq = (atomicWriteSeq + 1) % 0xffffff;
  const tmp = `${file}.${process.pid}.${atomicWriteSeq}.tmp`;
  try {
    await writeFile(tmp, data, options);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
export function writeJsonAtomic(file, value) {
  return writeFileAtomic(file, JSON.stringify(value, null, 2), "utf8");
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
  const clean = values
    .filter(isFiniteNumber)
    .map(Number)
    .sort((a, b) => a - b);
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

/**
 * 实体 id 白名单校验：只允许 `[A-Za-z0-9_-]`，非法一律**丢弃并重新生成** UUID。
 * 渠道 / 模型目标 / profile 三处的 id 都走它（channel-model.mjs、profile-store.mjs）。
 *
 * 【为什么必须在数据层挡】前端有多处**刻意不转义**地把 id 拼进 HTML 属性，并在注释里
 * 声明「渠道 id 按约定是后端生成的安全值」——例如 `data-edit-channel="${channel.id}"`
 * （src/channel-admin.js）、`data-edit-profile="${profile.id}"`（src/profile-view.js）。
 * 两条导入链路都严格守约（safeTokenIdPart / safeKeyIdPart 把上游 id 收窄成 [a-z0-9-]），
 * 但 `POST /api/channels` 是另一条路：readJson 的原始请求体直接进 normalizeChannel，
 * 而原实现是 `String(body.id || existing?.id || randomUUID())` —— **原样收下**。
 * 实测提交 id = `7" onmouseover="alert(1)" x="` 会渲染出
 * `<button data-edit-channel="7" onmouseover="alert(1)" x="">`，属性被打破（存储型 XSS）。
 *
 * 目前这些端点仅超管可写（api-access.requiresAdmin 对 /api/channels、/api/profiles 的非 GET
 * 判 role 100），超管本就持有全部渠道 key，故不构成越权；但这是**纵深防御缺的一层**：
 * requiresAdmin 里已有 /api/settings 做字段级放宽给 role 10 的先例，一旦渠道写权限也放宽，
 * 它立刻变成真实可利用的存储型 XSS。故在数据层收口，不依赖「调用方都会守约」。
 *
 * 【为什么是重新生成而非抛错】id 非法只可能来自伪造请求（UI 永远回传后端给的 id），
 * 抛 400 与静默换 id 对正常用户都不可见；换 id 不给探测者可区分的错误信号。
 * 注意**不做字符剔除**（如 replace 掉引号）：那会把两个不同的非法 id 折叠成同一个，
 * 可能撞上已有实体。全量实测：线上 75 个渠道 + 268 个模型目标 id 全部符合该白名单，
 * 收紧不影响既有数据。
 */
const ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export function safeEntityId(...candidates) {
  for (const candidate of candidates) {
    const s = String(candidate ?? "").trim();
    if (s && ENTITY_ID_PATTERN.test(s)) return s;
  }
  return randomUUID();
}

/**
 * 上游数值 id（new-api 渠道/令牌 id、sub2api 密钥 id）→ 有限数或 null。
 * 前端把 sub2apiKeyId **不转义**拼进文本（src/channel-admin.js 注释：「它是数字故可直接拼接」）。
 * 导入链路确实做了 `Number.isFinite(Number(keyId)) ? Number(keyId) : null`，但 normalizeChannel
 * 原先是 `body.sub2apiKeyId ?? existing ?? null` —— 无数值强制，实测可塞
 * `1 <img src=x onerror=...>` 进去并渲染成真 HTML。此处统一收口。
 */
export function safeUpstreamNumericId(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function requiredString(value, label) {
  const text = String(value || "").trim();
  if (!text) {
    // 校验失败属客户端错误：抛 HttpRequestError 让顶层兜成 400 + userMessage，
    // 而不是被当成普通异常兜成 500（吞掉“XX 不能为空”的可读提示）。
    throw new HttpRequestError(400, "validation_error", `${label} 不能为空。`);
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
  return ["all_proxy", "ALL_PROXY", "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"].some((key) => Boolean(process.env[key]));
}
