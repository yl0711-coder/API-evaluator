import { test } from "node:test";
import assert from "node:assert/strict";
import { auditTokenizerFingerprint, resolveBaselineModel, __setBaselineForTest } from "../server/tokenizer-fingerprint-audit.mjs";

// 两代基线（数值取自真实实测的几条探针）。
const DOC = {
  schema: "claude-token-baseline/v2",
  mode: "chat",
  sourceOfficial: false,
  baselines: [
    { model: "claude-opus-4-8", probes: [
      { id: "p01", inputTokens: 65 }, { id: "p02", inputTokens: 137 }, { id: "p03", inputTokens: 60 },
      { id: "p04", inputTokens: 182 }, { id: "p09", inputTokens: 67 }, { id: "p13", inputTokens: 92 },
    ] },
    { model: "claude-opus-4-6", probes: [
      { id: "p01", inputTokens: 44 }, { id: "p02", inputTokens: 92 }, { id: "p03", inputTokens: 53 },
      { id: "p04", inputTokens: 173 }, { id: "p09", inputTokens: 60 }, { id: "p13", inputTokens: 52 },
    ] },
  ],
};

function probesFrom(model, fn) {
  const entry = DOC.baselines.find((b) => b.model === model);
  return entry.probes.map((p) => ({ id: p.id, reportedTokens: fn(p.inputTokens) }));
}

test("真后端：reported = base + 固定开销 → slope≈1, R²≈1, 判一致", () => {
  __setBaselineForTest(DOC);
  const points = probesFrom("claude-opus-4-8", (b) => b + 7); // 同分词器，仅模板开销差
  const r = auditTokenizerFingerprint({ model: "claude-opus-4-8", points });
  assert.equal(r.applicable, true);
  assert.equal(r.status, "consistent");
  assert.equal(r.baselineModel, "claude-opus-4-8");
  assert.ok(Math.abs(r.slope - 1) <= 0.05, `slope=${r.slope}`);
  assert.ok(r.r2 >= 0.995, `r2=${r.r2}`);
});

test("冒牌后端：reported ≈ 0.58·base → slope 远离 1, 判 mismatch", () => {
  __setBaselineForTest(DOC);
  const points = probesFrom("claude-opus-4-8", (b) => Math.round(b * 0.58));
  const r = auditTokenizerFingerprint({ model: "claude-opus-4-8", points });
  assert.equal(r.applicable, true);
  assert.equal(r.status, "mismatch");
  assert.equal(r.suspicious, true);
  assert.ok(r.slope < 0.85, `slope=${r.slope}`);
});

test("按代匹配：opus-4-7 无精确基线 → 落到 opus-4-8（同代）", () => {
  __setBaselineForTest(DOC);
  assert.equal(resolveBaselineModel("claude-opus-4-7"), "claude-opus-4-8");
  assert.equal(resolveBaselineModel("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(resolveBaselineModel("claude-sonnet-4-6"), "claude-opus-4-6"); // 同代 g-46（按代回落到该代某基线）
});

test("未知代（sonnet-4-5）：无可信基线 → applicable:false", () => {
  __setBaselineForTest(DOC);
  assert.equal(resolveBaselineModel("claude-sonnet-4-5"), null);
  const r = auditTokenizerFingerprint({ model: "claude-sonnet-4-5", points: [] });
  assert.equal(r.applicable, false);
});

test("有效探针不足 3 个 → applicable:false", () => {
  __setBaselineForTest(DOC);
  const r = auditTokenizerFingerprint({ model: "claude-opus-4-8", points: [{ id: "p01", reportedTokens: 70 }] });
  assert.equal(r.applicable, false);
});

test("没有基线文件 → applicable:false（优雅降级）", () => {
  __setBaselineForTest(null);
  const r = auditTokenizerFingerprint({ model: "claude-opus-4-8", points: probesFrom("claude-opus-4-8", (b) => b + 1) });
  assert.equal(r.applicable, false);
});
