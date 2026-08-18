import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  closeDatabase,
  countRequests,
  deleteReport,
  getDatabase,
  getDbHealth,
  importRequestsFromJsonl,
  isSqliteAvailable,
  queryLastTestedByProfile,
  queryProfileRunSummaries,
  queryRecentReports,
  queryRecentRequests,
  queryRecentTestRuns,
  queryRequestsByRun,
  queryRoundSeriesByRunIds,
  queryRunsByProfile,
  recordReport,
  recordRequest,
  recordTestRun,
} from "../server/db.mjs";

test("getDbHealth reports a diagnosable snapshot", async () => {
  await isSqliteAvailable(); // 触发模块探测
  const health = getDbHealth();
  assert.equal(typeof health.sqliteAvailable, "boolean");
  assert.equal(typeof health.requestWriteFailures, "number");
  assert.equal(typeof health.runWriteFailures, "number");
  assert.ok("lastError" in health);
});

const makeRecord = (overrides = {}) => ({
  requestId: "req-1",
  runId: "run-1",
  caseId: "",
  profileId: "p1",
  profileName: "甲",
  profileRole: "target",
  provider: "mock",
  model: "mock-model",
  protocol: "openai_compatible",
  startedAt: "2026-06-02T00:00:00Z",
  firstByteMs: 120,
  firstTokenMs: 120,
  totalMs: 1500,
  statusCode: 200,
  success: true,
  normalizedError: null,
  inputTokens: 50,
  outputTokens: 30,
  cacheCreationTokens: null,
  cacheReadTokens: 10,
  reasoningTokens: null,
  tokenSource: "upstream",
  outputChars: 200,
  loggedAt: "2026-06-02T00:00:01Z",
  ...overrides,
});

test("node:sqlite is available on this runtime", async () => {
  // CI/打包用 Node 24 自带 node:sqlite；若这里为 false 说明运行环境过旧，
  // 数据层会降级为 JSONL-only（仍可用，但统计完整历史受限）。
  assert.equal(await isSqliteAvailable(), true);
});

