// tests/report-filter.test.mjs
// 「全部报告」筛选功能：matchesReportFilter（渠道/模型/种类/日期区间）+ computeDateBounds（日期联动边界）。
import assert from "node:assert/strict";
import test from "node:test";

import { parseReportId, matchesReportFilter, computeDateBounds } from "../src/report-id.js";

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
