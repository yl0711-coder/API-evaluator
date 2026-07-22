// server/notify-config.mjs
// 邮件报警的发信配置（SMTP 服务器/端口/账号/发件人/收件人）：真源是 配置/notify-config.json + 内存缓存。
// 密码不在此——它走加密库（secret-store），绝不入 notify-config.json；smtpPasswordSet 只是展示用的布尔标记。
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { NOTIFY_CONFIG_FILE } from "./paths.mjs";
import { writeJsonAtomic } from "./utils.mjs";

const DEFAULTS = {
  smtpHost: "",
  smtpPort: 465,
  smtpSsl: true,
  smtpUser: "",
  smtpFrom: "",
  recipients: "",
  smtpPasswordSet: false,
};

let cache = null;

// 只接受已知字段、做类型校验，杜绝脏数据/多余字段进缓存。
function normalize(raw) {
  const port = Number(raw?.smtpPort);
  return {
    smtpHost: typeof raw?.smtpHost === "string" ? raw.smtpHost.trim() : "",
    smtpPort: Number.isFinite(port) && port > 0 && port < 65536 ? Math.trunc(port) : DEFAULTS.smtpPort,
    smtpSsl: raw?.smtpSsl !== false,
    smtpUser: typeof raw?.smtpUser === "string" ? raw.smtpUser.trim() : "",
    smtpFrom: typeof raw?.smtpFrom === "string" ? raw.smtpFrom.trim() : "",
    recipients: typeof raw?.recipients === "string" ? raw.recipients : "",
    smtpPasswordSet: raw?.smtpPasswordSet === true,
  };
}

// 同步取当前配置；未加载/无文件 → 默认全空。
export function getNotifyConfig() {
  return cache || { ...DEFAULTS };
}

// 启动时调用一次，把文件读进缓存。best-effort：读失败 / 无文件 → 默认。
export async function loadNotifyConfig() {
  try {
    cache = existsSync(NOTIFY_CONFIG_FILE) ? normalize(JSON.parse((await readFile(NOTIFY_CONFIG_FILE, "utf8")) || "{}")) : { ...DEFAULTS };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

// 合并写回（只认 patch 里的已知字段），更新缓存并落盘。
export async function saveNotifyConfig(patch) {
  const next = normalize({ ...getNotifyConfig(), ...patch });
  await writeJsonAtomic(NOTIFY_CONFIG_FILE, next);
  cache = next;
  return next;
}

// 仅供测试：重置内存缓存（不动文件）。
export function __resetNotifyConfigCacheForTest() {
  cache = null;
}
