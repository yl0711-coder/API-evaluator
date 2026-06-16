import assert from "node:assert/strict";
import test from "node:test";

import { lookupModelPrice, listModelPrices } from "../server/model-prices.mjs";

test("lookupModelPrice matches OpenAI and Claude models, tolerant to . - separators", () => {
  assert.deepEqual(
    { i: lookupModelPrice("gpt-5.5").inputPricePerMTokens, o: lookupModelPrice("gpt-5.5").outputPricePerMTokens },
    { i: 5, o: 30 },
  );
  assert.equal(lookupModelPrice("gpt-5.4-mini").outputPricePerMTokens, 4.5);
  assert.equal(lookupModelPrice("claude-opus-4-8").outputPricePerMTokens, 25);
  assert.equal(lookupModelPrice("claude-opus-4.8").inputPricePerMTokens, 5); // 点分隔也认
  assert.equal(lookupModelPrice("claude-sonnet-4-6").outputPricePerMTokens, 15);
  assert.equal(lookupModelPrice("claude-haiku-3-5").inputPricePerMTokens, 0.8);
});

test("more specific variants win over base (mini/pro, opus-4-8 vs bare opus-4)", () => {
  assert.equal(lookupModelPrice("gpt-5.5-pro").outputPricePerMTokens, 180);
  assert.notEqual(lookupModelPrice("gpt-5.5-pro").outputPricePerMTokens, 30);
  assert.equal(lookupModelPrice("claude-opus-4-8").inputPricePerMTokens, 5);
  assert.equal(lookupModelPrice("claude-opus-4").inputPricePerMTokens, 15); // 裸 opus-4（退役价）
});

test("lookupModelPrice returns null for unknown / empty model", () => {
  assert.equal(lookupModelPrice("demo-model"), null);
  assert.equal(lookupModelPrice(""), null);
  assert.equal(lookupModelPrice(undefined), null);
});

test("listModelPrices returns the full catalog with input/output prices", () => {
  const all = listModelPrices();
  assert.ok(all.length >= 10);
  assert.ok(
    all.every((entry) => entry.id && Number.isFinite(entry.inputPricePerMTokens) && Number.isFinite(entry.outputPricePerMTokens)),
  );
});
