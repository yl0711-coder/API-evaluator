// Authentication & roles. 鉴权与角色。
// 可插拔的登录后端（EVALUATOR_AUTH_BACKEND）：
// - "local"（默认）：用平台自带账号校验（EVALUATOR_ADMIN_PASSWORD / EVALUATOR_LOCAL_USERS），
//   clone 下来即可用，不依赖任何外部系统。密码只在内存常量时间比对，绝不落盘/入日志。
// - "newapi"：把账密转发给一个 new-api 兼容网关的 /api/user/login 校验并取角色（不改其源码、账密不落盘/不日志）。
// 校验通过后由本平台用 HMAC-SHA256 自签会话 Cookie。
// 仅 role ∈ EVALUATOR_ALLOWED_ROLES（默认 100,10）放行；配置/平台级操作额外要求 role >= EVALUATOR_CONFIG_WRITE_ROLE（默认 100）。
import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE_NAME = "evaluator_session";

// —— 配置读取（运行时读 env，便于测试覆盖）——
function sessionSecret() {
  return process.env.EVALUATOR_SESSION_SECRET || "";
}
function sessionTtlMs() {
  const hours = Number(process.env.EVALUATOR_SESSION_TTL_HOURS || 12);
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3600 * 1000;
}
function newApiBaseUrl() {
  return (process.env.EVALUATOR_NEWAPI_BASE_URL || "").replace(/\/+$/, "");
}
function authBackend() {
  return (process.env.EVALUATOR_AUTH_BACKEND || "local").trim().toLowerCase();
}
function allowedRoles() {
  return (process.env.EVALUATOR_ALLOWED_ROLES || "100,10")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}
function configWriteRole() {
  const r = Number(process.env.EVALUATOR_CONFIG_WRITE_ROLE || 100);
  return Number.isFinite(r) ? r : 100;
}
function cookieSecure() {
  // 生产经 Caddy HTTPS，默认 Secure；本地 http 测试可设 EVALUATOR_COOKIE_SECURE=false
  return process.env.EVALUATOR_COOKIE_SECURE !== "false";
}

