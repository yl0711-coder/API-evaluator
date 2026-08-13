// tests/end-to-end-latency.test.mjs
// ADM-010：端到端耗时（含被重试掉的失败尝试与退避等待）。
//
// 为什么必须独立成文件：server/paths.mjs 在模块加载时就冻结 DATA_DIR，而 db.mjs 静态导入它。
// 给 db.mjs 加 ?case= 查询串只能拿到新的 db 实例，它绑定的仍是那份早已冻结的 paths。
// 见 tests/task-detail.test.mjs 同样的坑。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const MODULE_DATA_DIR = mkdtempSync(join(tmpdir(), "evaluator-e2e-latency-"));
process.env.EVALUATOR_DATA_DIR = MODULE_DATA_DIR;

const { recordRequest, closeDatabase } = await import("../server/db.mjs");

// 旧库补列迁移：先建一个【不含】end_to_end_ms 的 test_requests，再走正常打开路径。
// 这一步是真正有风险的地方——线上库都是旧库，迁移漏了就是写入静默失败（best-effort 吞异常，
// 表现为"新字段永远是空"，而不是报错）。
test("ADM-010: 旧库缺 end_to_end_ms 列时自动补列，写入不静默失败", async () => {
  const sqlite = await import("node:sqlite").catch(() => null);
  if (!sqlite) return; // node:sqlite 不可用的环境跳过（与 db.mjs 的 best-effort 立场一致）

  const dbPath = join(MODULE_DATA_DIR, "legacy.db");
  const legacy = new sqlite.DatabaseSync(dbPath);
  // 刻意只建旧结构（无 end_to_end_ms、无 run_by），模拟升级前的库。
  legacy.exec(`CREATE TABLE test_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT, run_id TEXT, case_id TEXT, profile_id TEXT, profile_name TEXT,
    profile_role TEXT, provider TEXT, model TEXT, protocol TEXT, started_at TEXT,
    first_byte_ms INTEGER, first_token_ms INTEGER, total_ms INTEGER, status_code INTEGER,
    success INTEGER, normalized_error TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cache_creation_tokens INTEGER, cache_read_tokens INTEGER, reasoning_tokens INTEGER,
    token_source TEXT, output_chars INTEGER, estimated_tokens INTEGER, token_audit_flag TEXT,
    raw_json TEXT, logged_at TEXT
  )`);
  legacy.exec("INSERT INTO test_requests (request_id, total_ms) VALUES ('old-row', 800)");
  legacy.close();

  const ok = await recordRequest(
    { requestId: "new-row", runId: "r1", totalMs: 800, endToEndMs: 3200, success: true, startedAt: new Date().toISOString() },
    { path: dbPath },
  );
  assert.equal(ok, true, "迁移后写入应成功；若为 false 说明 ALTER 没生效、INSERT 因列不存在被吞掉");

  const verify = new sqlite.DatabaseSync(dbPath);
  const rows = verify.prepare("SELECT request_id, total_ms, end_to_end_ms FROM test_requests ORDER BY id").all();
  verify.close();
  closeDatabase(dbPath);

  // 历史行的新列必须是 NULL（"未记录"），不能被填成 0 —— 0 会被统计当成"零耗时"。
  assert.equal(rows[0].request_id, "old-row");
  assert.equal(rows[0].end_to_end_ms, null);
  // 新行两个口径都在，且端到端 > 单次（含退避）。
  assert.equal(rows[1].total_ms, 800);
  assert.equal(rows[1].end_to_end_ms, 3200);
});

test("ADM-010: total_ms 语义不变——端到端另存一列，不覆盖既有延迟序列", async () => {
  const sqlite = await import("node:sqlite").catch(() => null);
  if (!sqlite) return;

  const dbPath = join(MODULE_DATA_DIR, "semantics.db");
  // 一次就成的请求：两个口径应当一致，趋势图按 total_ms 取点的行为完全不变。
  await recordRequest({ requestId: "clean", totalMs: 500, endToEndMs: 500, success: true }, { path: dbPath });
  // 重试后成功：total_ms 仍只记最后一次（500），端到端含前序失败与退避（2700）。
  // 这正是 ADM-010 要暴露的差——旧实现这两行在库里长得一模一样。
  await recordRequest({ requestId: "retried", totalMs: 500, endToEndMs: 2700, success: true }, { path: dbPath });

  const verify = new sqlite.DatabaseSync(dbPath);
  const rows = verify.prepare("SELECT request_id, total_ms, end_to_end_ms FROM test_requests ORDER BY id").all();
  verify.close();
  closeDatabase(dbPath);

  assert.deepEqual(
    rows.map((r) => r.total_ms),
    [500, 500],
    "total_ms 必须保持「最后一次尝试」语义；若被改成端到端，趋势图与回归判定的历史数据就不可比了",
  );
  assert.deepEqual(
    rows.map((r) => r.end_to_end_ms),
    [500, 2700],
  );
});

test("ADM-010: endToEndMs 缺失时写 NULL，不落 0", async () => {
  const sqlite = await import("node:sqlite").catch(() => null);
  if (!sqlite) return;

  const dbPath = join(MODULE_DATA_DIR, "missing.db");
  // 一次请求都没发出（Key 缺失 / egress 阻断）：端到端无意义。
  // 落 0 会让"从未测到"和"零耗时"在统计里无法区分。
  await recordRequest({ requestId: "never-sent", totalMs: 0, endToEndMs: null, success: false }, { path: dbPath });

  const verify = new sqlite.DatabaseSync(dbPath);
  const row = verify.prepare("SELECT total_ms, end_to_end_ms FROM test_requests").get();
  verify.close();
  closeDatabase(dbPath);

  assert.equal(row.total_ms, 0);
  assert.equal(row.end_to_end_ms, null);
});
