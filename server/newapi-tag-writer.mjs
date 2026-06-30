// server/newapi-tag-writer.mjs
// new-api 配置 / 鉴权 helper（标签联动功能已下线，本文件只保留共享的连接配置与鉴权头）。
// 严格遵循 new-api 管理 API 约定：
//   - 鉴权双头：Authorization=系统访问令牌（不带 Bearer）、New-Api-User=管理员用户ID。
// 被 newapi-channel-sync.mjs（渠道/模型推送）、newapi-source.mjs（导入）、server.mjs（配置门禁）复用。
import { envCompat } from "./env-compat.mjs";
import { getSettings } from "./settings-store.mjs";

// 读取 new-api 连接配置；New-Api-User 默认管理员 1，可用 EVALUATOR_NEWAPI_USER_ID 覆盖。
// 容错：去掉可能误带入的行内注释（空白后的 #...）与首尾空白，避免把注释/全角符号塞进 HTTP 头。
export function readConfig() {
  const clean = (v) => String(v || "").replace(/\s+#.*$/, "").trim();
  // 设置页优先、环境变量兜底；getSettings() 是同步内存缓存（启动时已加载）。
  const s = getSettings();
  return {
    base: clean(s.newapiBaseUrl || envCompat("NEWAPI_BASE_URL")).replace(/\/+$/, ""),
    token: clean(s.newapiImportToken || envCompat("NEWAPI_IMPORT_TOKEN")),
    userId: clean(s.newapiUserId || envCompat("NEWAPI_USER_ID")) || "1",
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
