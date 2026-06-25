// API 访问控制（鉴权判定）。抽成纯函数便于测试这条安全边界：
//   免登录白名单 → 放行；否则需有效会话（401）；角色不在放行名单（403）；
//   配置 / 平台级操作额外要求超管（403）。
import { canWriteConfig, isRoleAllowed } from "./auth.mjs";

// 免登录白名单（其余 /api/* 均需有效会话）。
export const PUBLIC_API_PATHS = new Set(["/api/health", "/api/client-errors"]);

// 哪些请求需要超管(role 100)：support-bundle，以及 /api/profiles、/api/channels 的写操作（非 GET）。
// 渠道(channels)持 key，只超管能写；模型目标(model-targets)不持 key，管理员(role 10)即可写，不在此列。
export function requiresAdmin(method, pathname) {
  if (pathname === "/api/support-bundle") return true;
  if (pathname.startsWith("/api/profiles")) return method !== "GET";
  if (pathname.startsWith("/api/channels")) return method !== "GET";
  if (pathname === "/api/settings") return method !== "GET"; // 平台级设置：写需超管，读任意会话
  return false;
}

// 鉴权判定（纯函数）。session 为 getSessionFromRequest 的结果（可能为 null）。
// 返回 { allow: true, public?, session? } 或 { allow: false, status, error, userMessage }。
export function evaluateApiAccess({ method, pathname, session }) {
  if (PUBLIC_API_PATHS.has(pathname)) {
    return { allow: true, public: true };
  }
  if (!session) {
    return { allow: false, status: 401, error: "unauthorized", userMessage: "请先登录。" };
  }
  if (!isRoleAllowed(session.role)) {
    return { allow: false, status: 403, error: "forbidden_role", userMessage: "该账号无权使用评测平台。" };
  }
  if (requiresAdmin(method, pathname) && !canWriteConfig(session.role)) {
    return { allow: false, status: 403, error: "forbidden_admin", userMessage: "仅超级管理员可执行配置 / 平台级操作。" };
  }
  return { allow: true, session };
}
