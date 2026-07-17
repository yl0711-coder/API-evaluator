// tests/high-risk-store.test.mjs
// 高危报告提示：collectHighRiskReports 判危口径（等级 或 分数，任一命中）+ 未读集合 add/list/ack + 开关短路。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectHighRiskReports,
  addAlerts,
  listAlerts,
  ackAlert,
  ackAll,
  noteRunIfEnabled,
  __setHighRiskFileForTest,
  __resetHighRiskWriteChainForTest,
} from "../server/high-risk-store.mjs";
import { __setSettingsForTest, __resetSettingsCacheForTest } from "../server/settings-store.mjs";

const html = (base) => `/tmp/reports/${base}.html`; // reportIdFromHtmlPath 取 basename 去 .html

test.afterEach(() => {
  __resetHighRiskWriteChainForTest();
  __resetSettingsCacheForTest();
});

// ===================== collectHighRiskReports 判危 =====================

test("admission：D/E/F/X 级 或 综合分<60 或 结论 fail → 高危；A 级达标 → 空", () => {
  assert.equal(
    collectHighRiskReports({
      type: "admission",
      grade: "D",
      score: 82,
      recommendation: { level: "watch" },
      model: "m1",
      reportHtmlPath: html("a_m1_admission_20260101_000000_aaaa"),
    }).length,
    1,
  );
  assert.equal(
    collectHighRiskReports({
      type: "admission",
      grade: "C",
      score: 50,
      recommendation: { level: "watch" },
      reportHtmlPath: html("a_admission_20260101_000000_bbbb"),
    }).length,
    1,
    "分数<60命中",
  );
  assert.equal(
    collectHighRiskReports({
      type: "admission",
      grade: "B",
      score: 85,
      recommendation: { level: "fail" },
      reportHtmlPath: html("a_admission_20260101_000000_cccc"),
    }).length,
    1,
    "结论 fail 命中",
  );
  assert.equal(
    collectHighRiskReports({
      type: "admission",
      grade: "A",
      score: 95,
      recommendation: { level: "pass" },
      reportHtmlPath: html("a_admission_20260101_000000_dddd"),
    }).length,
    0,
    "达标不报",
  );
});

test("scenario：逐模型 —— 质量分<60 或该模型结论 fail 命中", () => {
  const items = collectHighRiskReports({
    type: "scenario",
    reports: [
      { profileId: "p1", model: "m1", avgQualityScore: 45, reportHtmlPath: html("c_m1_scenario_20260101_000000_a1") },
      { profileId: "p2", model: "m2", avgQualityScore: 88, reportHtmlPath: html("c_m2_scenario_20260101_000000_a2") },
      { profileId: "p3", model: "m3", avgQualityScore: 90, reportHtmlPath: html("c_m3_scenario_20260101_000000_a3") },
    ],
    profileDigest: [
      { profileId: "p1", recommendation: { level: "watch" } },
      { profileId: "p2", recommendation: { level: "pass" } },
      { profileId: "p3", recommendation: { level: "fail" } }, // 质量90但结论fail → 仍命中
    ],
  });
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.reportId));
  assert.ok(items.some((i) => i.reason.includes("45")));
  assert.ok(items.some((i) => i.reason.includes("不推荐")));
});

test("batch-admission：逐模型 grade D/E/F/X 或分<60 命中", () => {
  const items = collectHighRiskReports({
    type: "batch-admission",
    reports: [
      { model: "m1", grade: "F", score: 10, reportHtmlPath: html("b_m1_admission_20260101_000000_e1") },
      { model: "m2", grade: "B", score: 82, reportHtmlPath: html("b_m2_admission_20260101_000000_e2") },
    ],
  });
  assert.equal(items.length, 1);
  assert.ok(items[0].reason.includes("F"));
});

test("stability：结论 fail 或成功率<0.8 命中；达标为空", () => {
  assert.equal(
    collectHighRiskReports({
      recommendation: { level: "fail" },
      successRate: 0.6,
      model: "m1",
      reportHtmlPath: html("s_m1_run_20260101_000000_f1"),
    }).length,
    1,
  );
  assert.equal(
    collectHighRiskReports({ recommendation: { level: "watch" }, successRate: 0.7, reportHtmlPath: html("s_run_20260101_000000_f2") })
      .length,
    1,
    "成功率<0.8命中",
  );
  assert.equal(
    collectHighRiskReports({ recommendation: { level: "pass" }, successRate: 0.99, reportHtmlPath: html("s_run_20260101_000000_f3") })
      .length,
    0,
  );
});

