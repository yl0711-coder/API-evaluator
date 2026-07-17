// tests/report-compare-contract.test.mjs
// 钉死 reporting ↔ report-compare 之间的契约（16 号报告的 B2 / H2）。
//
// 为什么现有的 report-compare.test.mjs 抓不到这个问题：
//   它用 tests/fixtures/ 下【冻结的报告样例】当输入，完全不 import reporting.mjs。
//   也就是说它测的是「解析器 vs 某个时间点的格式快照」。改了 reporting 的表头，
//   fixture 不会跟着变 → 测试照样全绿 → 破坏静默上线。
//   （实测过：把 reporting 的「平均质量分」表头改名，744 条测试无一变红。）
//
// 本文件补的正是那条缺失的闭环：
//   路 A：formatScenarioReport(summary) → md → parseScenarioReport(md)   —— 解析 markdown
//   路 B：scenarioDataFromSummary(summary)                                —— 直接读结构化数据
//   两条路必须给出同一批数字。任一侧改了表头/字段语义，本测试立刻红。
import assert from "node:assert/strict";
import test from "node:test";

import { formatScenarioReport } from "../server/reporting.mjs";
import { parseScenarioReport, scenarioDataFromSummary } from "../server/report-compare.mjs";

// 最小可用的场景 summary。字段取自真实的 test_runs.raw_json 结构
// （results[].scenarios[] 各含 scenarioId/scenarioName/category/count/successCount/
//   successRate/successRateText/avgTotalMs/p95TotalMs/avgQualityScore/issues）。
function buildSummary() {
  return {
    runId: "scenario-contract-test",
    type: "scenario",
    startedAt: "2026-07-17T00:00:00.000Z",
    endedAt: "2026-07-17T00:01:00.000Z",
    durationMs: 60000,
    profileCount: 1,
    scenarioCount: 3,
    repeats: 2,
    results: [
      {
        profileId: "p1",
        profileName: "契约测试渠道 / model-x",
        provider: "test",
        model: "model-x",
        protocol: "openai_chat",
        caseCount: 6,
        successCount: 5,
        successRate: 5 / 6,
        avgTotalMs: 1234,
        p95TotalMs: 4321,
        avgQualityScore: 88,
        errorCounts: {},
        scenarios: [
          {
            scenarioId: "s-ok",
            scenarioName: "连通性：基础响应",
            category: "basic",
            difficulty: "easy",
            count: 2,
            successCount: 2,
            successRate: 1,
            successRateText: "100% (2/2)",
            avgTotalMs: 800,
            p95TotalMs: 900,
            avgQualityScore: 92,
            issues: [],
          },
          {
            // 有问题摘要 → 触发 issues.join("; ") 与 errored 判定
            scenarioId: "s-issue",
            scenarioName: "中文结构化：JSON 简评",
            category: "basic",
            difficulty: "medium",
            count: 2,
            successCount: 2,
            successRate: 1,
            successRateText: "100% (2/2)",
            avgTotalMs: 1500,
            p95TotalMs: 2000,
            avgQualityScore: 71,
            issues: ["未命中场景关键要点"],
          },
          {
            // 失败场景：错误型问题摘要 → errored 必须为 true（该字段进对比逻辑）
            scenarioId: "s-fail",
            scenarioName: "长上下文：关键事实检索 (NIAH)",
            category: "basic",
            difficulty: "hard",
            count: 2,
            successCount: 1,
            successRate: 0.5,
            successRateText: "50% (1/2)",
            avgTotalMs: 3000,
            p95TotalMs: 5000,
            avgQualityScore: 40,
            issues: ["请求超时"],
          },
        ],
      },
    ],
  };
}

test("契约：md 解析路 与 结构化路 对同一份 summary 给出相同的场景数字", () => {
  const summary = buildSummary();
  const md = formatScenarioReport(summary, {});
  const viaMd = parseScenarioReport(md);
  const viaDb = scenarioDataFromSummary(summary);

  assert.equal(viaDb.type, "scenario");
  assert.equal(viaMd.repeats, viaDb.repeats, "每个场景重复次数应一致");
  assert.equal(viaMd.scenarios.length, viaDb.scenarios.length, "场景行数应一致");

  const byName = new Map(viaDb.scenarios.map((s) => [s.name, s]));
  for (const m of viaMd.scenarios) {
    const d = byName.get(m.name);
    assert.ok(d, `结构化路缺少场景「${m.name}」`);
    // 数字字段：驱动统计与结论，必须严格一致
    assert.equal(m.rate, d.rate, `${m.name} 成功率`);
    assert.equal(m.quality, d.quality, `${m.name} 平均质量分`);
    assert.equal(m.avgMs, d.avgMs, `${m.name} 平均耗时`);
    assert.equal(m.p95, d.p95, `${m.name} P95`);
    assert.equal(m.succ, d.succ, `${m.name} 成功次数`);
    assert.equal(m.total, d.total, `${m.name} 总次数`);
    // 文本字段：issue 进 errored 判定，conclusion 进对比报告展示
    assert.equal(m.issue, d.issue, `${m.name} 问题摘要`);
    assert.equal(m.conclusion, d.conclusion, `${m.name} 场景结论`);
    assert.equal(m.errored, d.errored, `${m.name} 是否错误型失败`);
  }
});

test("契约：错误型问题摘要在两条路上都判为 errored（该字段进对比逻辑）", () => {
  const summary = buildSummary();
  const viaMd = parseScenarioReport(formatScenarioReport(summary, {}));
  const viaDb = scenarioDataFromSummary(summary);
  const pick = (r, name) => r.scenarios.find((s) => s.name === name);

  for (const [label, r] of [
    ["md 路", viaMd],
    ["结构化路", viaDb],
  ]) {
    assert.equal(pick(r, "长上下文：关键事实检索 (NIAH)").errored, true, `${label}：超时应判 errored`);
    assert.equal(pick(r, "连通性：基础响应").errored, false, `${label}：无问题不应判 errored`);
  }
});

test("结构化路：summary 无 results 时返回 null（调用方据此回退到 md 解析）", () => {
  assert.equal(scenarioDataFromSummary(null), null);
  assert.equal(scenarioDataFromSummary({}), null);
  assert.equal(scenarioDataFromSummary({ results: [] }), null);
});
