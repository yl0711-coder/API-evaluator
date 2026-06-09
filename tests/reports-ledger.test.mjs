import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// run_by 记账 + reports 元数据 + 留存清理 + spend_ledger（SQLite）
test("run_by accounting, reports registry, retention prune, spend ledger", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "evaluator-c-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  try {
    // 不带 query import，确保 db 与 withRunBy 共用同一个 AsyncLocalStorage 实例
    const db = await import("../server/db.mjs");
    const { withRunBy } = await import("../server/run-context.mjs");
    if (!(await db.isSqliteAvailable())) return; // 环境无 node:sqlite 时跳过

    // 1) run_by 记账：在 withRunBy 上下文写一条请求
    await withRunBy("alice", async () => {
      await db.recordRequest({ requestId: "r1", runId: "run-1", success: true });
    });
    const conn = await db.getDatabase();
    const reqRow = conn.prepare("SELECT run_by FROM test_requests WHERE request_id = ?").get("r1");
    assert.equal(reqRow.run_by, "alice");

    // 上下文外写入 → run_by 为空（不记账，不报错）
    await db.recordRequest({ requestId: "r2", runId: "run-1", success: true });
    const reqRow2 = conn.prepare("SELECT run_by FROM test_requests WHERE request_id = ?").get("r2");
    assert.equal(reqRow2.run_by, null);

    // 2) reports 元数据登记 + 读回
    await db.recordReport({
      reportId: "rep-1",
      runId: "run-1",
      type: "scenario",
      title: "T",
      pathMd: "/x.md",
      pathHtml: "/x.html",
      createdAt: new Date().toISOString(),
    });
    let reports = await db.queryRecentReports(10);
    assert.equal(reports[0].report_id, "rep-1");
    assert.equal(reports[0].type, "scenario");

    // 3) spend_ledger 记账
    await db.recordSpend({ runBy: "alice", runId: "run-1", estimated: 0.5, actual: 0.7, currency: "USD", createdAt: new Date().toISOString() });
    const spendRow = conn.prepare("SELECT run_by, actual FROM spend_ledger WHERE run_id = ?").get("run-1");
    assert.equal(spendRow.run_by, "alice");
    assert.equal(spendRow.actual, 0.7);

    // 4) 留存清理：插入一个很旧的报告，prune 应删它、保留新的
    await db.recordReport({
      reportId: "old-1",
      runId: "run-0",
      type: "scenario",
      title: "old",
      pathMd: "/o.md",
      pathHtml: "/o.html",
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    const removed = await db.pruneReports({ retentionDays: 30, maxTotal: 2000 });
    assert.ok(removed.find((r) => r.reportId === "old-1"), "过期报告应被清理");
    reports = await db.queryRecentReports(10);
    assert.ok(!reports.find((r) => r.report_id === "old-1"), "过期报告已删除");
    assert.ok(reports.find((r) => r.report_id === "rep-1"), "新报告应保留");

    db.closeDatabase();
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  }
});