test("batch-stability：任一子渠道 fail/低成功率 → 整篇一条", () => {
  const items = collectHighRiskReports({
    batchId: "多目标_batch_20260101_000000_g1",
    results: [
      { recommendation: { level: "pass" }, successRate: 0.99 },
      { recommendation: { level: "fail" }, successRate: 0.6 },
    ],
    reportHtmlPath: html("bs_batch_20260101_000000_g1"),
  });
  assert.equal(items.length, 1);
});

test("quickverify：verdict suspect 命中；ok/ watch 不报", () => {
  assert.equal(
    collectHighRiskReports({
      type: "quick-verify",
      verdict: { level: "suspect" },
      model: "m1",
      reportHtmlPath: html("q_m1_quickverify_20260101_000000_h1"),
    }).length,
    1,
  );
  assert.equal(
    collectHighRiskReports({ type: "quick-verify", verdict: { level: "ok" }, reportHtmlPath: html("q_quickverify_20260101_000000_h2") })
      .length,
    0,
  );
  assert.equal(
    collectHighRiskReports({ type: "quick-verify", verdict: { level: "watch" }, reportHtmlPath: html("q_quickverify_20260101_000000_h3") })
      .length,
    0,
  );
});

test("无 reportHtmlPath / 空结果 → 不产出", () => {
  assert.deepEqual(collectHighRiskReports(null), []);
  assert.deepEqual(collectHighRiskReports({ type: "admission", grade: "F" }), [], "无 reportHtmlPath → 空 id 跳过");
});

// ===================== 未读集合 add/list/ack =====================

function withTempFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hra-"));
  __setHighRiskFileForTest(join(dir, "high-risk-alerts.json"));
  return Promise.resolve(fn()).finally(() => {
    __setHighRiskFileForTest(null);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
}

test("addAlerts 去重；listAlerts 新→旧；ackAlert/ackAll 移除", async () => {
  await withTempFile(async () => {
    await addAlerts([{ reportId: "r1", label: "准入 · m1", reason: "F 级" }]);
    await addAlerts([
      { reportId: "r1", label: "重复", reason: "x" },
      { reportId: "r2", label: "场景 · m2", reason: "质量分 40" },
    ]);
    let list = await listAlerts();
    assert.equal(list.length, 2, "r1 去重");
    assert.equal(list[0].reportId, "r2", "新→旧：最后加入的在前");

    await ackAlert("r1");
    list = await listAlerts();
    assert.deepEqual(
      list.map((a) => a.reportId),
      ["r2"],
    );

    await ackAll();
    assert.equal((await listAlerts()).length, 0);
  });
});

test("addAlerts 上限 200，超出丢最旧", async () => {
  await withTempFile(async () => {
    for (let i = 0; i < 205; i += 1) {
      await addAlerts([{ reportId: `r${i}`, label: "x", reason: "y" }]);
    }
    const list = await listAlerts();
    assert.equal(list.length, 200);
    assert.equal(list[0].reportId, "r204", "最新在前");
    assert.ok(!list.some((a) => a.reportId === "r0" || a.reportId === "r4"), "最旧 5 条被丢弃");
  });
});

test("noteRunIfEnabled：开关关不记；开关开则记高危", async () => {
  await withTempFile(async () => {
    const failRun = { type: "admission", grade: "F", score: 10, reportHtmlPath: html("a_m1_admission_20260101_000000_z1") };

    __setSettingsForTest({ enableHighRiskAlert: false });
    await noteRunIfEnabled(failRun);
    assert.equal((await listAlerts()).length, 0, "关时不记");

    __setSettingsForTest({ enableHighRiskAlert: true });
    await noteRunIfEnabled(failRun);
    assert.equal((await listAlerts()).length, 1, "开时记");

    // 达标运行即使开启也不产生条目
    await noteRunIfEnabled({
      type: "admission",
      grade: "A",
      score: 96,
      recommendation: { level: "pass" },
      reportHtmlPath: html("a_m2_admission_20260101_000000_z2"),
    });
    assert.equal((await listAlerts()).length, 1);
  });
});
