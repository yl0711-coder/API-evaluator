import assert from "node:assert/strict";
import test from "node:test";

test("scenario registry excludes safety scenarios by default (opt-in)", async () => {
  delete process.env.EVALUATOR_ENABLE_SAFETY_SCENARIOS;
  const { TEST_SCENARIOS } = await import(`../server/scenarios/index.mjs?case=default-${Date.now()}`);

  assert.equal(TEST_SCENARIOS.some((scenario) => scenario.category === "safety"), false);
  assert.ok(TEST_SCENARIOS.some((scenario) => scenario.category === "coding"));
});

test("scenario registry enables safety scenarios when explicitly turned on", async () => {
  process.env.EVALUATOR_ENABLE_SAFETY_SCENARIOS = "1";
  try {
    const { TEST_SCENARIOS } = await import(`../server/scenarios/index.mjs?case=enabled-${Date.now()}`);
    assert.ok(TEST_SCENARIOS.some((scenario) => scenario.category === "safety"));
    assert.ok(TEST_SCENARIOS.some((scenario) => scenario.category === "coding"));
  } finally {
    delete process.env.EVALUATOR_ENABLE_SAFETY_SCENARIOS;
  }
});
