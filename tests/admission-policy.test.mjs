// tests/admission-policy.test.mjs
// 阶段 1 完成标志：无需网络即可证明所有固定反例不会假通过（PRD §12.3 + 方案 §14.1）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CONCLUSION,
  ITEM_STATUS,
  STABILITY_SMOKE_TOTAL_ROUNDS,
  VERDICT,
  aggregateModel,
  aggregateSuite,
  computeAdmissionScore,
  evaluateAdmission,
  evaluateStability,
  pickSevereError,
  resolveGroupStatus,
  resolveItemStatus,
  validateStructuredJsonCase,
  validateWeatherToolCall,
} from "../server/admission-policy.mjs";

// ── validateStructuredJsonCase ────────────────────────────────────────────────

test("validateStructuredJsonCase: channelReady 为字符串 'false' → not_passed（ADM-012）", () => {
  assert.equal(validateStructuredJsonCase('{"channelReady":"false","modelType":"gpt-4","risk":"low"}').passed, false);
});

test("validateStructuredJsonCase: risk='critical' → not_passed", () => {
  assert.equal(validateStructuredJsonCase('{"channelReady":true,"modelType":"gpt-4","risk":"critical"}').passed, false);
});

test("validateStructuredJsonCase: modelType 为数字 → not_passed", () => {
  assert.equal(validateStructuredJsonCase('{"channelReady":true,"modelType":123,"risk":"low"}').passed, false);
});

test("validateStructuredJsonCase: Markdown 代码块包裹 → not_passed", () => {
  assert.equal(validateStructuredJsonCase('```json\n{"channelReady":true,"modelType":"gpt-4","risk":"low"}\n```').passed, false);
});

test("validateStructuredJsonCase: 合法纯 JSON → passed", () => {
  assert.equal(validateStructuredJsonCase('{"channelReady":true,"modelType":"gpt-4","risk":"low"}').passed, true);
});

// ── validateWeatherToolCall ───────────────────────────────────────────────────

test("validateWeatherToolCall: 工具名正确、arguments 为空对象 → not_passed（ADM-013）", () => {
  assert.equal(validateWeatherToolCall({ name: "get_weather", arguments: {} }).passed, false);
});

test("validateWeatherToolCall: 工具名正确、arguments 为空字符串 → not_passed", () => {
  assert.equal(validateWeatherToolCall({ name: "get_weather", arguments: "" }).passed, false);
});

test("validateWeatherToolCall: claude_messages 协议 object 形参、city=北京 → passed", () => {
  assert.equal(validateWeatherToolCall({ name: "get_weather", arguments: { city: "北京" } }).passed, true);
});

test("validateWeatherToolCall: OpenAI 协议 JSON 字符串形参、city=北京 → passed", () => {
  assert.equal(validateWeatherToolCall({ name: "get_weather", arguments: '{"city":"北京"}' }).passed, true);
});

// ── resolveItemStatus / resolveGroupStatus ────────────────────────────────────

test("resolveItemStatus: 用例不在列表中 → not_applicable（修 ADM-007，不赠分）", () => {
  assert.equal(resolveItemStatus([{ id: "connectivity", passed: true }], "coding_small"), ITEM_STATUS.NOT_APPLICABLE);
});

test("resolveGroupStatus: 空用例列表 → not_applicable（[].every()===true 的修复）", () => {
  assert.equal(resolveGroupStatus([], ["coding_small"]), ITEM_STATUS.NOT_APPLICABLE);
});

// ── computeAdmissionScore ─────────────────────────────────────────────────────

test("computeAdmissionScore: not_applicable 维度退出权重池，不拉低分数", () => {
  // toolCall 和 identity 均不适用时，其余全过 → 100 分
  const score = computeAdmissionScore({
    successRate: 1,
    passRate: 1,
    jsonStatus: ITEM_STATUS.PASSED,
    toolCallStatus: ITEM_STATUS.NOT_APPLICABLE,
    streamStatus: ITEM_STATUS.PASSED,
    identityStatus: ITEM_STATUS.NOT_APPLICABLE,
    tokenCoverage: 1,
  });
  assert.equal(score, 100);
});

// ── evaluateAdmission ─────────────────────────────────────────────────────────

test("evaluateAdmission: 综合分 95、工具调用硬门槛失败 → not_passed（修 ADM-008）", () => {
  const summary = {
    score: 95,
    grade: "A",
    successRate: 1,
    errorCounts: {},
    cases: [
      { id: "json_structure", passed: true },
      { id: "tool_call", passed: false },
      { id: "stream_structure", passed: true },
    ],
  };
  assert.equal(evaluateAdmission(summary).verdict, VERDICT.NOT_PASSED);
});

