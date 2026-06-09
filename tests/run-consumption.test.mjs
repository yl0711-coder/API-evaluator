import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildRunConsumption } from "../server/costing.mjs";

const PROFILE = { inputPricePerMTokens: "3", outputPricePerMTokens: "15" };

test("buildRunConsumption 汇总真实消耗(含 reasoning/cache)并按单价估成本", () => {
  const records = [
    { inputTokens: 1000, outputTokens: 500, reasoningTokens: 200, cacheCreationTokens: 100, cacheReadTokens: 50 },
    { inputTokens: 2000, outputTokens: 1000, reasoningTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 400 },
    { inputTokens: null, outputTokens: null }, // 无 usage → 不计入 billedRequests
  ];
  const c = buildRunConsumption(PROFILE, records);
  assert.equal(c.inputTokens, 3000);
  assert.equal(c.outputTokens, 1500);
  assert.equal(c.totalTokens, 4500);
  assert.equal(c.reasoningTokens, 200);
  assert.equal(c.cacheCreationTokens, 100);
  assert.equal(c.cacheReadTokens, 450);
  assert.equal(c.billedRequests, 2);
  // 成本 = 3000/1e6*3 + 1500/1e6*15 = 0.009 + 0.0225 = 0.0315
  assert.equal(c.estimatedCost, 0.0315);
  assert.equal(c.hasPrices, true);
});

test("buildRunConsumption 未配单价 → 只统计 token，成本为 null", () => {
  const c = buildRunConsumption({}, [{ inputTokens: 100, outputTokens: 50 }]);
  assert.equal(c.totalTokens, 150);
  assert.equal(c.estimatedCost, null);
  assert.equal(c.hasPrices, false);
});

test("buildRunConsumption 全程无 usage → token 为 null（区分无数据 vs 真实为0）", () => {
  const c = buildRunConsumption(PROFILE, [{ inputTokens: null, outputTokens: null }]);
  assert.equal(c.inputTokens, null);
  assert.equal(c.outputTokens, null);
  assert.equal(c.totalTokens, null);
  assert.equal(c.billedRequests, 0);
});

test("spend_ledger 往返 + querySpendSummary 累计", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "spend-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  try {
    const db = await import(`../server/db.mjs?case=${Date.now()}`);
    if (!(await db.isSqliteAvailable())) return;
    await db.recordSpend({ runId: "r1", estimated: 0.02, actual: 0.0315, currency: "USD", createdAt: new Date().toISOString() });
    await db.recordSpend({ runId: "r2", estimated: 0.01, actual: 0.005, currency: "USD", createdAt: new Date().toISOString() });
    const s = await db.querySpendSummary({});
    assert.equal(s.runs, 2);
    assert.equal(Math.round(s.totalActualCost * 10000) / 10000, 0.0365); // 0.0315 + 0.005
    assert.equal(Math.round(s.totalEstimatedCost * 10000) / 10000, 0.03); // 0.02 + 0.01
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  }
});
