// server/db.mjs
//
// SQLite 数据层。用 SQLite 取代 JSONL 尾部截断，为统计严谨（bootstrap/重测信度/完整历史）
// 提供结构化、可查询、不丢老数据的存储。
//
// 驱动：Node 内置 **node:sqlite**（DatabaseSync），不是 better-sqlite3——零三方依赖、
//   零原生编译。Node 22.5+ / 24 自带（Docker 运行镜像已满足）。
//   防御性懒加载：若运行环境的 Node 不带 node:sqlite，本模块所有写入静默降级为 no-op，
//   回退 JSONL，绝不让测试或主链路崩。
//
// 事实源：SQLite 可用时为主（全量、不截断）；不可用时降级 JSONL 兜底。与 JSONL 双写，
//   JSONL 作兼容镜像。

import { join } from "node:path";
import { SQLITE_DB_FILE } from "./paths.mjs";
import { envCompat } from "./env-compat.mjs";
import { currentRunBy } from "./run-context.mjs";

// 默认库路径在调用时按 env 解析（而非 import 时固定），保证测试逐用例隔离：
// 每个测试设自己的 EVALUATOR_DATA_DIR / EVALUATOR_SQLITE_DB 就有独立 db。
function defaultDbPath() {
  const sqliteDb = envCompat("SQLITE_DB");
  if (sqliteDb) return sqliteDb;
  const dataDir = envCompat("DATA_DIR");
  if (dataDir) return join(dataDir, "evaluator.db");
  return SQLITE_DB_FILE;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS test_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  run_id TEXT,
  case_id TEXT,
  profile_id TEXT,
  profile_name TEXT,
  profile_role TEXT,
  provider TEXT,
  model TEXT,
  protocol TEXT,
  started_at TEXT,
  first_byte_ms INTEGER,
  first_token_ms INTEGER,
  total_ms INTEGER,
  status_code INTEGER,
  success INTEGER,
  normalized_error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens INTEGER,
  reasoning_tokens INTEGER,
  token_source TEXT,
  output_chars INTEGER,
  estimated_tokens INTEGER,
  token_audit_flag TEXT,
  raw_json TEXT,
  logged_at TEXT,
  run_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_run ON test_requests(run_id);
CREATE INDEX IF NOT EXISTS idx_requests_profile ON test_requests(profile_id);

CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  type TEXT,
  profile_id TEXT,
  profile_name TEXT,
  sample_size INTEGER,
  success_count INTEGER,
  success_rate REAL,
  ci_lower REAL,
  ci_upper REAL,
  statistical_method TEXT,
  started_at TEXT,
  ended_at TEXT,
  raw_json TEXT,
  logged_at TEXT,
  run_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_run ON test_runs(run_id);

CREATE TABLE IF NOT EXISTS model_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  provider TEXT,
  protocol TEXT,
  base_url TEXT,
  models_json TEXT,
  unit_price_json TEXT,
  key_ref TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT,
  base_url TEXT,
  status TEXT,
  source TEXT,
  newapi_channel_id INTEGER,
  created_at TEXT,
  updated_at TEXT,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS model_targets (
  id TEXT PRIMARY KEY,
  channel_id TEXT,
  model TEXT,
  created_at TEXT,
  updated_at TEXT,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  report_id TEXT PRIMARY KEY,
  run_by TEXT,
  run_id TEXT,
  type TEXT,
  title TEXT,
  path_md TEXT,
  path_html TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);

CREATE TABLE IF NOT EXISTS spend_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_by TEXT,
  run_id TEXT,
  estimated REAL,
  actual REAL,
  currency TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS model_fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT,
  model TEXT,
  declared_family TEXT,
  reported_family TEXT,
  identity_status TEXT,
  protocol TEXT,
  tokenizer_signature TEXT,
  probe_signature TEXT,
  run_id TEXT,
  created_at TEXT,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_fp_profile ON model_fingerprints(profile_id);
CREATE INDEX IF NOT EXISTS idx_fp_model ON model_fingerprints(model);

CREATE TABLE IF NOT EXISTS regression_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT,
  profile_name TEXT,
  run_id TEXT,
  run_type TEXT,
  severity TEXT,
  summary TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_profile ON regression_alerts(profile_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON regression_alerts(created_at);
`;

let DatabaseSync = null;
let moduleAvailable = null; // null=未探测, true/false=已探测
const openConnections = new Map(); // path -> DatabaseSync 实例（按路径缓存）

// 写入可观测性：best-effort 降级会吞异常，但必须可诊断，否则 SQLite 持续写失败
// 时无人知晓，直到读路径暴露数据缺失。计数 + 首次 warn（不刷屏），并入 support-bundle。
const dbHealth = {
  requestWriteFailures: 0,
  runWriteFailures: 0,
  lastError: null,
  warned: false,
};

function noteDbError(scope, error) {
  dbHealth.lastError = `${scope}: ${error?.message ? String(error.message) : String(error)}`;
  if (!dbHealth.warned) {
    dbHealth.warned = true;
    console.warn(`[db] SQLite 写入失败，已降级到 JSONL（后续失败仅计数不再刷屏）：${dbHealth.lastError}`);
  }
}

// 数据层健康快照（供 support-bundle / 诊断用）。事实源约定：SQLite 可用时为主
// （全量、不截断），JSONL 为兼容镜像/兜底；写失败计数 > 0 表示两者可能已偏离。
export function getDbHealth() {
  return {
    sqliteAvailable: moduleAvailable === true,
    requestWriteFailures: dbHealth.requestWriteFailures,
    runWriteFailures: dbHealth.runWriteFailures,
    lastError: dbHealth.lastError,
  };
}

async function ensureModule() {
  if (moduleAvailable !== null) return moduleAvailable;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
    moduleAvailable = typeof DatabaseSync === "function";
  } catch {
    moduleAvailable = false;
  }
  return moduleAvailable;
}

export async function isSqliteAvailable() {
  return ensureModule();
}

export async function getDatabase(path = defaultDbPath()) {
  if (!(await ensureModule())) return null;
  const existing = openConnections.get(path);
  if (existing) return existing;
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  migrateSchema(db);
  openConnections.set(path, db);
  return db;
}

// 旧库补列（新库 CREATE 已含 run_by；ALTER 对已存在列会抛错，幂等吞掉）。
function migrateSchema(db) {
  for (const table of ["test_requests", "test_runs"]) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN run_by TEXT`);
    } catch {
      // 列已存在
    }
  }
}

