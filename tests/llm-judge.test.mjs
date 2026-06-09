import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateJudgeScores,
  judgeConsistency,
  krippendorffAlpha,
  randomizeAnswerPositions,
  sameFamilyConflict,
  selectEligibleJudges,
} from "../server/llm-judge.mjs";

const approx = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m}: expected ${b}±${tol}, got ${a}`);

test("krippendorffAlpha = 1 for perfect agreement", () => {
  const r = krippendorffAlpha([[5, 5], [3, 3], [4, 4]], { level: "interval" });
  assert.equal(r.alpha, 1);
});

test("krippendorffAlpha = 0 for a single maximally split unit (chance-level)", () => {
  const r = krippendorffAlpha([[1, 2]], { level: "interval" });
  approx(r.alpha, 0, 1e-9, "alpha");
});

test("krippendorffAlpha is high when judges mostly agree, low when they scatter", () => {
  const agree = krippendorffAlpha([[8, 8, 9], [3, 3, 4], [6, 6, 6]], { level: "interval" }).alpha;
  const scatter = krippendorffAlpha([[1, 9, 5], [2, 8, 4], [9, 1, 5]], { level: "interval" }).alpha;
  assert.ok(agree > 0.8, `agree should be high, got ${agree}`);
  assert.ok(scatter < agree, `scatter (${scatter}) should be lower than agree (${agree})`);
});

test("krippendorffAlpha nominal level handles category judgments", () => {
  const r = krippendorffAlpha([[1, 1], [0, 0], [1, 1]], { level: "nominal" });
  assert.equal(r.alpha, 1);
});

test("judgeConsistency flags needsHumanReview below threshold", () => {
  const reliable = judgeConsistency([[8, 8, 9], [3, 3, 4], [6, 6, 6]]);
  assert.equal(reliable.reliable, true);
  assert.equal(reliable.needsHumanReview, false);

  const shaky = judgeConsistency([[1, 9], [9, 1], [5, 1]]);
  assert.equal(shaky.needsHumanReview, true);
  assert.equal(shaky.reliable, false);
});

test("judgeConsistency reports insufficient data when no unit has >=2 ratings", () => {
  const r = judgeConsistency([[5], [3]]);
  assert.equal(r.alpha, null);
  assert.equal(r.needsHumanReview, true);
});

test("randomizeAnswerPositions is deterministic and reversible", () => {
  const items = ["A", "B", "C", "D"];
  const a = randomizeAnswerPositions(items, 123);
  const b = randomizeAnswerPositions(items, 123);
  assert.deepEqual(a.shuffled, b.shuffled, "same seed → same order");
  // revealMap 能把打乱后的位置还原回原始 index
  const restored = a.shuffled.map((value, pos) => ({ value, originalIndex: a.revealMap[pos] }));
  for (const r of restored) {
    assert.equal(items[r.originalIndex], r.value);
  }
  // 不同 seed 通常不同顺序
  const c = randomizeAnswerPositions(items, 999);
  assert.notDeepEqual(a.shuffled, c.shuffled);
});

test("sameFamilyConflict guards judge vs target of same family", () => {
  assert.equal(sameFamilyConflict("gpt-4o", "gpt-4o-mini"), true);
  assert.equal(sameFamilyConflict("claude-3-5-sonnet", "gpt-4o"), false);
  assert.equal(sameFamilyConflict("unknown-x", "gpt-4o"), false); // 家族未知不误判
});

test("selectEligibleJudges excludes same-family judges", () => {
  const { eligible, excluded } = selectEligibleJudges(
    ["gpt-4o", "claude-3-5-sonnet", "gemini-1.5-pro"],
    "gpt-4-turbo",
  );
  assert.deepEqual(excluded, ["gpt-4o"]);
  assert.deepEqual(eligible, ["claude-3-5-sonnet", "gemini-1.5-pro"]);
});

test("aggregateJudgeScores computes consensus, spread, and supports weights", () => {
  const equal = aggregateJudgeScores([{ judge: "a", score: 80 }, { judge: "b", score: 90 }, { judge: "c", score: 70 }]);
  assert.equal(equal.mean, 80);
  assert.equal(equal.consensus, 80);
  assert.equal(equal.min, 70);
  assert.equal(equal.max, 90);
  assert.equal(equal.weighted, false);

  const weighted = aggregateJudgeScores([{ judge: "a", score: 100, weight: 3 }, { judge: "b", score: 0, weight: 1 }]);
  assert.equal(weighted.weighted, true);
  assert.equal(weighted.consensus, 75); // (3*100 + 1*0)/4

  assert.equal(aggregateJudgeScores([]).consensus, null);
});
