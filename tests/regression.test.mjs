import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  toTrendPoint,
  buildTrendSeries,
  buildBaseline,
  detectRegression,
  collectBasicScenarioCaseIds,
  summarizeRoundStats,
  BASIC_SCENARIO_GROUP,
} from "../server/regression.mjs";

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

test("toTrendPoint：quick-verify 无 successRate 字段时按 successCount/requestCount 补出（追溯进趋势）", () => {
  // 既有快检汇总只有 successCount/requestCount、无 successRate → 应补出成功率，进趋势与回归。
  const p = toTrendPoint({ runId: "qv", type: "quick-verify", endedAt: new Date().toISOString(), successCount: 4, requestCount: 6 });
  assert.equal(p.successRate, 4 / 6);
  // 有显式 successRate 时以其为准（新版快检直接写了）。
  const p2 = toTrendPoint({ runId: "qv2", type: "quick-verify", endedAt: new Date().toISOString(), successRate: 0.5, successCount: 4, requestCount: 6 });
  assert.equal(p2.successRate, 0.5);
  // 非 quick-verify 且无 successRate → 不臆造（保持 null，不污染趋势）。
  const p3 = toTrendPoint({ runId: "sc", type: "scenario", endedAt: new Date().toISOString(), successCount: 4, requestCount: 6 });
  assert.equal(p3.successRate, null);
  // requestCount=0 → null（不除零）。
  const p4 = toTrendPoint({ runId: "qv0", type: "quick-verify", endedAt: new Date().toISOString(), successCount: 0, requestCount: 0 });
  assert.equal(p4.successRate, null);
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

test("collectBasicScenarioCaseIds：只挑场景运行、按分组过滤、混合分组只取基础、无基础不入表", () => {
  assert.equal(BASIC_SCENARIO_GROUP, "基础");
  const summaries = [
    // 纯基础场景运行 → 取两个基础 id
    { runId: "sc1", type: "scenario", scenarios: [
      { id: "b1", group: "基础" },
      { id: "b2", group: "基础" },
    ] },
    // 混合分组 → 只取基础 id，丢 HLE
    { runId: "sc2", type: "scenario", scenarios: [
      { id: "b3", group: "基础" },
      { id: "h1", group: "HLE" },
    ] },
    // 无基础场景 → 不入表
    { runId: "sc3", type: "scenario", scenarios: [{ id: "h2", group: "HLE" }] },
    // 非场景运行 → 忽略
    { runId: "st1", type: "stability", scenarios: [{ id: "b9", group: "基础" }] },
    // 无 scenarios / 无 runId → 忽略
    { runId: "sc4", type: "scenario" },
    { type: "scenario", scenarios: [{ id: "b8", group: "基础" }] },
  ];
  const map = collectBasicScenarioCaseIds(summaries);
  assert.deepEqual([...map.keys()].sort(), ["sc1", "sc2"]);
  assert.deepEqual([...map.get("sc1")].sort(), ["b1", "b2"]);
  assert.deepEqual([...map.get("sc2")], ["b3"], "混合分组只取基础，绝不含 HLE");
  assert.equal(map.has("sc3"), false, "无基础场景不入表");
  assert.equal(map.has("st1"), false, "非场景运行忽略");
  // 自定义分组名亦可
  const custom = collectBasicScenarioCaseIds([{ runId: "x", type: "scenario", scenarios: [{ id: "k", group: "自建" }] }], "自建");
  assert.deepEqual([...custom.get("x")], ["k"]);
  // 空输入健壮
  assert.equal(collectBasicScenarioCaseIds(undefined).size, 0);
});

test("summarizeRoundStats：成功率=成功轮/总轮、P95 取 0.95 分位、空集合 → null", () => {
  const rounds = [
    { totalMs: 100, success: 1 },
    { totalMs: 200, success: 1 },
    { totalMs: 300, success: 0 },
    { totalMs: 400, success: 1 },
    { totalMs: 5000, success: 0 }, // 慢且失败 → 抬高 P95
  ];
  const s = summarizeRoundStats(rounds);
  assert.equal(s.successRate, 3 / 5);
  assert.equal(s.p95Ms, 5000); // ceil(5*0.95)-1 = 4 → 排序后第 5 个 = 5000
  // 无耗时的轮被剔除（不参与成功率与 P95）
  const s2 = summarizeRoundStats([{ totalMs: 100, success: 1 }, { totalMs: null, success: 0 }]);
  assert.equal(s2.successRate, 1);
  assert.equal(s2.p95Ms, 100);
  // 空集合 → null（既不进图也不污染回归）
  assert.deepEqual(summarizeRoundStats([]), { successRate: null, p95Ms: null });
  assert.deepEqual(summarizeRoundStats(undefined), { successRate: null, p95Ms: null });
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
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});
