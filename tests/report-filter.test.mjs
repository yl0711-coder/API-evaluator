// tests/report-filter.test.mjs
// 「全部报告」筛选功能：matchesReportFilter（渠道/模型/种类/日期区间）+ computeDateBounds（日期联动边界）。
import assert from "node:assert/strict";
import test from "node:test";

import { parseReportId, matchesReportFilter, computeDateBounds, reportChannelModelOptions } from "../src/report-id.js";

const A = parseReportId("小侠_deepseek-v4-flash_quickverify_20260601_095752_3f2a");
const B = parseReportId("Nexus-claude-6.3x_claude-opus-4-7_scenario_20260615_101010_ab12");
const MULTI = parseReportId("多目标_scenario_20260620_120000_cd34");
const OLD = parseReportId("admission-20260615-183217-232baef6"); // { isNew:false }

test("无任何条件 → 全部命中（含老报告）", () => {
  for (const p of [A, B, MULTI, OLD]) assert.equal(matchesReportFilter(p, {}), true);
});

test("设了条件 → 老报告一律不命中", () => {
  assert.equal(matchesReportFilter(OLD, { type: "admission" }), false);
  assert.equal(matchesReportFilter(OLD, { channel: "小侠" }), false);
});

test("渠道筛选", () => {
  assert.equal(matchesReportFilter(A, { channel: "小侠" }), true);
  assert.equal(matchesReportFilter(B, { channel: "小侠" }), false);
  assert.equal(matchesReportFilter(B, { channel: "Nexus-claude-6.3x" }), true);
});

test("模型筛选", () => {
  assert.equal(matchesReportFilter(A, { model: "deepseek-v4-flash" }), true);
  assert.equal(matchesReportFilter(B, { model: "deepseek-v4-flash" }), false);
});

test("测试种类筛选", () => {
  assert.equal(matchesReportFilter(A, { type: "quickverify" }), true);
  assert.equal(matchesReportFilter(B, { type: "quickverify" }), false);
  assert.equal(matchesReportFilter(B, { type: "scenario" }), true);
});

test("多目标报告：无渠道/模型 → 渠道筛选排除、种类筛选命中", () => {
  assert.equal(matchesReportFilter(MULTI, { channel: "小侠" }), false);
  assert.equal(matchesReportFilter(MULTI, { model: "x" }), false);
  assert.equal(matchesReportFilter(MULTI, { type: "scenario" }), true);
});

test("日期区间：仅起始（含端点）", () => {
  assert.equal(matchesReportFilter(A, { from: "20260601" }), true); // A=0601，含端点
  assert.equal(matchesReportFilter(A, { from: "20260602" }), false); // 早于起始 → 排除
  assert.equal(matchesReportFilter(B, { from: "20260610" }), true); // B=0615
});

test("日期区间：仅终止（含端点）", () => {
  assert.equal(matchesReportFilter(B, { to: "20260615" }), true); // 含端点
  assert.equal(matchesReportFilter(B, { to: "20260614" }), false);
  assert.equal(matchesReportFilter(A, { to: "20260610" }), true); // A=0601
});

test("日期区间：起始+终止双闭区间", () => {
  const f = { from: "20260601", to: "20260615" };
  assert.equal(matchesReportFilter(A, f), true); // 0601 在区间
  assert.equal(matchesReportFilter(B, f), true); // 0615 在区间（含端点）
  assert.equal(matchesReportFilter(MULTI, f), false); // 0620 超出
  // 反向区间（起始>终止）→ 无报告命中
  assert.equal(matchesReportFilter(A, { from: "20260615", to: "20260601" }), false);
});

test("多条件 AND 组合", () => {
  assert.equal(matchesReportFilter(B, { channel: "Nexus-claude-6.3x", type: "scenario", from: "20260610", to: "20260620" }), true);
  assert.equal(matchesReportFilter(B, { channel: "Nexus-claude-6.3x", type: "quickverify" }), false); // 种类不符
});

// —— 渠道↔模型联动（reportChannelModelOptions）——
// 造一批报告：渠道 甲 挂 m1/m2；渠道 乙 挂 m2/m3。含一条多目标（无渠道/模型）与一条老报告，均应被忽略。
const LINK_LIST = [
  parseReportId("甲_m1_scenario_20260601_090000_a1"),
  parseReportId("甲_m2_scenario_20260602_090000_a2"),
  parseReportId("乙_m2_scenario_20260603_090000_b1"),
  parseReportId("乙_m3_scenario_20260604_090000_b2"),
  parseReportId("多目标_scenario_20260605_090000_cd"),
  parseReportId("admission-20260606-090000-deadbeef"),
];

test("联动：未选任何项 → 渠道/模型各取全集（去重排序，忽略多目标/老报告）", () => {
  const { channels, models } = reportChannelModelOptions(LINK_LIST, {});
  assert.deepEqual(channels, ["甲", "乙"].sort());
  assert.deepEqual(models, ["m1", "m2", "m3"].sort());
});

test("联动：选了渠道『甲』→ 模型只剩甲的 m1/m2；渠道选项不因此自减", () => {
  const { channels, models } = reportChannelModelOptions(LINK_LIST, { channel: "甲" });
  assert.deepEqual(models, ["m1", "m2"].sort());
  assert.deepEqual(channels, ["甲", "乙"].sort(), "只约束模型，不约束渠道自身");
});

test("联动：选了模型『m2』→ 渠道只剩挂 m2 的 甲/乙；模型选项不因此自减", () => {
  const { channels, models } = reportChannelModelOptions(LINK_LIST, { model: "m2" });
  assert.deepEqual(channels, ["甲", "乙"].sort());
  assert.deepEqual(models, ["m1", "m2", "m3"].sort(), "只约束渠道，不约束模型自身");
});

test("联动：选了模型『m3』→ 渠道只剩『乙』", () => {
  const { channels } = reportChannelModelOptions(LINK_LIST, { model: "m3" });
  assert.deepEqual(channels, ["乙"]);
});

test("联动：渠道『甲』+模型『m2』一致 → 两者互留", () => {
  const { channels, models } = reportChannelModelOptions(LINK_LIST, { channel: "甲", model: "m2" });
  assert.ok(channels.includes("甲"));
  assert.ok(models.includes("m2"));
});

test("computeDateBounds：终止不早于起始、起始不晚于终止，空则退回报告范围", () => {
  const RMIN = "2026-06-01";
  const RMAX = "2026-06-30";
  // 都空 → 各退回报告范围
  assert.deepEqual(computeDateBounds("", "", RMIN, RMAX), { toMin: RMIN, fromMax: RMAX });
  // 选了起始 → 终止的最早可选 = 起始
  assert.deepEqual(computeDateBounds("2026-06-10", "", RMIN, RMAX), { toMin: "2026-06-10", fromMax: RMAX });
  // 选了终止 → 起始的最晚可选 = 终止
  assert.deepEqual(computeDateBounds("", "2026-06-20", RMIN, RMAX), { toMin: RMIN, fromMax: "2026-06-20" });
  // 都选 → 互相收紧
  assert.deepEqual(computeDateBounds("2026-06-10", "2026-06-20", RMIN, RMAX), { toMin: "2026-06-10", fromMax: "2026-06-20" });
});