test("evaluateAdmission: null（runner 写盘失败）→ indeterminate，不是 rejected", () => {
  const v = evaluateAdmission(null);
  assert.equal(v.verdict, VERDICT.INDETERMINATE);
});

// ── evaluateStability ─────────────────────────────────────────────────────────

test(`evaluateStability: ${STABILITY_SMOKE_TOTAL_ROUNDS}/${STABILITY_SMOKE_TOTAL_ROUNDS} 最终成功、P95 8s、首次全成功 → passed`, () => {
  const v = evaluateStability({
    requestCount: STABILITY_SMOKE_TOTAL_ROUNDS,
    successRate: 1,
    p95TotalMs: 8000,
    errorCounts: {},
    firstAttemptSuccessRate: 1,
  });
  assert.equal(v.verdict, VERDICT.PASSED);
});

test(`evaluateStability: ${STABILITY_SMOKE_TOTAL_ROUNDS}/${STABILITY_SMOKE_TOTAL_ROUNDS} 最终成功、一次重试恢复 → warning（有条件）`, () => {
  const v = evaluateStability({
    requestCount: STABILITY_SMOKE_TOTAL_ROUNDS,
    successRate: 1,
    p95TotalMs: 8000,
    errorCounts: {},
    firstAttemptSuccessRate: (STABILITY_SMOKE_TOTAL_ROUNDS - 1) / STABILITY_SMOKE_TOTAL_ROUNDS,
  });
  assert.equal(v.verdict, VERDICT.WARNING);
});

test(`evaluateStability: ${STABILITY_SMOKE_TOTAL_ROUNDS - 1}/${STABILITY_SMOKE_TOTAL_ROUNDS} 最终成功 → not_passed`, () => {
  const v = evaluateStability({
    requestCount: STABILITY_SMOKE_TOTAL_ROUNDS,
    successRate: (STABILITY_SMOKE_TOTAL_ROUNDS - 1) / STABILITY_SMOKE_TOTAL_ROUNDS,
    p95TotalMs: 8000,
    errorCounts: {},
    firstAttemptSuccessRate: null,
  });
  assert.equal(v.verdict, VERDICT.NOT_PASSED);
});

test("evaluateStability: null（runner 写盘失败）→ indeterminate", () => {
  assert.equal(evaluateStability(null).verdict, VERDICT.INDETERMINATE);
});

// ── pickSevereError ───────────────────────────────────────────────────────────

test("pickSevereError: auth_failed + upstream_5xx 同时出现 → 始终优先 auth_failed，不受键序影响（修 ADM-018）", () => {
  assert.equal(pickSevereError({ auth_failed: 1, upstream_5xx: 2 }), "auth_failed");
  assert.equal(pickSevereError({ upstream_5xx: 2, auth_failed: 1 }), "auth_failed");
});

// ── aggregateModel / aggregateSuite ───────────────────────────────────────────

test("aggregateModel: 存在 not_passed 步骤 → rejected", () => {
  const r = aggregateModel([
    { verdict: VERDICT.PASSED, blocking: true, summary: "ok" },
    { verdict: VERDICT.NOT_PASSED, blocking: true, summary: "failed" },
  ]);
  assert.equal(r.conclusion, CONCLUSION.REJECTED);
});

test("aggregateModel: 存在 indeterminate 步骤 → indeterminate（平台异常不等于渠道不行）", () => {
  const r = aggregateModel([
    { verdict: VERDICT.PASSED, blocking: true, summary: "ok" },
    { verdict: VERDICT.INDETERMINATE, blocking: true, summary: "no data" },
  ]);
  assert.equal(r.conclusion, CONCLUSION.INDETERMINATE);
});

test("aggregateSuite: 模型 A 通过、模型 B 失败 → 整体 rejected（修 ADM-006）", () => {
  const r = aggregateSuite([
    { model: "model-a", conclusion: CONCLUSION.ACCEPTED },
    { model: "model-b", conclusion: CONCLUSION.REJECTED },
  ]);
  assert.equal(r.conclusion, CONCLUSION.REJECTED);
});

test("aggregateSuite: rejected 压过 indeterminate", () => {
  const r = aggregateSuite([
    { model: "model-a", conclusion: CONCLUSION.REJECTED },
    { model: "model-b", conclusion: CONCLUSION.INDETERMINATE },
  ]);
  assert.equal(r.conclusion, CONCLUSION.REJECTED);
});