// —— 会话签名 / 校验（HMAC-SHA256，格式 base64url(payload).base64url(sig)）——
function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export function signSession(payload) {
  const secret = sessionSecret();
  if (!secret) throw new Error("EVALUATOR_SESSION_SECRET 未配置，无法签发会话。");
  const body = b64urlJson(payload);
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token) {
  const secret = sessionSecret();
  if (!secret || !token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
  return payload;
}

export function createSessionToken({ userId, username, role }) {
  return signSession({ userId, username, role: Number(role), exp: Date.now() + sessionTtlMs() });
}

// —— 角色判定 ——
export function isRoleAllowed(role) {
  return allowedRoles().includes(Number(role));
}
export function canWriteConfig(role) {
  return Number(role) >= configWriteRole();
}

// —— Cookie 工具 ——
export function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
export function getSessionFromRequest(req) {
  const token = parseCookies(req.headers?.cookie)[SESSION_COOKIE_NAME];
  return verifySession(token);
}
export function buildSessionCookie(token) {
  const maxAge = Math.floor(sessionTtlMs() / 1000);
  const flags = ["HttpOnly", "Path=/", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (cookieSecure()) flags.push("Secure");
  return `${SESSION_COOKIE_NAME}=${token}; ${flags.join("; ")}`;
}
export function clearSessionCookie() {
  const flags = ["HttpOnly", "Path=/", "SameSite=Strict", "Max-Age=0"];
  if (cookieSecure()) flags.push("Secure");
  return `${SESSION_COOKIE_NAME}=; ${flags.join("; ")}`;
}
// 登录限流用的客户端 IP。默认只认 socket 真实地址：X-Forwarded-For 头可被客户端伪造，
// 直连可达时若信任它，攻击者每次换个假 IP 就能绕过限流、无限撞库。仅当部署在会覆写 XFF
// 的可信反代后、且显式设置 EVALUATOR_TRUST_PROXY=true 时，才采用 XFF 第一段当真实客户端。
export function clientIp(req) {
  if (process.env.EVALUATOR_TRUST_PROXY === "true") {
    const xff = req.headers?.["x-forwarded-for"];
    if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

// —— 登录失败限流（内存，按 IP|账号 维度；防经评测平台对 new-api 撞库）——
const loginFailures = new Map();
function loginMaxFail() {
  const n = Number(process.env.EVALUATOR_LOGIN_MAX_FAIL || 5);
  return Number.isFinite(n) && n > 0 ? n : 5;
}
function loginLockMs() {
  const n = Number(process.env.EVALUATOR_LOGIN_LOCK_MS || 5 * 60 * 1000);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
}
export function loginThrottleCheck(key) {
  const rec = loginFailures.get(key);
  if (rec && rec.until > Date.now()) return { blocked: true, retryAfterMs: rec.until - Date.now() };
  return { blocked: false };
}
export function loginThrottleFail(key) {
  const now = Date.now();
  const rec = loginFailures.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= loginMaxFail()) {
    rec.until = now + loginLockMs();
    rec.count = 0;
  }
  loginFailures.set(key, rec);
}
export function loginThrottleReset(key) {
  loginFailures.delete(key);
}
// 仅供测试清理
export function _resetLoginThrottle() {
  loginFailures.clear();
}

// —— 调 new-api 校验身份并取角色 ——
// 账密只在内存转发，不落盘、不日志。返回 { ok, user?:{userId,username,role}, reason? }。
export async function authenticateWithNewApi(username, password, opts = {}) {
  const base = opts.baseUrl || newApiBaseUrl();
  const fetchImpl = opts.fetchImpl || fetch;
  if (!base) throw new Error("EVALUATOR_NEWAPI_BASE_URL 未配置，无法校验登录。");

  const loginRes = await fetchImpl(`${base}/api/user/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const loginJson = await loginRes.json().catch(() => null);
  if (!loginRes.ok || !loginJson || loginJson.success === false) {
    return { ok: false, reason: "bad_credentials" };
  }

  let data = loginJson.data || {};
  let role = Number(data.role);

  // login 未直接带 role 时，用 new-api 的会话 cookie 调 /api/user/self 兜底
  if (!Number.isFinite(role)) {
    const setCookie = loginRes.headers.get?.("set-cookie") || "";
    const cookie = setCookie ? setCookie.split(";")[0] : "";
    const selfRes = await fetchImpl(`${base}/api/user/self`, {
      headers: cookie ? { cookie } : {},
    });
    const selfJson = await selfRes.json().catch(() => null);
    data = selfJson?.data || data;
    role = Number(data.role);
  }

  if (!Number.isFinite(role)) return { ok: false, reason: "no_role" };
  const userId = String(data.id ?? data.userId ?? username);
  return { ok: true, user: { userId, username: data.username || username, role } };
}

// —— 本地账号校验（默认后端，零外部依赖）——
// 账号来源：EVALUATOR_ADMIN_PASSWORD（生成 admin/role=100）+ 可选 EVALUATOR_LOCAL_USERS（"name:password:role,..."）。
// 密码可含冒号：按“首个冒号前=用户名、末个冒号后=角色、中间=密码”解析。
export function localUsers() {
  const users = new Map();
  const adminPw = process.env.EVALUATOR_ADMIN_PASSWORD || "";
  if (adminPw) users.set("admin", { userId: "admin", username: "admin", role: 100, password: adminPw });
  const raw = process.env.EVALUATOR_LOCAL_USERS || "";
  for (const entry of raw.split(",")) {
    const s = entry.trim();
    if (!s) continue;
    const firstColon = s.indexOf(":");
    const lastColon = s.lastIndexOf(":");
    if (firstColon <= 0 || lastColon === firstColon) continue; // 需要 name:password:role 两个冒号
    const name = s.slice(0, firstColon).trim();
    const password = s.slice(firstColon + 1, lastColon);
    const role = Number(s.slice(lastColon + 1).trim());
    if (!name || !password || !Number.isFinite(role)) continue;
    users.set(name, { userId: name, username: name, role, password });
  }
  return users;
}

export function hasConfiguredLocalUsers() {
  return localUsers().size > 0;
}

// 常量时间比对密码；不区分“用户不存在 / 密码错误”。
export function authenticateLocal(username, password, opts = {}) {
  const users = opts.users || localUsers();
  const u = users.get(String(username));
  const expected = u ? String(u.password) : "";
  const a = Buffer.from(String(password));
  const b = Buffer.from(expected);
  const match = a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  if (!u || !match) return { ok: false, reason: "bad_credentials" };
  return { ok: true, user: { userId: u.userId, username: u.username, role: u.role } };
}

// 统一登录入口：按 EVALUATOR_AUTH_BACKEND 分派（local 默认 / newapi）。
export async function authenticate(username, password, opts = {}) {
  const backend = (opts.backend || authBackend()).toLowerCase();
  if (backend === "newapi" || backend === "new-api") {
    return authenticateWithNewApi(username, password, opts);
  }
  return authenticateLocal(username, password, opts);
}

export const SESSION_COOKIE = SESSION_COOKIE_NAME;
