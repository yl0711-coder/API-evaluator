// server/newapi-source.mjs
// 从 new-api 取渠道行的两种可插拔数据源，由 EVALUATOR_IMPORT_SOURCE 选择：
//   api(A1)：调 new-api 管理 API（admin access token）。**只拿元信息**——取明文 key 的端点被
//            new-api 的 RootAuth + 2FA 保护、无法自动化，故 A1 导入后 key 需在“渠道管理”手动补。
//   db (A2)：直读 new-api 的 channels 表（含明文 key），完全自动。需 EVALUATOR_NEWAPI_DB_DSN +
//            mysql2 驱动（核心依赖不含，按需 `pnpm add mysql2`，懒加载）。
// 通用：任何 new-api 用户配自己的来源即可复用（channels 表结构来自 new-api 开源，版本兼容见 README）。
import { envCompat } from "./env-compat.mjs";

export function importSourceMode() {
  return String(envCompat("IMPORT_SOURCE") || "").toLowerCase();
}

export async function fetchNewapiChannels() {
  const mode = importSourceMode();
  if (mode === "db") return fetchViaDb();
  if (mode === "api") return fetchViaApi();
  throw new Error("未配置导入来源：请设置 EVALUATOR_IMPORT_SOURCE=api 或 db（见 README）。");
}

async function fetchViaApi() {
  const base = String(envCompat("NEWAPI_BASE_URL") || "").replace(/\/+$/, "");
  const token = envCompat("NEWAPI_IMPORT_TOKEN");
  if (!base || !token) throw new Error("api 模式需要 EVALUATOR_NEWAPI_BASE_URL + EVALUATOR_NEWAPI_IMPORT_TOKEN（new-api 管理员 access token）。");
  const rows = [];
  for (let page = 0; page < 50; page += 1) {
    const res = await fetch(`${base}/api/channel/?p=${page}&page_size=100`, { headers: { Authorization: token } });
    if (!res.ok) throw new Error(`new-api 渠道接口返回 ${res.status}（确认 token 有管理员权限）。`);
    const body = await res.json().catch(() => null);
    const items = Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.items) ? body.data.items : [];
    if (!items.length) break;
    rows.push(...items);
    if (items.length < 100) break;
  }
  return rows;
}

async function fetchViaDb() {
  const dsn = envCompat("NEWAPI_DB_DSN");
  if (!dsn) throw new Error("db 模式需要 EVALUATOR_NEWAPI_DB_DSN（new-api 库的只读连接串）。");
  let mysql;
  try {
    mysql = (await import("mysql2/promise")).default ?? (await import("mysql2/promise"));
  } catch {
    throw new Error("db 模式需要 mysql2 驱动（核心依赖不含）。请在部署环境执行 `pnpm add mysql2` 后重试。");
  }
  let conn;
  try {
    conn = await mysql.createConnection(dsn);
  } catch {
    // 不回显原始错误：DSN 含库密码，连接错误可能带出连接串片段。
    throw new Error("连接 new-api 数据库失败：请检查 EVALUATOR_NEWAPI_DB_DSN 是否正确、库可达、账号有 channels 表 SELECT 权限。");
  }
  try {
    // 只读 channels 表的稳定核心列（见 new-api model/channel.go）。
    const [rows] = await conn.query("SELECT id, type, name, base_url, models, status, `key` FROM channels");
    return Array.isArray(rows) ? rows : [];
  } catch {
    throw new Error("读取 new-api channels 表失败：请确认表结构与权限（见 README 的兼容版本）。");
  } finally {
    await conn.end().catch(() => {});
  }
}
