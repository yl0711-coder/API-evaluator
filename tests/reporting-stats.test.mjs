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

function makeRecords(
  successCount,
  total,
  { responseText = "这是一段大约二十多个字的正常中文回答，用于本地 token 估算。", outputTokens = 30 } = {},
) {
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

// 回归：高级设置里手填的温度被传输层摘掉时，汇总必须留痕（界面据此出提示卡）。
// 摘掉工具自己的默认温度不该置位——那是内部自愈，提示会变成噪音。
test("buildStabilitySummary 统计「手填温度被摘掉」的请求数", () => {
  const records = makeRecords(10, 10);
  records[0].temperatureStripped = true;
  records[3].temperatureStripped = true;
  const summary = buildStabilitySummary({
    runId: "run-temp",
    profile: profile("t", "温度"),
    records,
    rounds: 10,
    concurrency: 1,
    prompt: "ping",
    startedAt: new Date("2026-06-02T00:00:00Z"),
    endedAt: new Date("2026-06-02T00:01:00Z"),
  });
  assert.equal(summary.temperatureStrippedCount, 2);
  assert.equal(makeStabilitySummary("a", "甲", 10, 10).temperatureStrippedCount, 0);
});

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
  const batch = makeBatch([makeStabilitySummary("a", "甲", 8, 10), makeStabilitySummary("b", "乙", 6, 10)]);
  const report = formatBatchReport(batch);
  assert.match(report, /差异不显著/);
  assert.match(report, /建议增加轮数/);
});

test("batch report declares a statistically distinguishable winner when CIs separate", () => {
  const batch = makeBatch([makeStabilitySummary("a", "甲", 10, 10), makeStabilitySummary("b", "乙", 2, 10)]);
  const report = formatBatchReport(batch);
  assert.match(report, /统计上可区分/);
  assert.match(report, /甲 优于 乙/);
});

