import assert from "node:assert/strict";
import test from "node:test";

import { buildQuickVerifyVerdict } from "../server/test-runner.mjs";

const OK_BASE = {
  records: [{ caseId: "connectivity", success: true }],
  identityCheck: { status: "aligned", expectedFamily: "openai", reportedFamily: "openai" },
  fingerprintSummary: { totalCount: 4, passRate: 1, passRateText: "100%" },
  absoluteTokenAudit: { applicable: true, status: "consistent", flags: [] },
  fingerprintTracking: { tokenHonesty: { status: "consistent_with_baseline" } },
};

test("quick-verify 判定：全部正常 → ok", () => {
  const v = buildQuickVerifyVerdict(OK_BASE);
  assert.equal(v.level, "ok");
  assert.equal(v.reasons.length, 0);
});

test("quick-verify 判定：标称冲突 → suspect", () => {
  const v = buildQuickVerifyVerdict({ ...OK_BASE, identityCheck: { status: "conflict", expectedFamily: "claude", reportedFamily: "openai" } });
  assert.equal(v.level, "suspect");
  assert.ok(v.reasons.some((r) => /标称冲突/.test(r)));
});

test("quick-verify 判定：官方分词器测出虚报 → suspect + 量化", () => {
  const v = buildQuickVerifyVerdict({
    ...OK_BASE,
    absoluteTokenAudit: { applicable: true, status: "inflation", estimatedInflationPct: 30, flags: [] },
  });
  assert.equal(v.level, "suspect");
  assert.ok(v.reasons.some((r) => /虚报约 30%/.test(r)));
});

test("quick-verify 判定：tokenizer 家族不符 → suspect", () => {
  const v = buildQuickVerifyVerdict({
    ...OK_BASE,
    absoluteTokenAudit: { applicable: true, status: "consistent", flags: [{ code: "tokenizer_family_mismatch", note: "x" }] },
  });
  assert.equal(v.level, "suspect");
});

test("quick-verify 判定：连通失败 → suspect", () => {
  const v = buildQuickVerifyVerdict({ records: [{ caseId: "connectivity", success: false, normalizedError: "auth_failed" }] });
  assert.equal(v.level, "suspect");
  assert.ok(v.reasons.some((r) => /连通失败/.test(r)));
});

test("quick-verify 判定：仅身份未知 → watch", () => {
  const v = buildQuickVerifyVerdict({ ...OK_BASE, identityCheck: { status: "unknown" } });
  assert.equal(v.level, "watch");
});

test("quick-verify 判定：横向 token 诚实度疑似虚报(无官方分词器) → suspect", () => {
  const v = buildQuickVerifyVerdict({
    ...OK_BASE,
    absoluteTokenAudit: { applicable: false },
    fingerprintTracking: { tokenHonesty: { status: "suspected_inflation", verdict: "疑似按 ×1.3 计费" } },
  });
  assert.equal(v.level, "suspect");
});
