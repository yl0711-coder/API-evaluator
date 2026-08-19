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
  -- 端到端耗时（ADM-010）：含被重试掉的失败尝试与退避等待。total_ms 只是最后一次尝试。
  -- 旧库经 migrateSchema 补列，历史行为 NULL——统计侧必须把 NULL 当「未记录」而非 0。
  end_to_end_ms INTEGER,
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

-- 任务状态落库（ADM-017）。此前任务只活在内存 Map 里，落定 1 小时被逐出、重启即清空，
-- 唯一的持久痕迹是 task-events.jsonl，而那里只读最后 300 行——「上周那次准入到底跑没跑」查不到。
-- 这张表是任务的持久事实来源；JSONL 事件流仍照写（它是逐事件的流水，这张是逐任务的当前态）。
-- owner_user_id 现在只记录不做隔离（见 task-manager 的 createTask 注释与 ADM-016）；
-- 列先建好，将来真要隔离时加 WHERE 即可，不必再迁一次表。
CREATE TABLE IF NOT EXISTS evaluation_tasks (
  task_id TEXT PRIMARY KEY,
  type TEXT,
  status TEXT,
  owner_user_id TEXT,
  cancelled_by TEXT,
  created_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  progress INTEGER,
  completed_units INTEGER,
  total_units INTEGER,
  message TEXT,
  error TEXT,
  error_id TEXT,
  -- 形状摘要，绝不含 key / baseUrl / 提示词正文（同 summarizeTaskPayload 的口径）
  payload_json TEXT,
  result_json TEXT,
  steps_json TEXT,
  timing_json TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON evaluation_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON evaluation_tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON evaluation_tasks(owner_user_id);

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
  configWriteFailures: 0,
  lastError: null,
  warned: false,
};

// 配置目录以 SQLite 为主事实源时，写失败不能伪装成“成功后改写 JSON”。调用方应返回 503，
// 让管理员明确知道配置没有保存；只有运行环境根本不支持 node:sqlite 时才允许走旧 JSON 降级。
export class PersistentStorageWriteError extends Error {
  constructor(scope, cause) {
    super("持久化存储写入失败。");
    this.name = "PersistentStorageWriteError";
    this.scope = scope;
    this.cause = cause;
  }
}

function noteDbError(scope, error) {
  dbHealth.lastError = `${scope}: ${error?.message ? String(error.message) : String(error)}`;
  if (!dbHealth.warned) {
    dbHealth.warned = true;
    console.warn(`[db] SQLite 操作失败（后续失败仅计数不再刷屏）：${dbHealth.lastError}`);
  }
}

