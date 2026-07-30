import assert from "node:assert/strict";
import test from "node:test";

import { normalizeQuickVerifyResult } from "../src/standard-eval-controller.js";

// 标准评测第①步"快速测试"改调 /api/tests/quick-verify（与高级测试里的"快速测试"页同一个接口）后，
// 返回形状从旧版 /api/tests/quick 的单请求 {success,statusCode,totalMs,responseSummary} 变成了一整套
// 快检汇总（cases[]/verdict/successRate...）。这里锁定 normalizeQuickVerifyResult 的映射规则，防止
// 以后改字段名却没同步这层适配，导致标准评测把「指纹探针小问题」误判成「连不通」。
test("normalizeQuickVerifyResult：连通探针通过 → success=true，不因标称冲突之类的次要异常拦截", () => {
  const result = {
    successRate: 0.8,
    avgTotalMs: 120,
    verdict: { title: "观察：有需留意项", reasons: ["模型未能明确自述身份"] },
    cases: [{ id: "connectivity", passed: true, statusCode: 200, totalMs: 90, issue: "连通正常。" }],
  };
  const quick = normalizeQuickVerifyResult(result);
  assert.equal(quick.success, true);
  assert.equal(quick.statusCode, 200);
  assert.equal(quick.totalMs, 90);
  assert.equal(quick.normalizedError, null);
});

test("normalizeQuickVerifyResult：连通探针失败 → success=false，带上失败原因", () => {
  const result = {
    successRate: 0,
    verdict: { title: "可疑：建议人工复核", reasons: ["连通失败：auth_failed"] },
    cases: [{ id: "connectivity", passed: false, statusCode: 401, totalMs: 50, issue: "认证失败。" }],
  };
  const quick = normalizeQuickVerifyResult(result);
  assert.equal(quick.success, false);
  assert.equal(quick.statusCode, 401);
  assert.equal(quick.normalizedError, "认证失败。");
});

test("normalizeQuickVerifyResult：没有 connectivity 分项时按 successRate 兜底判定", () => {
  assert.equal(normalizeQuickVerifyResult({ successRate: 1, cases: [] }).success, true);
  assert.equal(normalizeQuickVerifyResult({ successRate: 0, cases: [] }).success, false);
  assert.equal(normalizeQuickVerifyResult(null).success, false);
});
