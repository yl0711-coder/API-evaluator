import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapCI,
  compareProportions,
  mcnemarTest,
  normalCdf,
  pairedTTest,
  proportionReport,
  studentTwoSidedP,
  wilcoxonSignedRank,
  wilsonInterval,
} from "../server/stats.mjs";

const approx = (actual, expected, tol, message) => {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${message || "approx"}: expected ${expected} ± ${tol}, got ${actual}`,
  );
};

test("normalCdf matches known standard-normal values", () => {
  approx(normalCdf(0), 0.5, 1e-6, "Phi(0)");
  approx(normalCdf(1.959963984540054), 0.975, 1e-4, "Phi(z_0.975)");
  approx(normalCdf(-1.959963984540054), 0.025, 1e-4, "Phi(-z_0.975)");
});

test("wilsonInterval reproduces the textbook 8/10 interval", () => {
  const ci = wilsonInterval(8, 10);
  assert.equal(ci.n, 10);
  assert.equal(ci.successes, 8);
  approx(ci.point, 0.8, 1e-9, "point");
  approx(ci.lower, 0.4902, 5e-3, "lower");
  approx(ci.upper, 0.9433, 5e-3, "upper");
});

test("wilsonInterval does not collapse at boundaries and handles empty", () => {
  const perfect = wilsonInterval(10, 10);
  assert.ok(perfect.lower > 0 && perfect.lower < 1, "10/10 lower bound must be < 1");
  approx(perfect.upper, 1, 1e-9, "10/10 upper bound ≈ 1");

  const zero = wilsonInterval(0, 10);
  assert.equal(zero.lower, 0);
  assert.ok(zero.upper > 0, "0/10 upper bound must be > 0");

  const empty = wilsonInterval(0, 0);
  assert.equal(empty.point, null);
  assert.equal(empty.n, 0);
});

test("proportionReport renders sample size and CI text", () => {
  const r = proportionReport(8, 10);
  assert.equal(r.n, 10);
  assert.equal(r.ratePercent, "80.0%");
  assert.match(r.ci95Text, /^\[\d+\.\d%, \d+\.\d%\]$/);
  assert.equal(proportionReport(0, 0).ci95Text, "样本不足");
});

test("bootstrapCI is reproducible under a fixed seed and brackets the mean", () => {
  const data = [1, 2, 3, 4, 5];
  const a = bootstrapCI(data, { seed: 42, resamples: 1000 });
  const b = bootstrapCI(data, { seed: 42, resamples: 1000 });
  assert.equal(a.point, 3);
  assert.deepEqual([a.lower, a.upper], [b.lower, b.upper], "same seed must give identical interval");
  assert.ok(a.lower < 3 && a.upper > 3, "interval should bracket the mean");
});

test("bootstrapCI determinism holds on continuous data across repeated calls", () => {
  const data = [12.3, 8.1, 15.7, 9.9, 11.2, 14.0, 7.5, 10.8, 13.1, 9.0];
  const a = bootstrapCI(data, { seed: 7, resamples: 2000 });
  const b = bootstrapCI(data, { seed: 7, resamples: 2000 });
  assert.deepEqual([a.lower, a.upper], [b.lower, b.upper]);
  assert.ok(a.lower < a.point && a.point < a.upper, "interval should bracket the point estimate");
});

test("bootstrapCI handles empty and single-value inputs", () => {
  assert.equal(bootstrapCI([]).point, null);
  const one = bootstrapCI([7]);
  assert.equal(one.point, 7);
  assert.equal(one.lower, 7);
  assert.equal(one.upper, 7);
});

test("mcnemarTest exact binomial matches hand calculation (b=1,c=9)", () => {
  const r = mcnemarTest(1, 9);
  assert.equal(r.method, "exact-binomial");
  // 2 * (C(10,0)+C(10,1)) / 2^10 = 2 * 11/1024
  approx(r.pValue, 0.021484375, 1e-6, "exact p");
  assert.equal(r.discordant, 10);
});

test("mcnemarTest switches to continuity-corrected chi-square for large samples", () => {
  const r = mcnemarTest(40, 10);
  assert.equal(r.method, "chi-square-continuity");
  // chi2 = (|40-10|-1)^2 / 50 = 29^2/50 = 16.82 -> tiny p
  approx(r.statistic, 16.82, 1e-2, "chi2");
  assert.ok(r.pValue < 0.001, "large discordance should be significant");
});

test("mcnemarTest returns p=1 when there are no discordant pairs", () => {
  assert.equal(mcnemarTest(0, 0).pValue, 1);
});

test("pairedTTest matches known t and two-sided p (diffs 1,2,3)", () => {
  const r = pairedTTest([2, 4, 6], [1, 2, 3]);
  approx(r.meanDiff, 2, 1e-9, "meanDiff");
  approx(r.t, 3.4641016, 1e-4, "t");
  assert.equal(r.df, 2);
  approx(r.pValue, 0.07418, 1e-3, "two-sided p");
});

test("pairedTTest reports p=1 for identical paired samples", () => {
  const r = pairedTTest([1, 2, 3, 4], [1, 2, 3, 4]);
  assert.equal(r.meanDiff, 0);
  assert.equal(r.pValue, 1);
});

test("studentTwoSidedP edge: t=0 gives p=1", () => {
  assert.equal(studentTwoSidedP(0, 5), 1);
});

test("wilcoxonSignedRank flags a monotone positive shift", () => {
  const r = wilcoxonSignedRank([1, 2, 3, 4, 5], [0, 0, 0, 0, 0]);
  assert.equal(r.wMinus, 0);
  assert.equal(r.wPlus, 15);
  // normal approx with continuity: z = (7.5-0.5)/sqrt(13.75) ≈ 1.8878 -> p ≈ 0.059
  approx(r.pValue, 0.059, 1e-2, "p");
  assert.match(r.method, /小样本/);
});

test("wilcoxonSignedRank drops zero differences and handles all-zero", () => {
  const allZero = wilcoxonSignedRank([3, 3, 3], [3, 3, 3]);
  assert.equal(allZero.n, 0);
  assert.equal(allZero.pValue, 1);
});

test("compareProportions does not declare a winner when CIs overlap", () => {
  const close = compareProportions(6, 10, 5, 10);
  assert.equal(close.significant, false);
  assert.equal(close.verdict, "差异不显著");

  const clear = compareProportions(9, 10, 2, 10, { labelA: "甲", labelB: "乙" });
  assert.equal(clear.significant, true);
  assert.equal(clear.verdict, "甲 优于 乙");
});

test("compareProportions reports insufficient sample when a side is empty", () => {
  const r = compareProportions(0, 0, 5, 10);
  assert.equal(r.significant, false);
  assert.equal(r.verdict, "样本不足");
});
