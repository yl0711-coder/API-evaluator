import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAiAnalysisResult,
  buildAiReportAnalysisPrompt,
  isAiReportAnalysisEnabled,
} from "../server/ai-report-analysis.mjs";

test("AI report analysis prompt uses compact sanitized report data", () => {
  const prompt = buildAiReportAnalysisPrompt({
    reportType: "stability",
    summary: {
      profileName: "Demo API",
      provider: "ExampleVendor",
      model: "demo-model",
      protocol: "openai_compatible",
      rounds: 3,
      successRateText: "67%",
      successCount: 2,
      failureCount: 1,
      p95TotalMs: 42000,
      errorCounts: { timeout: 1 },
      diagnostics: [{ code: "timeout", count: 1, title: "请求超时", action: "调大超时或换时段复测。" }],
      apiKey: "sk-should-not-appear",
    },
  });

  assert.match(prompt, /脱敏测试摘要 JSON/);
  assert.match(prompt, /## 结论/);
  assert.match(prompt, /Demo API/);
  assert.match(prompt, /请求超时/);
  assert.equal(prompt.includes("sk-should-not-appear"), false);
  assert.equal(prompt.includes("apiKey"), false);
});

test("AI report analysis flag accepts browser checkbox values", () => {
  assert.equal(isAiReportAnalysisEnabled("1"), true);
  assert.equal(isAiReportAnalysisEnabled("on"), true);
  assert.equal(isAiReportAnalysisEnabled(true), true);
  assert.equal(isAiReportAnalysisEnabled(""), false);
  assert.equal(isAiReportAnalysisEnabled(undefined), false);
});

test("AI report analysis result keeps usage and failure details", () => {
  assert.deepEqual(buildAiAnalysisResult({
    success: true,
    responseText: "分析结果",
    requestId: "req-1",
    inputTokens: 10,
    outputTokens: 20,
  }), {
    enabled: true,
    success: true,
    text: "分析结果",
    requestId: "req-1",
    inputTokens: 10,
    outputTokens: 20,
  });

  const failed = buildAiAnalysisResult({
    success: false,
    normalizedError: "timeout",
    requestId: "req-2",
  });
  assert.equal(failed.success, false);
  assert.equal(failed.error, "timeout");
  assert.equal(failed.requestId, "req-2");
});
