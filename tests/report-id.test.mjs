import assert from "node:assert/strict";
import test from "node:test";

import { parseReportId, matchesReportFilter, reportChannelModelOptions } from "../src/report-id.js";

test("parseReportId：新单目标", () => {
  assert.deepEqual(parseReportId("小侠_deepseek-v4-flash_quickverify_20260629_095752_3f2a"), {
    isNew: true,
    type: "quickverify",
    date: "20260629",
    channel: "小侠",
    model: "deepseek-v4-flash",
  });
});

test("parseReportId：含下划线渠道名（模型仍单 token）", () => {
  const r = parseReportId("My_Channel_gpt-4o_admission_20260629_095752_ab12");
  assert.equal(r.channel, "My_Channel");
  assert.equal(r.model, "gpt-4o");
  assert.equal(r.type, "admission");
  assert.equal(r.date, "20260629");
});

test("parseReportId：多目标 → 无渠道/模型", () => {
  const r = parseReportId("多目标_scenario_20260629_095752_ab12");
  assert.equal(r.isNew, true);
  assert.equal(r.type, "scenario");
  assert.equal(r.channel, null);
  assert.equal(r.model, null);
});

test("parseReportId：老格式不参与筛选", () => {
  assert.deepEqual(parseReportId("admission-20260615-183217-232baef6"), { isNew: false });
  assert.deepEqual(parseReportId("run-20260615-185321-088c8497"), { isNew: false });
});

test("parseReportId：AI 分析归母报告解析", () => {
  const r = parseReportId("小侠_deepseek-v4-flash_quickverify_20260629_095752_3f2a-ai-analysis");
  assert.equal(r.isNew, true);
  assert.equal(r.channel, "小侠");
  assert.equal(r.model, "deepseek-v4-flash");
  assert.equal(r.type, "quickverify");
});

test("aliasMaps：曾用名归并到当前名（筛选 + 下拉）", () => {
  const aliasMaps = { channel: { "老A": "中转A" }, model: { gpt4: "gpt-4o" } };
  const oldR = parseReportId("老A_gpt4_run_20250101_120000_ab12"); // 改名前落盘
  const newR = parseReportId("中转A_gpt-4o_run_20250201_120000_cd34"); // 改名后
  // 按当前名筛，曾用名的旧报告也命中；不传 aliasMaps 则维持原行为（不命中）。
  assert.equal(matchesReportFilter(oldR, { channel: "中转A", model: "gpt-4o" }, aliasMaps), true);
  assert.equal(matchesReportFilter(newR, { channel: "中转A", model: "gpt-4o" }, aliasMaps), true);
  assert.equal(matchesReportFilter(oldR, { channel: "中转A", model: "gpt-4o" }), false);
  // 下拉：曾用名折算成当前名，只呈现当前名。
  const opts = reportChannelModelOptions([oldR, newR], {}, aliasMaps);
  assert.deepEqual(opts.channels, ["中转A"]);
  assert.deepEqual(opts.models, ["gpt-4o"]);
});
