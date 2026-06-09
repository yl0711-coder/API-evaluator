import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { toTrendPoint, buildTrendSeries, buildBaseline, detectRegression } from "../server/regression.mjs";

const run = (over = {}) => ({
  runId: "r" + Math.random().toString(36).slice(2, 8),
  type: "stability",
  endedAt: new Date().toISOString(),
  successRate: 0.98,
  p95TotalMs: 2000,
  grade: null,
  actualConsumption: { totalTokens: 1000, estimatedCost: 0.01 },
  ...over,
});

test("toTrendPoint / buildTrendSeries 提取关键量", () => {
  const p = toTrendPoint(run({ runId: "x", successRate: 0.9, p95TotalMs: 1500 }));
  assert.equal(p.successRate, 0.9);
  assert.equal(p.p95Ms, 1500);
  assert.equal(p.totalTokens, 1000);
  assert.equal(buildTrendSeries([run(), run()]).length, 2);
});

test("buildBaseline：<2 同类样本 → insufficient；否则取中位", () => {
  assert.equal(buildBaseline([toTrendPoint(run())], { type: "stability" }).insufficient, true);
  const base = buildBaseline([toTrendPoint(run({ successRate: 0.98 })), toTrendPoint(run({ successRate: 0.96 })), toTrendPoint(run({ successRate: 0.97 }))], { type: "stability" });
  assert.equal(base.insufficient, false);
  assert.equal(base.successRate, 0.97);
});

test("detectRegression：首次 → baseline", () => {
  const r = detectRegression({ current: toTrendPoint(run({ runId: "first" })), history: [] });
  assert.equal(r.status, "baseline");
});

test("detectRegression：与基线一致 → stable", () => {
  const history = [run({ successRate: 0.98 }), run({ successRate: 0.97 }), run({ successRate: 0.98 })].map(toTrendPoint);
  const r = detectRegression({ current: toTrendPoint(run({ runId: "cur", successRate: 0.97 })), history });
  assert.equal(r.status, "stable");
});

test("detectRegression：成功率明显下跌 → regressed", () => {
  const history = [run({ successRate: 0.98 }), run({ successRate: 0.97 }), run({ successRate: 0.98 })].map(toTrendPoint);
  const cur = toTrendPoint(run({ runId: "cur", successRate: 0.7 })); // 97% → 70%
  const r = detectRegression({ current: cur, history });
  assert.equal(r.status, "regressed");
  assert.ok(r.changes.some((c) => c.metric === "success_rate"));
  assert.equal(r.severity, "high");
});

test("detectRegression：P95 翻倍 → regressed", () => {
  const history = [run({ p95TotalMs: 2000 }), run({ p95TotalMs: 2200 }), run({ p95TotalMs: 1900 })].map(toTrendPoint);
  const r = detectRegression({ current: toTrendPoint(run({ runId: "cur", p95TotalMs: 5000 })), history });
  assert.equal(r.status, "regressed");
  assert.ok(r.changes.some((c) => c.metric === "p95"));
});

test("detectRegression：准入等级下滑 ≥2 档 → regressed", () => {
  const history = [run({ type: "admission", grade: "A", successRate: 0.99 }), run({ type: "admission", grade: "A", successRate: 0.99 })].map(toTrendPoint);
  const cur = toTrendPoint(run({ runId: "cur", type: "admission", grade: "D", successRate: 0.99 }));
  const r = detectRegression({ current: cur, history });
  assert.equal(r.status, "regressed");
  assert.ok(r.changes.some((c) => c.metric === "grade"));
});

test("regression_alerts 往返 + queryProfileRunSummaries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "regression-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  try {
    const db = await import(`../server/db.mjs?case=${Date.now()}`);
    if (!(await db.isSqliteAvailable())) return;
    await db.recordTestRun({ runId: "run-1", type: "stability", profileId: "p1", profileName: "渠道A", successRate: 0.98, successCount: 49, endedAt: new Date().toISOString() }, { type: "stability" });
    await db.recordRegressionAlert({ profileId: "p1", profileName: "渠道A", runId: "run-2", runType: "stability", severity: "high", summary: "成功率从 98% 跌到 70%", createdAt: new Date().toISOString() });
    const summaries = await db.queryProfileRunSummaries("p1");
    assert.ok(summaries.length >= 1);
    assert.equal(summaries[0].runId, "run-1");
    const alerts = await db.queryRegressionAlerts({ profileId: "p1" });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, "high");
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  }
});
