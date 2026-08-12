// API 访问控制（鉴权判定）。抽成纯函数便于测试这条安全边界：
//   免登录白名单 → 放行；否则需有效会话（401）；角色不在放行名单（403）；
//   配置 / 平台级操作额外要求超管（403）。
import { canWriteConfig, isRoleAllowed } from "./auth.mjs";

// 免登录白名单（其余 /api/* 均需有效会话）。
//
// ⚠️ 白名单端点的响应体等于**对任何能访问到本服务的人公开**，加字段前先问一句
// 「这条信息给陌生人看要紧吗」。当前两个都是刻意如此：
//
//   · /api/health —— 容器健康检查与 autoheal 看门狗必须能在无凭据的情况下调用
//     （见 deploy 的 compose healthcheck）。它的响应里含**进程与运行时诊断**：
//     pid、版本号、内存/CPU/事件循环延迟、并发额度与队列深度、上游请求错误计数
//     （见 server.mjs 的 handleHealth 与 server/performance.mjs）。
//     这是【有意接受】的权衡：这些是聚合数值，不含 API key、baseUrl、渠道名、模型名、
//     prompt 或任何用户数据；换来的是健康检查不必持凭据。
//     代价要认清：未登录者可据此推断服务版本（据以查已知漏洞）、是否正在跑测试、
//     负载水位。因此本服务【不应直接暴露在公网】——按 README 与部署文档，
//     它设计为在内网/本机运行，公网暴露时应由反向代理对 /api/health 限流或限源。
//     若哪天要往 health 里加更敏感的东西（如渠道名、baseUrl、错误详情），
//     必须另开一个需登录的诊断端点，不要往这里塞。
//
//   · /api/client-errors —— 前端崩溃上报。未登录也可能崩（登录框本身就会崩），
//     上报必须在鉴权之前可用，否则最需要诊断的那类故障永远收不到。
//
// tests/api-access.test.mjs 钉住了这个集合：增删白名单成员会让「白名单只含这两个」失败，
// 强制改动者回到这段注释确认是有意的。
export const PUBLIC_API_PATHS = new Set(["/api/health", "/api/client-errors"]);

// 哪些请求需要超管(role 100)：support-bundle，以及 /api/profiles、/api/channels 的写操作（非 GET）。
// 渠道(channels)持 key，只超管能写；模型目标(model-targets)不持 key，管理员(role 10)即可维护（增删改），不在此列。
export function requiresAdmin(method, pathname) {
  if (pathname === "/api/support-bundle") return true;
  if (pathname.startsWith("/api/profiles")) return method !== "GET";
  if (pathname.startsWith("/api/channels")) return method !== "GET";
  // /api/settings 写不再一刀切要超管：普通管理员(role 10)可改「不影响 new-api」的设置；
  // 影响 new-api 的字段（网关配置）在端点内做字段级门禁（server.mjs PUT /api/settings）。
  if (pathname.startsWith("/api/dev/")) return true; // 开发者接口（含 GET，会暴露 prompt/答案）：一律超管
  if (pathname.startsWith("/api/notify")) return true; // 邮件报警发信配置（含 GET，持有 SMTP 凭证）：一律超管
  if (pathname === "/api/reports/files/download" && method === "POST") return true; // 批量导出占用受限 CPU/内存，仅超管可发起
  if (pathname.startsWith("/api/reports/") && method === "DELETE") return true; // 删除报告文件：只超管；GET 列表/查看不受影响
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
