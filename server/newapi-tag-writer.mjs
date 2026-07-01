// server/newapi-tag-writer.mjs
// new-api 配置 / 鉴权 helper（标签联动功能已下线，本文件只保留共享的连接配置与鉴权头）。
// 严格遵循 new-api 管理 API 约定：
//   - 鉴权双头：Authorization=系统访问令牌（不带 Bearer）、New-Api-User=管理员用户ID。
// 被 newapi-channel-sync.mjs（渠道/模型推送）、newapi-source.mjs（导入）、server.mjs（配置门禁）复用。
//
// 安全：系统访问令牌（敏感）走加密库（secret-store，固定 ref `newapi:import-token`），不落 settings.json。
// 启动时由 loadNewapiToken() 解密一次、缓存进内存；readConfig() 仍同步读内存——所有调用方无需改动。
import { envCompat } from "./env-compat.mjs";
import { getSettings } from "./settings-store.mjs";
import { saveSecret, readSecret } from "./secret-store.mjs";

// 加密库里 new-api 令牌的固定 ref（与 profile:<id>:api-key 同库不同键）。
export const NEWAPI_TOKEN_REF = "newapi:import-token";

// 去掉可能误带入的行内注释（空白后的 #...）与首尾空白，避免把注释/全角符号塞进 HTTP 头。
const cleanValue = (v) => String(v || "").replace(/\s+#.*$/, "").trim();

// 令牌的内存缓存（启动解密一次；readConfig 同步读取）。
let cachedToken = "";

// 启动时调用一次（server.mjs，紧挨 loadSettings）：把令牌从加密库解密进内存缓存。
// legacyToken 非空＝旧版 settings.json 里迁移来的明文令牌：写进加密库并缓存。
export async function loadNewapiToken(legacyToken = "") {
  const legacy = cleanValue(legacyToken);
  if (legacy) {
    await saveSecret(NEWAPI_TOKEN_REF, legacy);
    cachedToken = legacy;
    return cachedToken;
  }
  cachedToken = cleanValue(await readSecret(NEWAPI_TOKEN_REF));
  return cachedToken;
}

// 设置端点保存令牌：写进加密库并刷新内存缓存。空令牌＝不改（由调用方保证「留空保留原值」）。
export async function saveNewapiToken(token) {
  const t = cleanValue(token);
  if (!t) return cachedToken;
  await saveSecret(NEWAPI_TOKEN_REF, t);
  cachedToken = t;
  return cachedToken;
}

// 读取 new-api 连接配置（同步）。base/userId 来自设置（非密，存 settings.json）；
// token 来自内存缓存（加密库解密而来），环境变量 EVALUATOR_NEWAPI_IMPORT_TOKEN 仍作兜底。
// New-Api-User 默认管理员 1，可用 EVALUATOR_NEWAPI_USER_ID 覆盖。
export function readConfig() {
  // 设置页优先、环境变量兜底；getSettings() 是同步内存缓存（启动时已加载）。
  const s = getSettings();
  return {
    base: cleanValue(s.newapiBaseUrl || envCompat("NEWAPI_BASE_URL")).replace(/\/+$/, ""),
    token: cachedToken || cleanValue(envCompat("NEWAPI_IMPORT_TOKEN")),
    userId: cleanValue(s.newapiUserId || envCompat("NEWAPI_USER_ID")) || "1",
  };
}

// 通用「new-api 是否已配置」门禁（base + token 齐备）。
export function isNewapiTagWriterConfigured() {
  const { base, token } = readConfig();
  return Boolean(base && token);
}

// 渠道/模型推送复用的鉴权头（newapi-channel-sync.mjs）。
export function authHeaders({ token, userId }) {
  return { Authorization: token, "New-Api-User": userId };
}
