import assert from "node:assert/strict";
import test from "node:test";
import { buildScenarioProfileSummary } from "../server/summaries.mjs";

const profile = {
  id: "t1",
  name: "被测渠道",
  defaultModel: "claude-sonnet-4-5",
  role: "target",
  inputPricePerMTokens: 3,
  outputPricePerMTokens: 15,
};

function scenarioRecord(over = {}) {
  return {
    success: true,
    statusCode: 200,
    totalMs: 800,
    firstByteMs: 100,
    outputChars: 200,
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    responseText: "答案",
    scenarioId: "s1",
    scenarioName: "场景1",
    category: "general",
    difficulty: "medium",
    repeat: 1,
    quality: { score: 80, issues: [] },
    ...over,
  };
}

test("scenario summary records actual consumption: target only (no judge)", () => {
  const summary = buildScenarioProfileSummary(profile, [scenarioRecord(), scenarioRecord()]);
  // 目标：输入 2M、输出 0.4M → 2*3 + 0.4*15 = 6 + 6 = 12
  assert.equal(summary.actualConsumption.target.cost, 12);
  assert.equal(summary.actualConsumption.judge, null);
  assert.equal(summary.actualConsumption.totalCost, 12);
});

test("scenario summary folds judge consumption into total actual cost", () => {
  const judgeAudit = {
    mode: "audit",
    ok: true,
    judgeConsumption: { calls: 4, inputTokens: 500_000, outputTokens: 100_000, cost: 5 },
  };
  const summary = buildScenarioProfileSummary(profile, [scenarioRecord(), scenarioRecord()], { judgeAudit });
  assert.equal(summary.actualConsumption.target.cost, 12);
  assert.equal(summary.actualConsumption.judge.cost, 5);
  assert.equal(summary.actualConsumption.judge.calls, 4);
  assert.equal(summary.actualConsumption.totalCost, 17); // 12 + 5
  assert.equal(summary.judgeAudit.judgeConsumption.cost, 5);
});

test("scenario summary leaves totalCost null when no prices are configured", () => {
  const noPrice = { ...profile, inputPricePerMTokens: null, outputPricePerMTokens: null };
  const summary = buildScenarioProfileSummary(noPrice, [scenarioRecord()]);
  assert.equal(summary.actualConsumption.target.cost, null);
  assert.equal(summary.actualConsumption.totalCost, null);
});