function makeInflatedSummary() {
  // 输出 token 报得远超本地估算 → 应判疑似灌水
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

test("token 计费审计已接入稳定性汇总与报告", () => {
  const summary = makeStabilitySummary("a", "甲", 8, 10);
  assert.ok(summary.tokenAudit, "summary 应带 tokenAudit");
  assert.ok(Array.isArray(summary.tokenAuditFindings));
  const report = formatStabilityReport(summary, makeRecords(8, 10));
  assert.match(report, /计费审计（估算对照粗筛）/);
});

test("计费审计识别系统性输出灌水并作为复核项暴露", () => {
  const summary = makeInflatedSummary();
  assert.equal(summary.tokenAudit.suspicious, true);
  assert.ok(summary.tokenAuditFindings.length > 0);
  const report = formatStabilityReport(summary, makeRecords(10, 10, { responseText: "好。", outputTokens: 4000 }));
  assert.match(report, /疑似/); // 审计结论 + 复核块都会出现"疑似"
  assert.match(report, /需第二人签字/); // 高敏感结论触发复核
});

function makeGroupedRecords(groupsSpec) {
  const records = [];
  for (const spec of groupsSpec) {
    const group = makeRecords(spec.successCount, spec.total, spec.options);
    for (const record of group) {
      record.groupId = spec.groupId;
      record.groupPrompt = spec.groupPrompt || spec.groupId;
    }
    records.push(...group);
  }
  return records;
}

test("buildStabilitySummary 按 groupId 拆分多组统计", () => {
  const records = makeGroupedRecords([
    { groupId: "basic", groupPrompt: "基础", successCount: 3, total: 3 },
    { groupId: "coding", groupPrompt: "编程", successCount: 1, total: 3 },
  ]);
  const summary = buildStabilitySummary({
    runId: "run-groups",
    profile: profile("g", "分组"),
    records,
    rounds: records.length,
    concurrency: 1,
    prompt: "基础",
    startedAt: new Date("2026-06-02T00:00:00Z"),
    endedAt: new Date("2026-06-02T00:01:00Z"),
  });
  assert.equal(summary.groups.length, 2);
  const basic = summary.groups.find((g) => g.groupId === "basic");
  const coding = summary.groups.find((g) => g.groupId === "coding");
  assert.equal(basic.count, 3);
  assert.equal(basic.successCount, 3);
  assert.equal(coding.count, 3);
  assert.equal(coding.successCount, 1);
});

test("buildStabilitySummary 无缓存信号时 cacheHitRate 为 null", () => {
  const summary = makeStabilitySummary("a", "甲", 8, 10);
  assert.equal(summary.cacheHitRate, null);
  assert.equal(summary.cacheHitRateText, null);
});

test("buildStabilitySummary 有缓存信号时计算命中率", () => {
  const records = makeRecords(4, 4);
  for (const record of records) {
    record.inputTokens = 100;
    record.cacheReadTokens = 60;
  }
  const summary = buildStabilitySummary({
    runId: "run-cache",
    profile: profile("c", "缓存"),
    records,
    rounds: records.length,
    concurrency: 1,
    prompt: "ping",
    startedAt: new Date("2026-06-02T00:00:00Z"),
    endedAt: new Date("2026-06-02T00:01:00Z"),
  });
  assert.ok(summary.cacheHitRate > 0.59 && summary.cacheHitRate < 0.61);
  assert.equal(summary.cacheHitRateText, "60%");
});

// —— ADM-010：延迟双口径 ——
// makeRecords 刻意不带 endToEndMs，模拟升级前落库的历史记录。

test("ADM-010: 记录缺 endToEndMs 时端到端指标为 null，不按 0 参与计算", () => {
  const summary = makeStabilitySummary("e2e-legacy", "历史", 10, 10);
  // 关键：不能是 0。0 会被报告当成"端到端 0 毫秒"，比不给数字更糟——
  // 它会让一条其实有重试等待的渠道看起来毫无延迟。
  assert.equal(summary.p95EndToEndMs, null);
  assert.equal(summary.avgEndToEndMs, null);
  assert.equal(summary.retryOverheadP95Ms, null);
  // 单次口径必须照旧可用：新字段缺失不得影响既有统计。
  assert.ok(summary.p95TotalMs > 0);
});

test("ADM-010: 有 endToEndMs 时给出端到端分位数与重试等待开销", () => {
  const records = makeRecords(10, 10);
  // 每条都在单次耗时之外多等了 1500ms 退避。
  for (const record of records) {
    if (record.success) record.endToEndMs = record.totalMs + 1500;
  }
  const summary = buildStabilitySummary({
    runId: "run-e2e",
    profile: profile("e", "端到端"),
    records,
    rounds: records.length,
    concurrency: 1,
    prompt: "ping",
    startedAt: new Date("2026-06-02T00:00:00Z"),
    endedAt: new Date("2026-06-02T00:01:00Z"),
  });
  assert.equal(summary.p95EndToEndMs, summary.p95TotalMs + 1500);
  // 这个数就是 ADM-010 要让用户看见的东西：重试掩盖掉的那段等待。
  assert.equal(summary.retryOverheadP95Ms, 1500);
  // 报告必须真的把它印出来，否则改了内核也等于没修。
  const report = formatStabilityReport(summary, records);
  assert.match(report, /端到端 P95（含重试与退避等待）：/);
  assert.match(report, /其中重试等待约 1500 ms/);
});

test("ADM-010: 端到端字段只有部分记录有时整体判未能统计", () => {
  const records = makeRecords(10, 10);
  // 只给一半记录补字段：算出来的分位数无法与 totalMs 口径对比，宁可不给。
  records[0].endToEndMs = records[0].totalMs + 500;
  const summary = buildStabilitySummary({
    runId: "run-e2e-partial",
    profile: profile("p", "部分"),
    records,
    rounds: records.length,
    concurrency: 1,
    prompt: "ping",
    startedAt: new Date("2026-06-02T00:00:00Z"),
    endedAt: new Date("2026-06-02T00:01:00Z"),
  });
  assert.equal(summary.p95EndToEndMs, null, "覆盖率不足应整体给 null，不能拿 1 条记录代表 10 条");
  const report = formatStabilityReport(summary, records);
  assert.match(report, /未能统计/);
});
