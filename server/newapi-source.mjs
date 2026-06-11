// server/newapi-source.mjs
// 从 new-api 取渠道行的两种可插拔数据源，由 EVALUATOR_IMPORT_SOURCE 选择：
//   api(A1)：调 new-api 管理 API（admin access token）。**只拿元信息**——取明文 key 的端点被
//            new-api 的 RootAuth + 2FA 保护、无法自动化，故 A1 导入后 key 需在“渠道管理”手动补。
//   db (A2)：直读 new-api 的 channels 表（含明文 key），完全自动。需 EVALUATOR_NEWAPI_DB_DSN（只读）。
//            mysql2 是核心依赖（已随镜像带上），import 即用。
// 通用：任何 new-api 用户配自己的来源即可复用（channels 表结构来自 new-api 开源，版本兼容见 README）。
import { envCompat } from "./env-compat.mjs";

export function importSourceMode() {
  return String(envCompat("IMPORT_SOURCE") || "").toLowerCase();
}

// DSN 归一化：兼容 monitor(Go 驱动) 的 `user:pass@tcp(host:port)/db?params` 写法 —— 转成 mysql2 连接配置，
// 让用户能直接复用 monitor 那条只读连接串。mysql:// URI 与其它形式原样透传给 mysql2。
export function normalizeMysqlDsn(dsn) {
  const s = String(dsn || "").trim();
  const go = s.match(/^([^:]+):(.*)@tcp\(([^:)]+):(\d+)\)\/([^?]+)(?:\?.*)?$/);
  if (go) {
    return { host: go[3], port: Number(go[4]), user: go[1], password: go[2], database: go[5] };
  }
  return s; // mysql://user:pass@host:port/db 或裸主机串，交给 mysql2 自己解析
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
  const PAGE_SIZE = 100;
  const PAGE_CAP = 50; // 最多 5000 个渠道；超出则只导前 5000 并告警，避免无界翻页
  const rows = [];
  let truncated = false;
  for (let page = 0; page < PAGE_CAP; page += 1) {
    const res = await fetch(`${base}/api/channel/?p=${page}&page_size=${PAGE_SIZE}`, { headers: { Authorization: token } });
    if (!res.ok) throw new Error(`new-api 渠道接口返回 ${res.status}（确认 token 有管理员权限）。`);
    const body = await res.json().catch(() => null);
    const items = Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.items) ? body.data.items : [];
    if (!items.length) break;
    rows.push(...items);
    if (items.length < PAGE_SIZE) break;
    if (page === PAGE_CAP - 1) truncated = true; // 跑满上限且最后一页仍是满的 -> 可能没导全
  }
  if (truncated) {
    console.warn(`[newapi-import] 渠道分页命中 ${PAGE_CAP * PAGE_SIZE} 条上限，可能未导全；大站请用 db 模式或分批处理。`);
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
    throw new Error("缺少 mysql2 驱动：db 模式需要 mysql2（正常随镜像带上；本地用 db 模式请 `pnpm add mysql2`）。");
  }
  let conn;
  try {
    conn = await mysql.createConnection(normalizeMysqlDsn(dsn));
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
