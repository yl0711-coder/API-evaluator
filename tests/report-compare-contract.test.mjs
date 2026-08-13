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

import { formatScenarioReport, formatStabilityReport } from "../server/reporting.mjs";
import { parseScenarioReport, parseRunReport, scenarioDataFromSummary, overlayRunDataFromSummary } from "../server/report-compare.mjs";

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
            outputTokens: 1_000,
            outputTokenReportedCount: 2,
            outputTokenTotalCount: 2,
            cacheReadTokens: 200,
            cacheReadTokenReportedCount: 2,
            cacheReadTokenTotalCount: 2,
            firstTokenSamples: [450, 480],
            firstTokenSampleCount: 2,
            p50FirstTokenMs: 450,
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
            outputTokens: 2_000,
            outputTokenReportedCount: 1,
            outputTokenTotalCount: 2,
            cacheReadTokens: 400,
            cacheReadTokenReportedCount: 2,
            cacheReadTokenTotalCount: 2,
            firstTokenSamples: [700],
            firstTokenSampleCount: 1,
            p50FirstTokenMs: 700,
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
            outputTokens: null,
            outputTokenReportedCount: 0,
            outputTokenTotalCount: 2,
            cacheReadTokens: null,
            cacheReadTokenReportedCount: 0,
            cacheReadTokenTotalCount: 2,
            firstTokenSamples: [],
            firstTokenSampleCount: 0,
            p50FirstTokenMs: null,
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
    assert.equal(m.outputTokens, d.outputTokens, `${m.name} 输出 Token`);
    assert.equal(m.outputTokenReportedCount, d.outputTokenReportedCount, `${m.name} 输出 Token 覆盖分子`);
    assert.equal(m.outputTokenTotalCount, d.outputTokenTotalCount, `${m.name} 输出 Token 覆盖分母`);
    assert.equal(m.cacheReadTokens, d.cacheReadTokens, `${m.name} 缓存命中 Token`);
    assert.equal(m.cacheReadTokenReportedCount, d.cacheReadTokenReportedCount, `${m.name} 缓存 Token 覆盖分子`);
    assert.equal(m.cacheReadTokenTotalCount, d.cacheReadTokenTotalCount, `${m.name} 缓存 Token 覆盖分母`);
    assert.equal(m.p50FirstTokenMs, d.p50FirstTokenMs, `${m.name} P50 首 Token`);
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

// —— 稳定性(run)报告 ——
// parseRunReport 的 16 个数值字段靠 kv(s4,"平均首包") 这类中文标签取值，标签一改就返回 null、
// 静默算错。overlayRunDataFromSummary 改从 test_runs.raw_json 取这些值。
// 本组测试钉住：两条路必须给出同一批数字。

function buildRunSummary() {
  return {
    runId: "run-contract-test",
    type: "stability",
    profileId: "p1",
    profileName: "契约测试渠道 / model-x",
    profileRole: "target",
    provider: "test",
    model: "model-x",
    protocol: "openai_chat",
    channelCode: "test",
    startedAt: "2026-07-17T00:00:00.000Z",
    endedAt: "2026-07-17T00:02:00.000Z",
    durationMs: 120000,
    rounds: 10,
    concurrency: 2,
    successCount: 8,
    failureCount: 2,
    successRate: 0.8,
    successRateText: "80% (8/10)",
    successRateCi: { ci95Lower: 0.49, ci95Upper: 0.94, method: "wilson" },
    avgFirstByteMs: 1200,
    avgTotalMs: 3400,
    p50TotalMs: 3000,
    p95TotalMs: 8000,
    p99TotalMs: 9500,
    minTotalMs: 900,
    maxTotalMs: 9800,
    avgOutputChars: 512,
    inputTokens: 1150,
    outputTokens: 2300,
    estimatedCost: 0.0123,
    estimatedRevenue: 0.02,
    estimatedGrossProfit: 0.0077,
    estimatedGrossMargin: 0.385,
    errorCounts: { timeout: 2 },
    diagnostics: [],
    recommendation: { level: "warn", title: "需关注", detail: "成功率偏低。" },
    promptPreview: "ping",
    actualConsumption: { inputTokens: 1150, outputTokens: 2300, estimatedCost: 0.0123, hasPrices: true, currency: "USD" },
  };
}

// records：单轮明细表的数据源。给 2 条足够渲染出表格，让 parseRunReport 有东西可解析。
function buildRunRecords() {
  return [
    { caseId: "round-1", success: true, statusCode: 200, firstByteMs: 900, totalMs: 3000, outputChars: 500 },
    { caseId: "round-2", success: false, statusCode: 504, firstByteMs: null, totalMs: 9800, normalizedError: "timeout", outputChars: 0 },
  ];
}

test("契约：run 报告的数值字段，md 解析路 与 库覆盖路 一致", () => {
  const summary = buildRunSummary();
  const md = formatStabilityReport(summary, buildRunRecords(), {});
  const viaMd = parseRunReport(md);
  const merged = overlayRunDataFromSummary(viaMd, summary);

  // 这些字段在 md 里靠中文标签取；覆盖后应等于 summary 里的原生值。
  const checks = [
    ["rate", 0.8],
    ["succ", 8],
    ["total", 10],
    ["avgFirstByteMs", 1200],
    ["avgTotalMs", 3400],
    ["p50TotalMs", 3000],
    ["p95TotalMs", 8000],
    ["p99TotalMs", 9500],
    ["minMs", 900],
    ["maxMs", 9800],
    ["avgOutputChars", 512],
    ["inputTokens", 1150],
    ["outputTokens", 2300],
    ["rounds", 10],
    ["concurrency", 2],
  ];
  for (const [field, expected] of checks) {
    assert.equal(merged[field], expected, `覆盖后的 ${field} 应等于 summary 原生值`);
    // 关键：md 路也必须解出同一个值 —— 否则说明两条路语义已漂移（或 reporting 的标签变了）
    assert.equal(viaMd[field], expected, `md 解析出的 ${field} 应与 summary 一致（不一致＝标签漂移或口径分歧）`);
  }
  assert.deepEqual(merged.errorCounts, { timeout: 2 }, "errorCounts 应取库里的对象");
});

test("契约：逐轮样本仍来自 md（库里没有），覆盖不得把它们弄丢", () => {
  const summary = buildRunSummary();
  const md = formatStabilityReport(summary, buildRunRecords(), {});
  const viaMd = parseRunReport(md);
  const merged = overlayRunDataFromSummary(viaMd, summary);
  // latencySamples 要喂 bootstrapDiffCI 算延迟差置信区间，是对比的统计核心，不能被覆盖掉。
  assert.ok(viaMd.latencySamples.length > 0, "md 应解析出逐轮样本");
  assert.deepEqual(merged.latencySamples, viaMd.latencySamples, "覆盖不得改动 latencySamples");
  assert.deepEqual(merged.latencyRounds, viaMd.latencyRounds, "覆盖不得改动 latencyRounds");
});

test("覆盖路：无 summary 时原样返回（调用方据此保持改动前的行为）", () => {
  const base = { type: "run", rate: 0.5, avgTotalMs: 100 };
  assert.equal(overlayRunDataFromSummary(base, null), base);
  assert.equal(overlayRunDataFromSummary(base, undefined), base);
  assert.equal(overlayRunDataFromSummary(null, {}), null);
});