// 数据层健康快照（供 support-bundle / 诊断用）。事实源约定：SQLite 可用时为主
// （全量、不截断），JSONL 为兼容镜像/兜底；写失败计数 > 0 表示两者可能已偏离。
export function getDbHealth() {
  return {
    sqliteAvailable: moduleAvailable === true,
    requestWriteFailures: dbHealth.requestWriteFailures,
    runWriteFailures: dbHealth.runWriteFailures,
    configWriteFailures: dbHealth.configWriteFailures,
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

async function getConfigDatabase(scope, path) {
  // 只有“模块根本不可用”这一种状态允许调用方转写 JSON，且这是启动环境能力而非运行中故障。
  if (!(await ensureModule())) return null;
  try {
    const db = await getDatabase(path);
    if (db) return db;
    throw new Error("SQLite 数据库不可用。");
  } catch (error) {
    dbHealth.configWriteFailures += 1;
    noteDbError(scope, error);
    throw new PersistentStorageWriteError(scope, error);
  }
}

function configWriteError(scope, error) {
  if (error instanceof PersistentStorageWriteError) return error;
  dbHealth.configWriteFailures += 1;
  noteDbError(scope, error);
  return new PersistentStorageWriteError(scope, error);
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

// 旧库补列（新库 CREATE 已含这些列；ALTER 对已存在列会抛错，幂等吞掉）。
function migrateSchema(db) {
  for (const table of ["test_requests", "test_runs"]) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN run_by TEXT`);
    } catch {
      // 列已存在
    }
  }
  // ADM-010：端到端耗时。只在 test_requests 上（test_runs 存的是汇总，没有逐请求耗时）。
  try {
    db.exec("ALTER TABLE test_requests ADD COLUMN end_to_end_ms INTEGER");
  } catch {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE evaluation_tasks ADD COLUMN timing_json TEXT");
  } catch {
    // column already exists
  }
  // 补列必须先于回填：回填读 raw_json 写 profile_id，与上面的 ALTER 无依赖，
  // 但放在最后可保证任何新增补列都已就位。
  backfillRunProfileIds(db);
}

// 历史回填：场景运行曾因 summary 顶层无 profileId 而把 test_runs.profile_id 写成 NULL
// （写入侧已在 runScenarioTest 补齐，但老行仍是 NULL），导致按模型查趋势拿不到场景历史。
// raw_json 里保留了 results[].profileId / profileDigest[].profileId，据此原地补列。
//
// 严格限定 type='scenario'：batch-stability / batch-admission 的 profile_id 同样是 NULL，
// 但那是**按设计**的聚合行（顶层无 successRate）。若把只含一个模型的批量行也认领过来，
// 它会作为最新点进入趋势 series，把该 type 的回归判定从 stable 打回 baseline——
// 即凭空改变既有渠道的退化结论。已实测复现，故不碰非场景行。
// 只回填唯一 profileId 的行；多模型场景聚合行无从归属，保持 NULL 更诚实。
// 幂等（WHERE profile_id IS NULL）、best-effort（失败不阻塞开库）。
function backfillRunProfileIds(db) {
  try {
    const rows = db
      .prepare("SELECT id, raw_json FROM test_runs WHERE profile_id IS NULL AND raw_json IS NOT NULL AND type = 'scenario'")
      .all();
    if (!rows.length) return;
    const update = db.prepare("UPDATE test_runs SET profile_id = ?, profile_name = COALESCE(profile_name, ?) WHERE id = ?");
    let filled = 0;
    for (const row of rows) {
      const parsed = safeParse(row.raw_json);
      if (!parsed) continue;
      // 候选来源按可靠性排序；两者都是「每模型一条」的数组。
      const list = Array.isArray(parsed.results) && parsed.results.length ? parsed.results : parsed.profileDigest;
      if (!Array.isArray(list)) continue;
      const ids = [...new Set(list.map((item) => item?.profileId).filter(Boolean))];
      if (ids.length !== 1) continue; // 0 个无从判断；>1 个是聚合行，不归属
      const owner = list.find((item) => item?.profileId === ids[0]);
      update.run(ids[0], owner?.profileName ?? null, row.id);
      filled += 1;
    }
    if (filled) console.warn(`[db] 回填 test_runs.profile_id：${filled}/${rows.length} 行（场景运行历史趋势修复）`);
  } catch (error) {
    noteDbError("backfillRunProfileIds", error);
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
  if (value == null) return null; // null/undefined → null (not 0, since Number(null)=0)
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
};
// toInt 把 null 变成 0（`Number(null) === 0`），对"未测到"的字段是错的：
// 落 0 之后统计无法区分「从未测到」与「真的零耗时」。既有列沿用 toInt 不动
// （改它会连带影响 token 各列，那里 null/0 的差别另有含义，属另一档改动），
// 新增的可空数值列一律走这个。
const toIntOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
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
        total_ms, end_to_end_ms, status_code, success, normalized_error, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, reasoning_tokens, token_source,
        output_chars, estimated_tokens, token_audit_flag, raw_json, logged_at, run_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      toIntOrNull(record.endToEndMs),
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

// —— 任务状态落库（ADM-017）——
//
// 任务在生命周期里会被写多次（queued → started → 若干次进度 → 终态），故按 task_id upsert
// 而非 insert。全部 best-effort：任何异常都吞掉、返回 false，绝不影响正在跑的测试——
// 落库是可观测性，不是主链路，SQLite 不可用时 JSONL 事件流仍然工作。
//
// 刻意【不】在每次进度更新时写：一个 27 用例的任务会推进几十次，每次都 upsert 是无谓的写放大。
// 调用方只在状态跃迁（建/终态/取消请求）时落库，进度靠内存态 + 轮询即可（见 task-manager）。
export async function recordEvaluationTask(task, { path } = {}) {
  try {
    if (!task?.id) return false;
    const db = await getDatabase(path);
    if (!db) return false;
    const stmt = db.prepare(`
      INSERT INTO evaluation_tasks (
        task_id, type, status, owner_user_id, cancelled_by, created_at, started_at, ended_at,
        progress, completed_units, total_units, message, error, error_id,
        payload_json, result_json, steps_json, timing_json, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET
        status = excluded.status,
        cancelled_by = excluded.cancelled_by,
        started_at = COALESCE(excluded.started_at, evaluation_tasks.started_at),
        ended_at = COALESCE(excluded.ended_at, evaluation_tasks.ended_at),
        progress = excluded.progress,
        completed_units = excluded.completed_units,
        total_units = excluded.total_units,
        message = excluded.message,
        error = excluded.error,
        error_id = excluded.error_id,
        -- payload 只在建任务时写一次，后续更新不带它（同事件流口径）；用 COALESCE 保住首次那份，
        -- 否则终态 upsert 会把「再测一次」要用的参数摘要覆盖成 NULL。
        payload_json = COALESCE(excluded.payload_json, evaluation_tasks.payload_json),
        result_json = COALESCE(excluded.result_json, evaluation_tasks.result_json),
        steps_json = COALESCE(excluded.steps_json, evaluation_tasks.steps_json),
        timing_json = COALESCE(excluded.timing_json, evaluation_tasks.timing_json),
        updated_at = excluded.updated_at
    `);
    stmt.run(
      task.id,
      task.type ?? null,
      task.status ?? null,
      task.createdBy ?? null,
      task.cancelledBy ?? null,
      task.createdAt ?? null,
      task.startedAt ?? null,
      task.endedAt ?? null,
      toInt(task.progress),
      toInt(task.completedUnits),
      toInt(task.totalUnits),
      task.message ?? null,
      task.error ?? null,
      task.errorId || null,
      task.payload ? JSON.stringify(task.payload) : null,
      task.result ? JSON.stringify(task.result) : null,
      Array.isArray(task.steps) && task.steps.length ? JSON.stringify(task.steps) : null,
      task.timing ? JSON.stringify(task.timing) : null,
      new Date().toISOString(),
    );
    return true;
  } catch (error) {
    noteDbError("recordEvaluationTask", error);
    return false;
  }
}

// 最近任务列表。刻意【不返回 steps_json】：一屏 30 个任务 × 每个最多 20 步足以把响应撑到几百 KB，
// 而列表只画聚合状态（同 readRecentTasks 的既有立场）。逐步骤明细走 queryEvaluationTask。
export async function queryRecentEvaluationTasks(limit = 30, { path } = {}) {
  const db = await getDatabase(path);
  if (!db) return null;
  const rows = db
    .prepare(`
      SELECT task_id, type, status, owner_user_id, cancelled_by, created_at, started_at, ended_at,
             progress, completed_units, total_units, message, error, error_id, payload_json, result_json, timing_json
      FROM evaluation_tasks ORDER BY created_at DESC, rowid DESC LIMIT ?
    `)
    .all(Math.max(1, Math.floor(limit)));
  return rows.map((row) => taskRowToPublic(row));
}

export async function queryEvaluationTask(taskId, { path } = {}) {
  if (!taskId) return null;
  const db = await getDatabase(path);
  if (!db) return null;
  const row = db.prepare("SELECT * FROM evaluation_tasks WHERE task_id = ?").get(String(taskId));
  return row ? taskRowToPublic(row, { withSteps: true }) : null;
}

// 库里的列名是 snake_case，前端契约是 camelCase（且任务中心用 taskId 而非 id 作主键字段名，
// 与事件流折叠出来的对象保持一致——两条数据源必须长得一样，否则前端得分两套渲染）。
function taskRowToPublic(row, { withSteps = false } = {}) {
  return {
    taskId: row.task_id,
    type: row.type,
    status: row.status,
    createdBy: row.owner_user_id ?? null,
    cancelledBy: row.cancelled_by ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    progress: row.progress ?? 0,
    completedUnits: row.completed_units ?? 0,
    totalUnits: row.total_units ?? 0,
    message: row.message ?? "",
    error: row.error ?? null,
    errorId: row.error_id ?? "",
    payload: safeParse(row.payload_json),
    result: safeParse(row.result_json),
    timing: safeParse(row.timing_json),
    ...(withSteps ? { steps: safeParse(row.steps_json) ?? undefined } : {}),
    // 落库来源的任务一律不可恢复：进程重启后内存里没有它的 abortController，取消不了、也不会自己推进。
    recoverable: false,
    // 事件流那条路径会给 event 字段；这里补一个等价物，前端两条路径同构。
    event: row.status,
  };
}

// 进程启动时把上次残留的 running/queued 任务改判 interrupted。
// 不做这件事，重启后列表里会永远挂着一批「运行中」——它们不可能再推进（进程都换了），
// 而前端会对着它们无限轮询。返回被改判的条数，供启动日志与测试断言。
export async function markInterruptedEvaluationTasks({ path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return 0;
    const stmt = db.prepare(`
      UPDATE evaluation_tasks
      SET status = 'interrupted',
          message = '程序曾在任务运行中退出，任务已中断，需要重新测试。',
          ended_at = COALESCE(ended_at, ?),
          updated_at = ?
      WHERE status IN ('running', 'queued')
    `);
    const now = new Date().toISOString();
    const info = stmt.run(now, now);
    return Number(info?.changes ?? 0);
  } catch (error) {
    noteDbError("markInterruptedEvaluationTasks", error);
    return 0;
  }
}

// 按 run_id 全量读取逐请求记录（统计严谨需要完整历史，不截断）。
export async function queryRequestsByRun(runId, { path } = {}) {
  const db = await getDatabase(path);
  if (!db) return [];
  return db.prepare("SELECT * FROM test_requests WHERE run_id = ? ORDER BY id ASC").all(runId);
}

// 指定若干 run 的逐轮明细（时间升序），供稳定性趋势按「每轮 1 点」加密 / 按小时聚合。
// 只取有耗时的行；用 run_id IN(...) 把趋势限定到这些运行（调用方传稳定性运行 + 基础场景运行的 runId）。
// 附带 caseId（=场景 id），供基础场景运行按分组过滤逐轮明细；稳定性运行忽略该字段即可。
export async function queryRoundSeriesByRunIds(runIds, { limit = 4000, path } = {}) {
  const ids = (runIds || []).filter(Boolean);
  if (!ids.length) return [];
  const db = await getDatabase(path);
  if (!db) return [];
  const placeholders = ids.map(() => "?").join(",");
  // 超过 limit 时保留【最新】的若干轮，而非最旧的（P2-5）：趋势图/回归判定都以最新点为准，
  // 旧写法 `ORDER BY id ASC LIMIT` 砍掉的恰是 id 最大=最新的轮次，会静默丢最近数据。
  // 故先按 id DESC 取最新 limit 条，再 reverse 回升序，交给下游按时间正序消费。
  const rows = db
    .prepare(
      `SELECT started_at, total_ms, success, normalized_error, run_id, case_id
       FROM test_requests
       WHERE run_id IN (${placeholders}) AND total_ms IS NOT NULL
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...ids, Math.max(1, Math.floor(limit)))
    .reverse();
  return rows.map((r) => ({
    startedAt: r.started_at || null,
    totalMs: Number(r.total_ms),
    success: r.success ? 1 : 0,
    normalizedError: r.normalized_error || "", // 区分超时(timeout)与其它失败，供趋势图底部标注
    runId: r.run_id || null,
    caseId: r.case_id || null, // 场景 id（场景运行才有），供基础分组过滤
  }));
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
  const rows = db.prepare("SELECT raw_json FROM test_requests ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.floor(limit)));
  return rows.map((row) => safeParse(row.raw_json)).filter(Boolean);
}

export async function queryRecentTestRuns(limit = 20, { path } = {}) {
  const db = await getDatabase(path);
  if (!db) return null;
  const rows = db.prepare("SELECT raw_json FROM test_runs ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.floor(limit)));
  return rows.map((row) => safeParse(row.raw_json)).filter(Boolean);
}

// 同一 profile 的历次运行（重测信度 / 跨运行对比用）。
export async function queryRunsByProfile(profileId, { path } = {}) {
  const db = await getDatabase(path);
  if (!db) return [];
  return db.prepare("SELECT * FROM test_runs WHERE profile_id = ? ORDER BY id ASC").all(profileId);
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

// 每个模型目标(=profile_id)的最后一次测试时间（覆盖所有测试种类：准入/快速/稳定/场景/批量）。
// 用 test_requests（逐请求、按 profile_id 建索引）聚合 MAX(logged_at)。logged_at 为 ISO 文本，
// MAX 按字典序即时间序。DB 不可用/无记录 → {}。供「模型管理」卡片显示「上次测试」+ 判定「需测」。
export async function queryLastTestedByProfile({ path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return {};
    const rows = db
      .prepare("SELECT profile_id, MAX(logged_at) AS last FROM test_requests WHERE profile_id IS NOT NULL GROUP BY profile_id")
      .all();
    const out = {};
    for (const r of rows) if (r.profile_id && r.last) out[r.profile_id] = r.last;
    return out;
  } catch (error) {
    noteDbError("queryLastTestedByProfile", error);
    return {};
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
  const db = await getConfigDatabase("saveModelConfigs", path);
  // 仅 Node 运行环境完全没有 SQLite 支持时才让上层显式降级 JSON。
  if (!db) return false;
  try {
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
    throw configWriteError("saveModelConfigs", error);
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
  const db = await getConfigDatabase("saveChannels", path);
  if (!db) return false;
  try {
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
    throw configWriteError("saveChannels", error);
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
  const db = await getConfigDatabase("saveModelTargets", path);
  if (!db) return false;
  try {
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
    throw configWriteError("saveModelTargets", error);
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

// 按报告文件名（不含 .md）批量取当初生成该报告的结构化 summary（test_runs.raw_json）。
// 用途：模型对比不必再从渲染后的 markdown 表格里反解析数字——那些数字本来就以原生数值存在库里。
// 见 report-compare.scenarioDataFromSummary 与 B2 的分析。
//
// 匹配方式：reports.path_md 存的是绝对路径，这里按「文件名去扩展名」比对，与调用方手里的
// base name 对齐（调用方是从报告目录 readdir 来的，只有文件名）。
// 任何一环缺失（无库/无记录/无 raw_json/JSON 坏）→ 该 base 不出现在返回 Map 里，
// 调用方据此回退到解析 markdown。绝不抛错：对比功能不该因为库的问题而整个挂掉。
export async function queryReportSummariesByBase(baseNames, { path } = {}) {
  const out = new Map();
  const names = [...new Set((baseNames || []).map((n) => String(n)).filter(Boolean))];
  if (!names.length) return out;
  try {
    const db = await getDatabase(path);
    if (!db) return out;
    // 一次查全部报告的 (path_md, run_id)，在 JS 侧按 base name 匹配。
    // 不用 SQL 拼 IN (…)：报告名含中文与特殊字符，且这里量级只有几百行，JS 侧过滤更稳。
    const wanted = new Set(names);
    const rows = db.prepare("SELECT path_md, run_id FROM reports WHERE path_md IS NOT NULL AND run_id IS NOT NULL").all();
    const runIdByBase = new Map();
    for (const r of rows) {
      const base = String(r.path_md)
        .split(/[\\/]/)
        .pop()
        .replace(/\.(md|html)$/i, "");
      if (wanted.has(base)) runIdByBase.set(base, r.run_id);
    }
    if (!runIdByBase.size) return out;
    const stmt = db.prepare("SELECT raw_json FROM test_runs WHERE run_id = ? LIMIT 1");
    for (const [base, runId] of runIdByBase) {
      try {
        const row = stmt.get(runId);
        if (!row?.raw_json) continue;
        out.set(base, JSON.parse(row.raw_json));
      } catch {
        /* 单条坏掉不影响其余：该 base 缺席 → 调用方回退解析 md */
      }
    }
  } catch (error) {
    noteDbError("queryReportSummariesByBase", error);
  }
  return out;
}

// 删除单条报告元数据（供报告中心手动删除报告文件用）。文件删除交调用方做，db 只管元数据。
// SQLite 不可用 → no-op 返回 false；返回是否确有一行被删。
export async function deleteReport(reportId, { path } = {}) {
  try {
    const db = await getDatabase(path);
    if (!db) return false;
    const info = db.prepare("DELETE FROM reports WHERE report_id = ?").run(String(reportId));
    return info.changes > 0;
  } catch (error) {
    noteDbError("deleteReport", error);
    return false;
  }
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
    const overflow = db.prepare("SELECT * FROM reports ORDER BY created_at DESC LIMIT -1 OFFSET ?").all(Math.max(0, Math.floor(maxTotal)));
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