test("recordRequest persists a row and queryRequestsByRun reads it back in full", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "test.db");
  try {
    assert.equal(await recordRequest(makeRecord({ requestId: "a" }), { path }), true);
    assert.equal(await recordRequest(makeRecord({ requestId: "b", success: false, normalizedError: "timeout" }), { path }), true);
    assert.equal(await recordRequest(makeRecord({ requestId: "c", runId: "run-2" }), { path }), true);

    const run1 = await queryRequestsByRun("run-1", { path });
    assert.equal(run1.length, 2);
    assert.equal(run1[0].request_id, "a");
    assert.equal(run1[0].success, 1);
    assert.equal(run1[1].success, 0);
    assert.equal(run1[1].normalized_error, "timeout");
    assert.equal(run1[0].cache_read_tokens, 10);

    assert.equal(await countRequests({ path }), 3);
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("full history is retained beyond the old JSONL tail window (no truncation)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "history.db");
  try {
    for (let i = 0; i < 500; i++) {
      await recordRequest(makeRecord({ requestId: `r${i}`, runId: "big" }), { path });
    }
    assert.equal(await countRequests({ path }), 500);
    assert.equal((await queryRequestsByRun("big", { path })).length, 500);
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordTestRun stores summary with CI columns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "runs.db");
  try {
    const ok = await recordTestRun(
      {
        runId: "run-1",
        profileId: "p1",
        profileName: "甲",
        rounds: 10,
        successCount: 8,
        successRate: 0.8,
        successRateCi: { ci95Lower: 0.49, ci95Upper: 0.94, method: "wilson" },
        startedAt: "2026-06-02T00:00:00Z",
        endedAt: "2026-06-02T00:01:00Z",
      },
      { type: "stability", path },
    );
    assert.equal(ok, true);
    const db = await getDatabase(path);
    const row = db.prepare("SELECT * FROM test_runs WHERE run_id = ?").get("run-1");
    assert.equal(row.type, "stability");
    assert.equal(row.sample_size, 10);
    assert.equal(row.success_count, 8);
    assert.equal(row.ci_lower, 0.49);
    assert.equal(row.statistical_method, "wilson");
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordTestRun slims heavy nested fields out of raw_json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "slim.db");
  try {
    await recordTestRun(
      {
        runId: "run-heavy",
        profileId: "p1",
        profileName: "甲",
        successRate: 1,
        reportMarkdown: "# huge\n".repeat(1000),
        records: Array.from({ length: 50 }, (_, i) => ({ requestId: `r${i}`, responseText: "x".repeat(500) })),
        results: [{ a: 1 }, { a: 2 }],
      },
      { type: "scenario", path },
    );
    const recent = await queryRecentTestRuns(5, { path });
    const stored = recent.find((r) => r.runId === "run-heavy");
    assert.ok(stored, "应能读回该运行");
    assert.equal(stored.reportMarkdown, undefined, "reportMarkdown 应被剥离");
    assert.equal(stored.records, undefined, "records 应被剥离");
    assert.equal(stored.recordCount, 50, "保留计数");
    assert.equal(stored.resultCount, 2);
    assert.equal(stored.successRate, 1, "汇总字段保留");
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("importRequestsFromJsonl backfills history from JSONL lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "import.db");
  try {
    const lines = [
      JSON.stringify(makeRecord({ requestId: "x1", runId: "imp" })),
      JSON.stringify(makeRecord({ requestId: "x2", runId: "imp" })),
      "not-json-should-skip",
    ];
    const imported = await importRequestsFromJsonl(lines, { path });
    assert.equal(imported, 2);
    assert.equal(await countRequests({ path }), 2);
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("queryRecentRequests returns newest-first records in original (raw_json) shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "recent.db");
  try {
    for (const id of ["a", "b", "c"]) {
      await recordRequest(makeRecord({ requestId: id }), { path });
    }
    const recent = await queryRecentRequests(2, { path });
    assert.equal(recent.length, 2);
    assert.equal(recent[0].requestId, "c"); // newest first
    assert.equal(recent[1].requestId, "b");
    // 还原成原始记录形状（camelCase），不是 sqlite 列名
    assert.equal(recent[0].profileName, "甲");
    assert.equal(recent[0].totalMs, 1500);
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("queryRecentTestRuns and queryRunsByProfile read back runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "runs2.db");
  try {
    await recordTestRun(
      { runId: "r1", profileId: "p1", profileName: "甲", rounds: 5, successCount: 5, successRate: 1 },
      { type: "stability", path },
    );
    await recordTestRun(
      { runId: "r2", profileId: "p1", profileName: "甲", rounds: 5, successCount: 3, successRate: 0.6 },
      { type: "stability", path },
    );
    await recordTestRun(
      { runId: "r3", profileId: "p2", profileName: "乙", rounds: 5, successCount: 4, successRate: 0.8 },
      { type: "stability", path },
    );

    const recent = await queryRecentTestRuns(10, { path });
    assert.equal(recent.length, 3);
    assert.equal(recent[0].runId, "r3"); // newest first

    const p1Runs = await queryRunsByProfile("p1", { path });
    assert.equal(p1Runs.length, 2); // 重测信度可用：同 profile 的历次运行
    assert.equal(p1Runs[0].run_id, "r1");
    assert.equal(p1Runs[1].run_id, "r2");
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

// 根因护栏：summary 顶层缺 profileId → profile_id 写成 NULL → 按 profile 查趋势查不到。
// 这是 2026-08-12 发现的场景测试趋势缺失的成因；runScenarioTest 已在写库前显式补顶层 profileId。
test("recordTestRun：summary 顶层无 profileId 时 profile_id 落 NULL，按 profile 查不到（故写库前必须补）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "null-profile.db");
  try {
    // 模拟 buildScenarioSummary 的形状：profileId 只在 results[]/profileDigest[] 里，顶层没有。
    await recordTestRun(
      {
        runId: "scene-noprofile",
        type: "scenario",
        successRate: 0.9,
        endedAt: "2026-08-10T10:00:00Z",
        profileDigest: [{ profileId: "p1", profileName: "渠道A" }],
        results: [{ profileId: "p1", profileName: "渠道A" }],
      },
      { type: "scenario", path },
    );
    const db = await getDatabase(path);
    const row = db.prepare("SELECT profile_id FROM test_runs WHERE run_id = ?").get("scene-noprofile");
    assert.equal(row.profile_id, null, "顶层没有 profileId → 列为 NULL（嵌套里的不会被自动提取）");
    assert.equal((await queryProfileRunSummaries("p1", { path })).length, 0, "故按 profile 查趋势拿不到这条");
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("开库迁移：回填历史 NULL 的 profile_id（单模型行补齐、聚合行保持 NULL、幂等）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "backfill.db");
  try {
    // 先造出「老库」的样子：三条 profile_id 为 NULL 的场景行。
    const db = await getDatabase(path);
    const insert = db.prepare("INSERT INTO test_runs (run_id, type, profile_id, raw_json) VALUES (?,?,NULL,?)");
    // ① 单模型：results[] 里唯一 profileId → 应回填
    insert.run("old-single", "scenario", JSON.stringify({ runId: "old-single", results: [{ profileId: "p1", profileName: "渠道A" }] }));
    // ② 多模型聚合：两个不同 profileId → 不归属，保持 NULL
    insert.run("old-agg", "scenario", JSON.stringify({ runId: "old-agg", results: [{ profileId: "p1" }, { profileId: "p2" }] }));
    // ③ 只有 profileDigest（results 被剥空）→ 走兜底来源回填
    insert.run(
      "old-digest",
      "scenario",
      JSON.stringify({ runId: "old-digest", profileDigest: [{ profileId: "p3", profileName: "渠道C" }] }),
    );
    // ④ 单模型的 batch-stability：profile_id 同样是 NULL，但那是**按设计**的聚合行。
    // 绝不能认领——否则它会作为最新点进趋势 series，把该 type 的回归判定从 stable 打回
    // baseline（顶层无 successRate），凭空改变既有渠道的退化结论。故回填严格限定 scenario。
    insert.run(
      "old-batch",
      "batch-stability",
      JSON.stringify({ batchId: "old-batch", profileCount: 1, results: [{ profileId: "p9", profileName: "渠道Z" }] }),
    );
    closeDatabase(path);

    // 重新开库 → migrateSchema 触发回填
    const reopened = await getDatabase(path);
    const get = (runId) => reopened.prepare("SELECT profile_id, profile_name FROM test_runs WHERE run_id = ?").get(runId);
    assert.equal(get("old-single").profile_id, "p1", "单模型行按 results[0].profileId 回填");
    assert.equal(get("old-single").profile_name, "渠道A", "顺带补 profile_name");
    assert.equal(get("old-agg").profile_id, null, "多模型聚合行不归属任一 profile，保持 NULL");
    assert.equal(get("old-digest").profile_id, "p3", "results 缺失时用 profileDigest 兜底");
    assert.equal(get("old-batch").profile_id, null, "非 scenario 的聚合行绝不认领（否则改变既有退化判定）");
    assert.equal((await queryProfileRunSummaries("p9", { path })).length, 0, "batch 行不该因回填出现在按模型的趋势里");

    // 回填后即可按 profile 查到历史（这正是趋势页需要的）
    assert.equal((await queryProfileRunSummaries("p1", { path })).length, 1);
    assert.equal((await queryProfileRunSummaries("p3", { path })).length, 1);

    // 幂等：再开一次不报错、结果不变（第二次回填的候选集为空）
    closeDatabase(path);
    const again = await getDatabase(path);
    assert.equal(again.prepare("SELECT profile_id FROM test_runs WHERE run_id = ?").get("old-single").profile_id, "p1");
    assert.equal(again.prepare("SELECT profile_id FROM test_runs WHERE run_id = ?").get("old-agg").profile_id, null);
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("queryProfileRunSummaries：按 profile_id 查询历史运行（场景/稳定性测试均可查到）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "profile-summaries.db");
  try {
    // 写入两条 stability + 一条 scenario，前两条同 profileId
    await recordTestRun(
      { runId: "stab-1", profileId: "p1", profileName: "甲", type: "stability", successRate: 0.95, endedAt: "2026-08-01T10:00:00Z" },
      { type: "stability", path },
    );
    await recordTestRun(
      { runId: "scene-1", profileId: "p1", profileName: "甲", type: "scenario", successRate: 0.88, endedAt: "2026-08-02T10:00:00Z" },
      { type: "scenario", path },
    );
    await recordTestRun(
      { runId: "stab-2", profileId: "p2", profileName: "乙", type: "stability", successRate: 0.92, endedAt: "2026-08-03T10:00:00Z" },
      { type: "stability", path },
    );

    const p1Summaries = await queryProfileRunSummaries("p1", { path });
    assert.equal(p1Summaries.length, 2, "p1 应返回 2 条（1 稳定性 + 1 场景）");
    assert.ok(p1Summaries.some((s) => s.runId === "stab-1" && s.type === "stability"));
    assert.ok(p1Summaries.some((s) => s.runId === "scene-1" && s.type === "scenario"));

    const p2Summaries = await queryProfileRunSummaries("p2", { path });
    assert.equal(p2Summaries.length, 1, "p2 应返回 1 条");
    assert.equal(p2Summaries[0].runId, "stab-2");
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("queryLastTestedByProfile：按 profile 取 MAX(logged_at)，多 profile 分别返回；无记录/无库 → {}", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "lasttest.db");
  try {
    // 空库 → 空对象
    assert.deepEqual(await queryLastTestedByProfile({ path }), {});
    // p1 两次（后者更晚，应胜出）、p2 一次
    await recordRequest(makeRecord({ requestId: "p1a", profileId: "p1", loggedAt: "2026-06-01T00:00:00Z" }), { path });
    await recordRequest(makeRecord({ requestId: "p1b", profileId: "p1", loggedAt: "2026-06-20T09:00:00Z" }), { path });
    await recordRequest(makeRecord({ requestId: "p2a", profileId: "p2", loggedAt: "2026-06-10T00:00:00Z" }), { path });
    const map = await queryLastTestedByProfile({ path });
    assert.equal(map.p1, "2026-06-20T09:00:00Z", "p1 取最新一次");
    assert.equal(map.p2, "2026-06-10T00:00:00Z");
    assert.equal(Object.keys(map).length, 2);
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("queryRoundSeriesByRunIds：按 run_id 集合取逐轮明细（升序、限定运行、跳过无耗时、空集合→[]）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "rounds.db");
  try {
    await recordRequest(
      makeRecord({ requestId: "a", runId: "runA", caseId: "case-1", totalMs: 1000, success: true, startedAt: "2026-06-02T00:00:00Z" }),
      { path },
    );
    await recordRequest(
      makeRecord({ requestId: "b", runId: "runA", caseId: "case-2", totalMs: 2000, success: false, startedAt: "2026-06-02T00:00:01Z" }),
      { path },
    );
    await recordRequest(makeRecord({ requestId: "c", runId: "runB", totalMs: 1500, success: true, startedAt: "2026-06-02T00:00:02Z" }), {
      path,
    });
    await recordRequest(makeRecord({ requestId: "d", runId: "runA", totalMs: undefined, success: true }), { path }); // 无耗时(NULL)→跳过
    await recordRequest(makeRecord({ requestId: "e", runId: "runC", totalMs: 999, success: true }), { path }); // 不在集合里→排除

    const rows = await queryRoundSeriesByRunIds(["runA", "runB"], { path });
    assert.equal(rows.length, 3); // a,b (runA 有耗时) + c (runB)；d 无耗时跳过、e 不在集合
    assert.equal(rows[0].runId, "runA");
    assert.equal(rows[0].totalMs, 1000);
    assert.equal(rows[0].success, 1);
    assert.equal(rows[0].caseId, "case-1"); // 附带场景 id，供基础分组过滤
    assert.equal(rows[1].caseId, "case-2");
    assert.equal(rows[1].success, 0); // 升序：b 在 a 之后
    assert.equal(rows[2].runId, "runB");
    assert.equal(rows[2].totalMs, 1500);
    assert.ok(
      rows.every((r) => r.runId !== "runC"),
      "限定到指定运行，排除 runC",
    );

    assert.deepEqual(await queryRoundSeriesByRunIds([], { path }), []); // 空集合
    const onlyA = await queryRoundSeriesByRunIds(["runA"], { path });
    assert.equal(onlyA.length, 2);
    assert.ok(onlyA.every((r) => r.runId === "runA"));
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

// 回归（P2-5）：超过 limit 时保留【最新】的轮次，而非最旧的。
// 旧写法 `ORDER BY id ASC LIMIT` 砍掉 id 最大=最新的轮，趋势图/回归判定丢最近数据、静默漂移。
test("queryRoundSeriesByRunIds：超出 limit 时保留最新轮次并保持升序（P2-5）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "rounds-limit.db");
  try {
    // 顺序插入 5 轮，startedAt 递增标识新旧（插入顺序=id 顺序）
    for (let i = 0; i < 5; i += 1) {
      await recordRequest(makeRecord({ requestId: `r${i}`, runId: "big", totalMs: 100 + i, startedAt: `2026-06-02T00:00:0${i}Z` }), {
        path,
      });
    }
    const rows = await queryRoundSeriesByRunIds(["big"], { path, limit: 3 });
    assert.equal(rows.length, 3);
    // 应是最新 3 轮（i=2,3,4），且按时间升序排列供下游消费
    assert.deepEqual(
      rows.map((r) => r.startedAt),
      ["2026-06-02T00:00:02Z", "2026-06-02T00:00:03Z", "2026-06-02T00:00:04Z"],
    );
    assert.deepEqual(
      rows.map((r) => r.totalMs),
      [102, 103, 104],
      "保留的是最新轮，不是最旧轮",
    );
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteReport：删存在的一条→true 且不再出现在列表；删不存在→false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "reports.db");
  try {
    const rec = (reportId) => ({
      reportId,
      runId: reportId,
      type: "stability",
      title: reportId,
      pathMd: `/x/${reportId}.md`,
      pathHtml: `/x/${reportId}.html`,
      createdAt: "2026-06-02T00:00:00Z",
    });
    await recordReport(rec("R1"), { path });
    await recordReport(rec("R2"), { path });
    assert.equal((await queryRecentReports(10, { path })).length, 2);

    assert.equal(await deleteReport("R1", { path }), true);
    const rest = await queryRecentReports(10, { path });
    assert.equal(rest.length, 1);
    assert.equal(rest[0].report_id, "R2");

    // 删不存在的 id → false（无行受影响）
    assert.equal(await deleteReport("nope", { path }), false);
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordRequest never throws on malformed input (best-effort)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-db-"));
  const path = join(dir, "robust.db");
  try {
    assert.equal(await recordRequest(null, { path }), false);
    assert.equal(await recordRequest(undefined, { path }), false);
    assert.equal(await recordRequest({ requestId: "only-id" }, { path }), true);
  } finally {
    closeDatabase(path);
    await rm(dir, { recursive: true, force: true });
  }
});
