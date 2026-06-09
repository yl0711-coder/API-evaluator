import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHandoffTemplate,
  buildModelComparisonGroups,
  buildRankingRows,
  getLatestRuns,
  renderInsightCards,
  renderModelComparisonList,
  renderPlainConclusion,
  renderRankingList,
} from "../src/delivery-view.js";

test("delivery view groups latest runs, failures, and interrupted tasks", () => {
  const runs = getLatestRuns({
    testRuns: [
      {
        type: "scenario",
        startedAt: "2026-05-20T10:01:00.000Z",
        profileCount: 2,
        scenarioCount: 3,
        results: [{ avgQualityScore: 85, successRate: 1 }],
      },
      {
        type: "stability",
        startedAt: "2026-05-20T10:00:00.000Z",
        profileName: "Demo API",
        successRateText: "100%",
        recommendation: { level: "pass", title: "可用" },
      },
    ],
    requests: [{ success: false, profileName: "Bad API", normalizedError: "timeout" }],
    taskEvents: [{ status: "interrupted", type: "stability", message: "中断" }],
  });

  assert.equal(runs.latest.type, "scenario");
  assert.equal(runs.latestStability.profileName, "Demo API");
  assert.equal(runs.failedRequests.length, 1);
  assert.equal(runs.interruptedTasks.length, 1);
});

test("delivery view renders operator-facing insights and handoff template", () => {
  const runs = {
    latest: {
      type: "stability",
      profileName: "Demo API",
      model: "demo-model",
      successRateText: "100%",
      p95TotalMs: 300,
      recommendation: { level: "pass", title: "稳定", detail: "可以继续复核。" },
      reportPath: "/tmp/report.md",
      reportHtmlPath: "/tmp/report.html",
    },
    latestStability: {
      profileName: "Demo API",
      successRateText: "100%",
      p95TotalMs: 300,
      rounds: 10,
      recommendation: { level: "pass", title: "稳定", detail: "可以继续复核。" },
      reportPath: "/tmp/report.md",
      reportHtmlPath: "/tmp/report.html",
    },
    latestScenario: null,
    latestRequest: { success: true, profileName: "Demo API", statusCode: 200, totalMs: 200, responseSummary: "ok" },
    failedRequests: [],
    interruptedTasks: [],
  };

  const cards = renderInsightCards(runs, { compact: false });
  const handoff = buildHandoffTemplate(runs, {
    projectName: "渠道复测",
    batchName: "第一批",
    testerName: "测试员 A",
    testPurpose: "筛选稳定候选",
  }, [
    {
      profileName: "Demo API",
      model: "demo-model",
      score: 91,
      successRate: 1,
      purityScore: 88,
      fingerprintRate: 1,
      baselineDelta: 3,
      baselineProfileName: "Official Demo",
    },
    {
      profileName: "Official Demo",
      profileRole: "baseline",
      model: "demo-model",
      score: 88,
      successRate: 1,
    },
  ]);

  assert.match(cards, /稳定性结论/);
  assert.match(cards, /交付材料基本完整/);
  assert.match(handoff, /测试交付/);
  assert.match(handoff, /项目 \/ 客户：渠道复测/);
  assert.match(handoff, /测试批次：第一批/);
  assert.match(handoff, /候选渠道与可信基线对比/);
  assert.match(handoff, /Demo API \/ demo-model：综合分 91/);
  assert.match(handoff, /相对可信基线 Official Demo：\+3 分/);
  assert.match(handoff, /本交付内容不包含 API Key/);
});

test("delivery view renders plain conclusion for non-technical operators", () => {
  const html = renderPlainConclusion({
    latestStability: {
      successRateText: "100%",
      p95TotalMs: 300,
      recommendation: { level: "pass", title: "稳定", detail: "可以继续复核。" },
    },
    latestScenario: null,
    latestRequest: null,
    failedRequests: [],
    interruptedTasks: [],
  });

  assert.match(html, /推荐进入下一轮/);
  assert.match(html, /继续跑复杂场景测试/);
});

test("delivery view ranks model channels by stability and scenario results", () => {
  const rows = buildRankingRows([
    {
      type: "stability",
      profileId: "a",
      profileName: "API A",
      model: "model-a",
      successRate: 1,
      p95TotalMs: 500,
    },
    {
      type: "stability",
      profileId: "b",
      profileName: "API B",
      model: "model-b",
      successRate: 0.7,
      p95TotalMs: 5000,
    },
    {
      type: "scenario",
      results: [
        { profileId: "a", profileName: "API A", model: "model-a", successRate: 1, avgQualityScore: 90 },
        { profileId: "b", profileName: "API B", model: "model-b", successRate: 0.7, avgQualityScore: 50 },
      ],
    },
    {
      type: "admission",
      profileId: "a",
      profileName: "API A",
      model: "model-a",
      score: 92,
      successRate: 1,
      purityAssessment: { score: 88 },
      fingerprintSummary: { passRate: 1 },
      tokenAudit: { usageCoverage: 1 },
    },
    {
      type: "admission",
      profileId: "base-a",
      profileName: "Official A",
      profileRole: "baseline",
      model: "model-a",
      score: 90,
      successRate: 1,
      purityAssessment: { score: 95 },
      fingerprintSummary: { passRate: 1 },
      tokenAudit: { usageCoverage: 1 },
    },
    {
      type: "batch-admission",
      results: [
        {
          profileId: "c",
          profileName: "API C",
          model: "model-c",
          score: 86,
          successRate: 1,
          purityAssessment: { score: 80 },
          fingerprintSummary: { passRate: 0.75 },
          tokenAudit: { usageCoverage: 1 },
        },
      ],
    },
  ]);

  assert.equal(rows[0].profileName, "API A");
  assert.equal(rows[0].level, "pass");
  assert.equal(rows[0].purityScore, 88);
  assert.equal(rows[0].fingerprintRate, 1);
  assert.equal(rows.find((row) => row.profileName === "Official A").profileRole, "baseline");
  assert.equal(rows.find((row) => row.profileName === "API C").admissionRuns, 1);
  assert.equal(rows.find((row) => row.profileName === "API A").baselineProfileName, "Official A");
  assert.match(renderRankingList(rows), /模型 \/ 渠道排行榜|API A|综合分/);
  assert.match(renderRankingList(rows), /纯度|指纹|Token 覆盖|可信基线|相对可信基线/);

  const groups = buildModelComparisonGroups(rows);
  assert.equal(groups.find((group) => group.model === "model-a").candidateCount, 1);
  assert.equal(groups.find((group) => group.model === "model-a").baselineCount, 1);
  assert.match(renderModelComparisonList(groups), /API A|Official A|相对基线/);
});
