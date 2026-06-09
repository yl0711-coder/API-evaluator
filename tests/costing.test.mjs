import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateUsage,
  estimateTokenCost,
  estimateTokenEconomics,
} from "../server/costing.mjs";

test("aggregateUsage sums each token field across records", () => {
  const records = [
    { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, reasoningTokens: 10 },
    { inputTokens: 200, outputTokens: 80, cacheCreationTokens: 30, cacheReadTokens: 5 },
  ];
  assert.deepEqual(aggregateUsage(records), {
    inputTokens: 300,
    outputTokens: 130,
    cacheCreationTokens: 30,
    cacheReadTokens: 25,
    reasoningTokens: 10,
  });
});

test("aggregateUsage returns null for fields never present (无数据 != 0)", () => {
  const records = [
    { inputTokens: 10, outputTokens: 5 },
    { inputTokens: 20, outputTokens: 7 },
  ];
  const totals = aggregateUsage(records);
  assert.equal(totals.inputTokens, 30);
  assert.equal(totals.cacheCreationTokens, null);
  assert.equal(totals.cacheReadTokens, null);
  assert.equal(totals.reasoningTokens, null);
});

test("aggregateUsage handles empty input", () => {
  const totals = aggregateUsage([]);
  assert.equal(totals.inputTokens, null);
  assert.equal(totals.outputTokens, null);
});

test("estimateTokenCost is unchanged by added cache/reasoning capture", () => {
  // 1M input @ $3, 1M output @ $15 -> 3 + 15 = 18 for 1M each
  const cost = estimateTokenCost({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    inputPricePerMTokens: 3,
    outputPricePerMTokens: 15,
  });
  assert.equal(cost, 18);
});

test("estimateTokenCost returns null when no prices are configured", () => {
  assert.equal(
    estimateTokenCost({ inputTokens: 1000, outputTokens: 1000 }),
    null,
  );
});

test("estimateTokenEconomics computes gross profit and margin", () => {
  const econ = estimateTokenEconomics({
    inputTokens: 1_000_000,
    outputTokens: 0,
    inputCostPerMTokens: 1,
    outputCostPerMTokens: 0,
    inputSellPricePerMTokens: 4,
    outputSellPricePerMTokens: 0,
  });
  assert.equal(econ.estimatedCost, 1);
  assert.equal(econ.estimatedRevenue, 4);
  assert.equal(econ.estimatedGrossProfit, 3);
  assert.equal(econ.estimatedGrossMargin, 0.75);
});
