import assert from "node:assert/strict";
import test from "node:test";

import {
  auditModelSubstitution,
  cramerVonMisesW2,
  empiricalRankPercentile,
  estimateRutCallBudget,
  ksTestUniform,
  rutBudgetGuard,
  rutUniformityTest,
} from "../server/rut-auditor.mjs";

const approx = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m}: expected ${b}±${tol}, got ${a}`);

test("empiricalRankPercentile places a value within a baseline distribution", () => {
  const base = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  approx(empiricalRankPercentile(10, base), 0.05, 1e-9, "lowest");
  approx(empiricalRankPercentile(100, base), 0.95, 1e-9, "highest");
  approx(empiricalRankPercentile(55, base), 0.5, 1e-9, "middle");
  assert.equal(empiricalRankPercentile(1000, base), 1); // above all
  assert.equal(empiricalRankPercentile(5, []), null); // no baseline
});

test("ksTestUniform gives high p for evenly spread percentiles", () => {
  const spread = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
  const r = ksTestUniform(spread);
  assert.ok(r.pValue > 0.5, `evenly spread should look uniform, p=${r.pValue}`);
});

test("ksTestUniform gives tiny p for clustered percentiles", () => {
  const clustered = Array.from({ length: 12 }, () => 0.97);
  const r = ksTestUniform(clustered);
  assert.ok(r.pValue < 0.05, `clustered should reject uniform, p=${r.pValue}`);
});

test("cramerVonMisesW2 is small for uniform, large for clustered", () => {
  const spread = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
  const clustered = Array.from({ length: 10 }, () => 0.95);
  assert.ok(cramerVonMisesW2(spread) < cramerVonMisesW2(clustered));
});

test("rutUniformityTest: no substitution evidence when ranks are uniform", () => {
  const spread = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
  const r = rutUniformityTest(spread);
  assert.equal(r.suspected, false);
  assert.match(r.verdict, /未见替换证据/);
  assert.equal(r.confidence, "low");
});

test("rutUniformityTest: flags suspected substitution when ranks cluster at an extreme", () => {
  const clustered = Array.from({ length: 15 }, () => 0.98);
  const r = rutUniformityTest(clustered);
  assert.equal(r.suspected, true);
  assert.match(r.verdict, /疑似/);
  assert.ok(r.caveat.includes("盲区")); // 量化降级盲区诚实声明
});

test("rutUniformityTest reports insufficient sample below n=3", () => {
  const r = rutUniformityTest([0.5, 0.5]);
  assert.equal(r.suspected, false);
  assert.match(r.verdict, /样本不足/);
});

test("auditModelSubstitution: target drawn like baseline → not suspected", () => {
  const base = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  // 目标值在基线里秩百分位均匀分布 → 像同一分布
  const target = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const baselinePerPrompt = target.map(() => base);
  const r = auditModelSubstitution({ targetValues: target, baselineSamplesPerPrompt: baselinePerPrompt });
  assert.equal(r.suspected, false);
  assert.equal(r.promptsUsed, 10);
});

test("auditModelSubstitution: target far above baseline → suspected substitution", () => {
  const base = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const target = Array.from({ length: 12 }, () => 9999); // 远超基线
  const baselinePerPrompt = target.map(() => base);
  const r = auditModelSubstitution({ targetValues: target, baselineSamplesPerPrompt: baselinePerPrompt });
  assert.equal(r.suspected, true);
  assert.match(r.verdict, /疑似/);
});

test("estimateRutCallBudget and rutBudgetGuard enforce the high-call ceiling", () => {
  const budget = estimateRutCallBudget(100, 100);
  assert.equal(budget.targetCalls, 100);
  assert.equal(budget.baselineCalls, 10000);
  assert.equal(budget.totalCalls, 10100);

  const blocked = rutBudgetGuard(100, 100, { maxCalls: 2000 });
  assert.equal(blocked.withinBudget, false);
  assert.equal(blocked.allowed, false);

  const highTier = rutBudgetGuard(100, 100, { maxCalls: 2000, allowHighTier: true });
  assert.equal(highTier.allowed, true);

  const small = rutBudgetGuard(20, 50, { maxCalls: 2000 });
  assert.equal(small.totalCalls, 1020);
  assert.equal(small.allowed, true);
});
