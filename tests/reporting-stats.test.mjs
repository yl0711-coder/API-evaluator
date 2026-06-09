import assert from "node:assert/strict";
import test from "node:test";

import { buildStabilitySummary } from "../server/summaries.mjs";
import { formatBatchReport, formatStabilityReport } from "../server/reporting.mjs";

const profile = (id, name) => ({
  id,
  name,
  role: "target",
  provider: "mock",
  defaultModel: "mock-model",
  protocol: "openai_compatible",
  channelCode: "",
});

function makeRecords(successCount, total, { responseText = "这是一段大约二十多个字的正常中文回答，用于本地 token 估算。", outputTokens = 30 } = {}) {
  const records = [];
  for (let i = 0; i < total; i++) {
    const success = i < successCount;
    records.push({
      success,
      totalMs: success ? 1000 + i * 100 : null,
      firstByteMs: success ? 200 + i * 10 : null,
      outputChars: success ? 120 : 0,
      inputTokens: success ? 50 : null,
      outputTokens: success ? outputTokens : null,
      responseText: success ? responseText : "",
      normalizedError: success ? null : "upstream_5xx",
    });
  }
  return records;
}

function makeStabilitySummary(id, name, successCount, total) {
  const records = makeRecords(successCount, total);
  return buildStabilitySummary({
    runId: `run-${id}`,
    profile: profile(id, name),
    records,
    rounds: total,
    concurrency: 1,
    prompt: "ping",
    startedAt: new Date("2026-06-02T00:00:00Z"),
    endedAt: new Date("2026-06-02T00:01:00Z"),
  });
}

test("buildStabilitySummary attaches Wilson CI and P99", () => {
  const summary = makeStabilitySummary("a", "甲", 8, 10);
  assert.equal(summary.successRateCi.n, 10);
  assert.equal(summary.successRateCi.ratePercent, "80.0%");
  assert.ok(summary.successRateCi.ci95Lower > 0.45 && summary.successRateCi.ci95Lower < 0.55);
  assert.ok(summary.successRateCi.ci95Upper > 0.9 && summary.successRateCi.ci95Upper < 0.97);
  assert.ok(Number.isFinite(summary.p99TotalMs));
  assert.ok(summary.p99TotalMs >= summary.p95TotalMs);
});

test("stability report renders CI and P99 lines", () => {
  const summary = makeStabilitySummary("a", "甲", 8, 10);
  const report = formatStabilityReport(summary, makeRecords(8, 10));
  assert.match(report, /成功率 95% 置信区间/);
  assert.match(report, /尾部延迟 P99/);
  assert.ok(report.includes(summary.successRateCi.ci95Text));
});

function makeBatch(results) {
  return {
    batchId: "batch-1",
    profileCount: results.length,
    rounds: 10,
    maxParallelProfiles: 1,
    requestConcurrency: 1,
    startedAt: "2026-06-02T00:00:00Z",
    endedAt: "2026-06-02T00:05:00Z",
    durationMs: 300000,
    workspaceDir: "/tmp/x",
    rawJsonPath: "/tmp/x.json",
    results,
  };
}

test("batch report does NOT declare a winner when CIs overlap", () => {
  const batch = makeBatch([
    makeStabilitySummary("a", "甲", 8, 10),
    makeStabilitySummary("b", "乙", 6, 10),
  ]);
  const report = formatBatchReport(batch);
  assert.match(report, /差异不显著/);
  assert.match(report, /建议增加轮数/);
});

test("batch report declares a statistically distinguishable winner when CIs separate", () => {
  const batch = makeBatch([
    makeStabilitySummary("a", "甲", 10, 10),
    makeStabilitySummary("b", "乙", 2, 10),
  ]);
  const report = formatBatchReport(batch);
  assert.match(report, /统计上可区分/);
  assert.match(report, /甲 优于 乙/);
});

function makeInflatedSummary() {
  // 输出 token 报得远超本地估算 → PALACE 应判疑似灌水
  const records = makeRecords(10, 10, { responseText: "好。", outputTokens: 4000 });
  return buildStabilitySummary({
    runId: "run-inflated",
    profile: profile("z", "灌水渠道"),
    records,
    rounds: 10,
    concurrency: 1,
    prompt: "短",
    startedAt: new Date("2026-06-02T00:00:00Z"),
    endedAt: new Date("2026-06-02T00:01:00Z"),
  });
}

test("PALACE audit is wired into the stability summary and report", () => {
  const summary = makeStabilitySummary("a", "甲", 8, 10);
  assert.ok(summary.tokenAudit, "summary 应带 tokenAudit");
  assert.ok(Array.isArray(summary.tokenAuditFindings));
  const report = formatStabilityReport(summary, makeRecords(8, 10));
  assert.match(report, /计费审计（PALACE 粗筛）/);
});

test("PALACE flags systematic output inflation and surfaces it as a review finding", () => {
  const summary = makeInflatedSummary();
  assert.equal(summary.tokenAudit.suspicious, true);
  assert.ok(summary.tokenAuditFindings.length > 0);
  const report = formatStabilityReport(summary, makeRecords(10, 10, { responseText: "好。", outputTokens: 4000 }));
  assert.match(report, /疑似/); // 审计结论 + 复核块都会出现"疑似"
  assert.match(report, /需第二人签字/); // 高敏感结论触发复核
});