export function closeDatabase(path = defaultDbPath()) {
  const db = openConnections.get(path);
  if (db) {
    try {
      db.close();
    } catch {
      // best-effort
    }
    openConnections.delete(path);
  }
}

const toInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
};
const toReal = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const nowIso = (record) => record?.loggedAt || record?.startedAt || null;

// 写一条逐请求记录。best-effort：任何异常都吞掉，返回 false，绝不影响主链路。
export async function recordRequest(record, { path } = {}) {
  try {
    if (!record) return false;
    const db = await getDatabase(path);
    if (!db) return false;
    const stmt = db.prepare(`
      INSERT INTO test_requests (
        request_id, run_id, case_id, profile_id, profile_name, profile_role,
        provider, model, protocol, started_at, first_byte_ms, first_token_ms,
        total_ms, status_code, success, normalized_error, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, reasoning_tokens, token_source,
        output_chars, estimated_tokens, token_audit_flag, raw_json, logged_at, run_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    stmt.run(
      record.requestId ?? null,
      record.runId ?? null,
      record.caseId ?? null,
      record.profileId ?? null,
      record.profileName ?? null,
      record.profileRole ?? null,
      record.provider ?? null,
      record.model ?? null,
      record.protocol ?? null,
      record.startedAt ?? null,
      toInt(record.firstByteMs),
      toInt(record.firstTokenMs),
      toInt(record.totalMs),
      toInt(record.statusCode),
      record.success ? 1 : 0,
      record.normalizedError ?? null,
      toInt(record.inputTokens),
      toInt(record.outputTokens),
      toInt(record.cacheCreationTokens),
      toInt(record.cacheReadTokens),
      toInt(record.reasoningTokens),
      record.tokenSource ?? null,
      toInt(record.outputChars),
      toInt(record.estimatedTokens),
      record.tokenAuditFlag ?? null,
      JSON.stringify(record),
      nowIso(record),
      record.runBy ?? currentRunBy(),
    );
    return true;
  } catch (error) {
    dbHealth.requestWriteFailures += 1;
    noteDbError("recordRequest", error);
    return false;
  }
}

// 写一条测试运行汇总。从稳定性/场景 summary 里提取已知字段，其余落 raw_json。
export async function recordTestRun(summary, { type = "", path } = {}) {
  try {
    if (!summary) return false;
    const db = await getDatabase(path);
    if (!db) return false;
    const ci = summary.successRateCi || {};
    const stmt = db.prepare(`
      INSERT INTO test_runs (
        run_id, type, profile_id, profile_name, sample_size, success_count,
        success_rate, ci_lower, ci_upper, statistical_method, started_at, ended_at,
        raw_json, logged_at, run_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    stmt.run(
      summary.runId ?? null,
      type || summary.type || "",
      summary.profileId ?? null,
      summary.profileName ?? null,
      toInt(summary.sampleSize ?? summary.rounds ?? summary.caseCount ?? summary.requestCount),
      toInt(summary.successCount),
      toReal(summary.successRate),
      toReal(ci.ci95Lower),
      toReal(ci.ci95Upper),
      ci.method || null,
      summary.startedAt ?? null,
      summary.endedAt ?? null,
      JSON.stringify(slimSummaryForStorage(summary)),
      summary.endedAt ?? summary.startedAt ?? null,
      summary.runBy ?? currentRunBy(),
    );
    return true;
  } catch (error) {
    dbHealth.runWriteFailures += 1;
    noteDbError("recordTestRun", error);
    return false;
  }
}

// 按 run_id 全量读取逐请求记录（统计严谨需要完整历史，不截断）。
export async function queryRequestsByRun(runId, { path } = {}) {
  const db = await getDatabase(path);
  if (!db) return [];
  return db.prepare("SELECT * FROM test_requests WHERE run_id = ? ORDER BY id ASC").all(runId);
}

export async function countRequests({ path } = {}) {
  const db = await getDatabase(path);
  if (!db) return 0;
  return db.prepare("SELECT COUNT(*) AS n FROM test_requests").get().n;
}

// 最近 N 条逐请求记录，**newest-first**，还原成原始记录形状（解析 raw_json），
// 与旧的 readRecentRequests 输出形状一致，UI 无需改动。
export async function queryRecentRequests(limit = 50, { path } = {}) {
  const db = await getDatabase(path);
  if (!db) return null;
  const rows = db
    .prepare("SELECT raw_json FROM test_requests ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.floor(limit)));
  return rows.map((row) => safeParse(row.raw_json)).filter(Boolean);
}

export async function queryRecentTestRuns(limit = 20, { path } = {}) {
  const db = await getDatabase(path);
  if (!db) return null;
  const rows = db
    .prepare("SELECT raw_json FROM test_runs ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.floor(limit)));
  return rows.map((row) => safeParse(row.raw_json)).filter(Boolean);
}

// 同一 profile 的历次运行（重测信度 / 跨运行对比用）。
export async function queryRunsByProfile(profileId, { path } = {}) {
  const db = await getDatabase(path);
  if (!db) return [];
  return db
    .prepare("SELECT * FROM test_runs WHERE profile_id = ? ORDER BY id ASC")
    .all(profileId);
}

// 同一 profile 的历次运行汇总（解析 raw_json，时间升序），供趋势图/基线回归用。
export async function queryProfileRunSummaries(profileId, { limit = 200, path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return [];
    const rows = db
      .prepare("SELECT raw_json FROM test_runs WHERE profile_id = ? ORDER BY id DESC LIMIT ?")
      .all(profileId, Math.max(1, Math.floor(limit)));
    return rows
      .map((row) => safeParse(row.raw_json))
      .filter(Boolean)
      .reverse(); // 转回时间升序
  } catch (error) {
    noteDbError("queryProfileRunSummaries", error);
    return [];
  }
}

// —— 基线回归告警 ——
export async function recordRegressionAlert(alert, { path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return false;
    db.prepare(`
      INSERT INTO regression_alerts (profile_id, profile_name, run_id, run_type, severity, summary, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      String(alert.profileId || ""),
      alert.profileName || null,
      alert.runId || null,
      alert.runType || null,
      alert.severity || null,
      alert.summary || null,
      alert.createdAt || null,
    );
    return true;
  } catch (error) {
    noteDbError("recordRegressionAlert", error);
    return false;
  }
}

export async function queryRegressionAlerts({ profileId, limit = 50, path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return [];
    const lim = Math.max(1, Math.floor(limit));
    return profileId
      ? db.prepare("SELECT * FROM regression_alerts WHERE profile_id = ? ORDER BY id DESC LIMIT ?").all(String(profileId), lim)
      : db.prepare("SELECT * FROM regression_alerts ORDER BY id DESC LIMIT ?").all(lim);
  } catch (error) {
    noteDbError("queryRegressionAlerts", error);
    return [];
  }
}

// 把已有 JSONL 逐请求日志回填进 SQLite（一次性迁移/补历史）。返回导入条数。
export async function importRequestsFromJsonl(lines, { path } = {}) {
  if (!(await ensureModule())) return 0;
  let imported = 0;
  for (const line of lines || []) {
    const record = typeof line === "string" ? safeParse(line) : line;
    if (record && (await recordRequest(record, { path }))) imported += 1;
  }
  return imported;
}

// —— 模型配置共享目录——
// 全平台共享一份；仅 role=100 可写（鉴权在 server.mjs 层把关）。
// API Key 不在此表（存 secret-store vault，本表仅留 key_ref）。完整字段存 raw_json，
// 结构化列用于查询/共享展示。sqlite 不可用时返回 null/false，调用方降级 JSON。
export async function loadModelConfigs({ path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return null;
    const rows = db.prepare("SELECT raw_json FROM model_configs ORDER BY created_at ASC, id ASC").all();
    return rows.map((row) => safeParse(row.raw_json)).filter(Boolean);
  } catch (error) {
    noteDbError("loadModelConfigs", error);
    return null;
  }
}

export async function saveModelConfigs(profiles, { path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return false;
    const list = Array.isArray(profiles) ? profiles : [];
    const insert = db.prepare(`
      INSERT INTO model_configs
        (id, name, role, provider, protocol, base_url, models_json, unit_price_json, key_ref, created_by, created_at, updated_at, raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM model_configs");
      for (const profile of list) {
        insert.run(
          String(profile.id),
          String(profile.name || ""),
          profile.role ?? null,
          profile.provider ?? null,
          profile.protocol ?? null,
          profile.baseUrl ?? null,
          JSON.stringify(profile.defaultModel ? [profile.defaultModel] : profile.models || []),
          JSON.stringify({
            inputPricePerMTokens: profile.inputPricePerMTokens ?? null,
            outputPricePerMTokens: profile.outputPricePerMTokens ?? null,
            inputSellPricePerMTokens: profile.inputSellPricePerMTokens ?? null,
            outputSellPricePerMTokens: profile.outputSellPricePerMTokens ?? null,
          }),
          profile.apiKeyRef ?? null,
          profile.createdBy ?? null,
          profile.createdAt ?? null,
          profile.updatedAt ?? null,
          JSON.stringify(profile),
        );
      }
      db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // best-effort
      }
      throw error;
    }
  } catch (error) {
    noteDbError("saveModelConfigs", error);
    return false;
  }
}

// v0.3.0 渠道 / 模型目标存储（raw_json 为事实源，列只为查询/排序）。读写模式同 model_configs。
export async function loadChannels({ path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return null;
    const rows = db.prepare("SELECT raw_json FROM channels ORDER BY created_at ASC, id ASC").all();
    return rows.map((row) => safeParse(row.raw_json)).filter(Boolean);
  } catch (error) {
    noteDbError("loadChannels", error);
    return null;
  }
}

export async function saveChannels(channels, { path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return false;
    const list = Array.isArray(channels) ? channels : [];
    const insert = db.prepare(`
      INSERT INTO channels (id, name, base_url, status, source, newapi_channel_id, created_at, updated_at, raw_json)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM channels");
      for (const channel of list) {
        insert.run(
          String(channel.id),
          String(channel.name || ""),
          channel.baseUrl ?? null,
          channel.status ?? null,
          channel.source ?? null,
          channel.newapiChannelId ?? null,
          channel.createdAt ?? null,
          channel.updatedAt ?? null,
          JSON.stringify(channel),
        );
      }
      db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // best-effort
      }
      throw error;
    }
  } catch (error) {
    noteDbError("saveChannels", error);
    return false;
  }
}

export async function loadModelTargets({ path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return null;
    const rows = db.prepare("SELECT raw_json FROM model_targets ORDER BY created_at ASC, id ASC").all();
    return rows.map((row) => safeParse(row.raw_json)).filter(Boolean);
  } catch (error) {
    noteDbError("loadModelTargets", error);
    return null;
  }
}

export async function saveModelTargets(targets, { path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return false;
    const list = Array.isArray(targets) ? targets : [];
    const insert = db.prepare(`
      INSERT INTO model_targets (id, channel_id, model, created_at, updated_at, raw_json)
      VALUES (?,?,?,?,?,?)
    `);
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM model_targets");
      for (const target of list) {
        insert.run(
          String(target.id),
          String(target.channelId || ""),
          String(target.model || ""),
          target.createdAt ?? null,
          target.updatedAt ?? null,
          JSON.stringify(target),
        );
      }
      db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // best-effort
      }
      throw error;
    }
  } catch (error) {
    noteDbError("saveModelTargets", error);
    return false;
  }
}

// —— 报告元数据 + 留存——
export async function recordReport(report, { path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return false;
    db.prepare(`
      INSERT OR REPLACE INTO reports (report_id, run_by, run_id, type, title, path_md, path_html, created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      String(report.reportId),
      report.runBy ?? currentRunBy(),
      report.runId ?? null,
      report.type ?? null,
      report.title ?? null,
      report.pathMd ?? null,
      report.pathHtml ?? null,
      report.createdAt ?? null,
    );
    return true;
  } catch (error) {
    noteDbError("recordReport", error);
    return false;
  }
}

export async function queryRecentReports(limit = 100, { path } = {}) {
  const db = await getDatabase(path);
  if (!db) return [];
  return db.prepare("SELECT * FROM reports ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.floor(limit)));
}

// 留存清理：删除超过 retentionDays 或超出 maxTotal(保留最新)的报告记录。
// 返回被删记录的文件路径(文件删除交调用方做，db 只管元数据)。
export async function pruneReports({ retentionDays = 30, maxTotal = 2000, now, path } = {}) {
  const removed = [];
  try {
    const db = await getDatabase(path);
    if (!db) return [];
    const cutoffIso = new Date((now ?? Date.now()) - retentionDays * 24 * 3600 * 1000).toISOString();
    const expired = db.prepare("SELECT * FROM reports WHERE created_at IS NOT NULL AND created_at < ?").all(cutoffIso);
    // 超量清理：按时间倒序跳过最新 maxTotal 条，其余（更旧的）视为超量待删
    const overflow = db
      .prepare("SELECT * FROM reports ORDER BY created_at DESC LIMIT -1 OFFSET ?")
      .all(Math.max(0, Math.floor(maxTotal)));
    const toDelete = new Map();
    for (const row of [...expired, ...overflow]) toDelete.set(row.report_id, row);
    if (toDelete.size === 0) return [];
    const del = db.prepare("DELETE FROM reports WHERE report_id = ?");
    for (const row of toDelete.values()) {
      del.run(row.report_id);
      removed.push({ reportId: row.report_id, pathMd: row.path_md, pathHtml: row.path_html });
    }
    return removed;
  } catch (error) {
    noteDbError("pruneReports", error);
    return removed;
  }
}

// 历史留存清理：给「只增不减」的历史表加与报告一致的「保留天数 + 上限（保留最新）」策略，
// 防 evaluator.db 长期运行下把卷吃满。按各表的时间列判过期，按自增 id 判超量。
// 表名/列名/上限均为下方硬编码常量（非用户输入），可安全内插进 SQL。
const HISTORY_RETENTION = [
  { table: "test_requests", tsColumn: "logged_at", maxTotal: 50000 },
  { table: "test_runs", tsColumn: "logged_at", maxTotal: 10000 },
  { table: "regression_alerts", tsColumn: "created_at", maxTotal: 5000 },
  { table: "model_fingerprints", tsColumn: "created_at", maxTotal: 5000 },
];

export async function pruneHistory({ retentionDays = 90, now, path } = {}) {
  const summary = {};
  try {
    const db = await getDatabase(path);
    if (!db) return summary;
    const cutoffIso = new Date((now ?? Date.now()) - retentionDays * 24 * 3600 * 1000).toISOString();
    for (const { table, tsColumn, maxTotal } of HISTORY_RETENTION) {
      // 过期：时间列早于 cutoff（NULL 时间不动，避免误删刚写入未落时间戳的行）。
      const expired = db.prepare(`DELETE FROM ${table} WHERE ${tsColumn} IS NOT NULL AND ${tsColumn} < ?`).run(cutoffIso).changes;
      // 超量：只保留 id 最大的 maxTotal 条（id 自增即时序），其余更旧的删掉。
      const overflow = db
        .prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY id DESC LIMIT ?)`)
        .run(Math.max(0, Math.floor(maxTotal))).changes;
      summary[table] = expired + overflow;
    }
    return summary;
  } catch (error) {
    noteDbError("pruneHistory", error);
    return summary;
  }
}

// 记账：评测完成后由 persistTestRun（test-runner.mjs）写入预估 + 真实成本（按 run_by）。
// 供累计花费汇总 querySpendSummary 读取。
export async function recordSpend(entry, { path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return false;
    db.prepare(`
      INSERT INTO spend_ledger (run_by, run_id, estimated, actual, currency, created_at)
      VALUES (?,?,?,?,?,?)
    `).run(
      entry.runBy ?? currentRunBy(),
      entry.runId ?? null,
      toReal(entry.estimated),
      toReal(entry.actual),
      entry.currency ?? null,
      entry.createdAt ?? null,
    );
    return true;
  } catch (error) {
    noteDbError("recordSpend", error);
    return false;
  }
}

// —— 模型指纹库（持续复测 + 横向对照）——
// 每次准入跑完落一条快照：标称/自述家族、标称一致性、tokenizer 信号（固定探针的
// prompt_tokens）、指纹探针通过情况。用于"本次 vs 上次"(防偷换) 与"同模型多渠道"对照。
export async function recordModelFingerprint(snapshot, { path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return false;
    db.prepare(`
      INSERT INTO model_fingerprints
        (profile_id, model, declared_family, reported_family, identity_status, protocol, tokenizer_signature, probe_signature, run_id, created_at, raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      String(snapshot.profileId || ""),
      String(snapshot.model || ""),
      snapshot.declaredFamily || null,
      snapshot.reportedFamily || null,
      snapshot.identityStatus || null,
      snapshot.protocol || null,
      JSON.stringify(snapshot.tokenizerSignature || {}),
      JSON.stringify(snapshot.probeSignature || {}),
      snapshot.runId || null,
      snapshot.createdAt || null,
      JSON.stringify(snapshot),
    );
    return true;
  } catch (error) {
    noteDbError("recordModelFingerprint", error);
    return false;
  }
}

// 该渠道最近一条指纹快照（可排除当前 run，用于"本次 vs 上次"对照）。
export async function queryLatestFingerprint(profileId, { excludeRunId, path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return null;
    const rows = db
      .prepare("SELECT raw_json, run_id FROM model_fingerprints WHERE profile_id = ? ORDER BY id DESC LIMIT 5")
      .all(String(profileId || ""));
    for (const row of rows) {
      if (excludeRunId && row.run_id === excludeRunId) continue;
      return safeParse(row.raw_json);
    }
    return null;
  } catch (error) {
    noteDbError("queryLatestFingerprint", error);
    return null;
  }
}

// 同一 model 下其它渠道的最近指纹快照（每渠道取最新一条），用于横向对照/数据驱动标定。
export async function queryFingerprintsByModel(model, { excludeProfileId, path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return [];
    const rows = db
      .prepare("SELECT raw_json, profile_id FROM model_fingerprints WHERE model = ? ORDER BY id DESC LIMIT 200")
      .all(String(model || ""));
    const latestByProfile = new Map();
    for (const row of rows) {
      if (excludeProfileId && row.profile_id === excludeProfileId) continue;
      if (!latestByProfile.has(row.profile_id)) latestByProfile.set(row.profile_id, safeParse(row.raw_json));
    }
    return [...latestByProfile.values()].filter(Boolean);
  } catch (error) {
    noteDbError("queryFingerprintsByModel", error);
    return [];
  }
}

// 累计测试消耗汇总（成本可观测：这段时间/某人一共在测试上花了多少）。
export async function querySpendSummary({ runBy, sinceMs, path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return null;
    const conds = [];
    const params = [];
    if (runBy) {
      conds.push("run_by = ?");
      params.push(runBy);
    }
    if (Number.isFinite(Number(sinceMs))) {
      conds.push("created_at IS NOT NULL AND created_at >= ?");
      params.push(new Date(Number(sinceMs)).toISOString());
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const row = db
      .prepare(
        `SELECT COUNT(*) AS runs,
                SUM(CASE WHEN actual IS NOT NULL THEN actual ELSE 0 END) AS total_actual,
                SUM(CASE WHEN estimated IS NOT NULL THEN estimated ELSE 0 END) AS total_estimated
         FROM spend_ledger ${where}`,
      )
      .get(...params);
    return {
      runs: row?.runs || 0,
      totalActualCost: row?.total_actual ?? 0,
      totalEstimatedCost: row?.total_estimated ?? 0,
      currency: "USD",
    };
  } catch (error) {
    noteDbError("querySpendSummary", error);
    return null;
  }
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// test_runs.raw_json 只需汇总级字段；reportMarkdown / 顶层 records / cases 可达数 MB，
// 逐请求明细已在 test_requests 表，这里剥掉只留计数，避免单行膨胀拖慢 queryRecentTestRuns。
// results（场景/批量的每渠道汇总）要保留：报告中心卡片/排行榜靠它取 successRate、
// avgQualityScore 等——但剥掉每个 result 内部的逐请求 records（大头），只留汇总级字段。
function slimSummaryForStorage(summary) {
  if (!summary || typeof summary !== "object") return summary;
  const { reportMarkdown, records, results, cases, ...rest } = summary;
  if (Array.isArray(records)) rest.recordCount = records.length;
  if (Array.isArray(cases)) rest.caseCount = rest.caseCount ?? cases.length;
  if (Array.isArray(results)) {
    rest.resultCount = results.length;
    rest.results = results.map((item) => {
      if (!item || typeof item !== "object") return item;
      const { records: _itemRecords, ...keep } = item;
      return keep;
    });
  }
  return rest;
}
