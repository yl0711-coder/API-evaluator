// tests/auto-test-digest.test.mjs
// 「自动测试巡检报告」纯格式化内核（server/auto-test-digest.mjs）：分节成文 + 每模型一张 chart-svg 图 +
// 空数据优雅。图由 renderTrendChart 从逐轮数字生成，故校验 chart-svg 围栏内含 <svg>。
import assert from "node:assert/strict";
import test from "node:test";

import { formatAutoTestDigestReport, windowLabel } from "../server/auto-test-digest.mjs";

const fullData = () => ({
  windowHours: 168,
  generatedAt: "2026-07-10T09:00:00Z",
  jobs: [
    {
      name: "夜间稳定性",
      kind: "stability",
      targetLabel: "渠道A",
      targetId: "t1",
      model: "m1",
      enabled: true,
      periodHours: 24,
      lastRunAt: "2026-07-10T08:00:00Z",
      lastStatus: "成功",
      nextRunAt: "2026-07-11T08:00:00Z",
      consecutiveFailures: 0,
      autoDisabled: false,
      overdue: false,
      runsInWindow: 3,
    },
    {
      name: "逾期作业",
      kind: "scenario",
      targetLabel: "渠道B",
      targetId: "t2",
      model: "m2",
      enabled: true,
      periodHours: 12,
      lastRunAt: "2026-07-05T00:00:00Z",
      lastStatus: "成功",
      nextRunAt: "2026-07-06T00:00:00Z",
      consecutiveFailures: 0,
      autoDisabled: false,
      overdue: true,
      runsInWindow: 1,
    },
  ],
  targets: [
    {
      profileId: "t1",
      label: "渠道A",
      model: "m1",
      runsInWindow: 3,
      latest: { at: "2026-07-10T08:00:00Z", grade: "A", successRate: 0.97, p95Ms: 1800 },
      prev: { successRate: 0.99 },
      regression: { status: "stable", changes: [] },
      rounds: [
        { at: "2026-07-10T08:00:00Z", ms: 1500, ok: true, runRate: 0.97 },
        { at: "2026-07-10T08:01:00Z", ms: 1600, ok: true, runRate: 0.97 },
      ],
    },
    {
      profileId: "t2",
      label: "渠道B",
      model: "m2",
      runsInWindow: 1,
      latest: { at: "2026-07-10T07:00:00Z", grade: "D", successRate: 0.6, p95Ms: 9000 },
      prev: { successRate: 0.95 },
      regression: { status: "regressed", verdict: "疑似退化", changes: [{ detail: "成功率从基线 95% 跌到 60%（↓35pp）" }] },
      rounds: [], // 窗口内无逐轮数据 → 不配图
    },
  ],
  regressionAlerts: [{ created_at: "2026-07-09T00:00:00Z", severity: "high", summary: "成功率下滑", profile_name: "渠道B" }],
  highRiskAlerts: [{ title: "渠道B 高危" }],
});

test("windowLabel：常见窗口给中文标签", () => {
  assert.equal(windowLabel(24), "最近 24 小时");
  assert.equal(windowLabel(168), "最近 7 天");
  assert.equal(windowLabel(720), "最近 30 天");
  assert.match(windowLabel(6), /最近 6 小时/);
});

test("完整数据：分节齐全、需要关注命中、每模型配置", () => {
  const md = formatAutoTestDigestReport(fullData());
  // 结构
  assert.match(md, /^# 自动测试巡检报告/);
  assert.match(md, /最近 7 天/);
  assert.match(md, /## 需要关注/);
  assert.match(md, /## 执行概览（调度健康）/);
  assert.match(md, /## 逐模型小结/);
  assert.match(md, /## 稳定性趋势（每模型一张）/);
  assert.match(md, /## 方法学与免责/);
  // 需要关注：逾期作业 + 退化模型 + 回归告警 + 高危
  assert.match(md, /逾期作业.*未运行|逾期未跑|未运行/);
  assert.match(md, /疑似退化/);
  assert.match(md, /回归告警/);
  assert.match(md, /高危/);
  // 执行概览表含两条作业
  assert.match(md, /夜间稳定性/);
  assert.match(md, /稳定性 \|/); // kind 中文化
  // 逐模型小结：成功率与环比
  assert.match(md, /97%/);
  assert.match(md, /↓2pp|↓/); // 97% vs 99%
  // 图：t1 有 rounds → chart-svg + <svg>；t2 无 rounds → 提示无数据
  assert.match(md, /```chart-svg/);
  assert.match(md, /<svg/);
  assert.match(md, /窗口内暂无可绘制的逐轮数据/);
});

test("scopeLabel：单模型模式在抬头加「范围」行", () => {
  const md = formatAutoTestDigestReport({ ...fullData(), scopeLabel: "单个模型 · 渠道A · m1" });
  assert.match(md, /\*\*范围\*\*：单个模型 · 渠道A · m1/);
  // 不传则无范围行
  assert.doesNotMatch(formatAutoTestDigestReport(fullData()), /\*\*范围\*\*/);
});

test("空数据：各节优雅兜底，不抛", () => {
  const md = formatAutoTestDigestReport({ windowHours: 24, generatedAt: "2026-07-10T00:00:00Z", jobs: [], targets: [], regressionAlerts: [], highRiskAlerts: [] });
  assert.match(md, /✅ 本周期未见回归、高危或作业异常。/);
  assert.match(md, /尚未配置任何自动测试作业/);
  assert.match(md, /窗口内没有任何模型的测试运行/);
  assert.doesNotMatch(md, /```chart-svg/); // 无模型 → 无图
  // 完全空 args 也不抛
  assert.doesNotThrow(() => formatAutoTestDigestReport());
  assert.doesNotThrow(() => formatAutoTestDigestReport({}));
});

test("单元格转义：作业名含竖线不撑破表格", () => {
  const data = fullData();
  data.jobs[0].name = "含|竖线";
  const md = formatAutoTestDigestReport(data);
  assert.match(md, /含\\\|竖线/); // | 被转义成 \|
});
