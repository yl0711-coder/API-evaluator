import assert from "node:assert/strict";
import test from "node:test";

import { buildStabilitySummary } from "../server/summaries.mjs";
import {
  REPORT_TEMPLATE_VERSION,
  buildBibliography,
  buildReportAuthorityHeader,
  buildReviewSection,
  collectHighSensitivityFindings,
  formatStabilityReport,
} from "../server/reporting.mjs";

function makeSummary(level) {
  const records = Array.from({ length: 6 }, (_, i) => ({
    success: i < 5,
    totalMs: i < 5 ? 1000 + i * 50 : null,
    firstByteMs: i < 5 ? 100 : null,
    outputChars: i < 5 ? 80 : 0,
    inputTokens: i < 5 ? 40 : null,
    outputTokens: i < 5 ? 20 : null,
    normalizedError: i < 5 ? null : "upstream_5xx",
  }));
  const summary = buildStabilitySummary({
    runId: "run-auth",
    profile: { id: "p1", name: "甲", role: "target", provider: "mock", defaultModel: "m", protocol: "openai_compatible" },
    records,
    rounds: 6,
    concurrency: 1,
    prompt: "ping",
    startedAt: new Date("2026-06-02T00:00:00Z"),
    endedAt: new Date("2026-06-02T00:01:00Z"),
  });
  if (level) summary.recommendation = { ...summary.recommendation, level };
  return summary;
}

test("authority header renders all 7 traceability items with placeholders", () => {
  const lines = buildReportAuthorityHeader({ runId: "r1", startedAt: "2026-06-02T00:00:00Z" }, {});
  const text = lines.join("\n");
  for (const label of ["工具版本", "报告模板版本", "模型快照时间", "测试包标识", "评测人", "复核人", "复核状态"]) {
    assert.match(text, new RegExp(label), `缺少溯源项 ${label}`);
  }
  assert.match(text, new RegExp(REPORT_TEMPLATE_VERSION));
  assert.match(text, /待复核/); // 缺失复核人 → 占位"待复核"，不留空
});

test("authority header uses provided meta over defaults", () => {
  const lines = buildReportAuthorityHeader(
    {},
    { meta: { evaluator: "张三", reviewer: "李四", reviewStatus: "已复核", testPackId: "PACK-7" } },
  );
  const text = lines.join("\n");
  assert.match(text, /评测人：张三/);
  assert.match(text, /复核人：李四/);
  assert.match(text, /复核状态：已复核/);
  assert.match(text, /测试包标识：PACK-7/);
});

test("collectHighSensitivityFindings flags not-recommended verdicts", () => {
  assert.equal(collectHighSensitivityFindings({ recommendation: { level: "reject" } }).length >= 1, true);
  assert.equal(collectHighSensitivityFindings({ recommendation: { level: "recommended" } }).length, 0);
});

test("review section requires a second signer only for high-sensitivity findings", () => {
  const none = buildReviewSection([]).join("\n");
  assert.match(none, /无需第二人复核/);
  const flagged = buildReviewSection(["不建议接入：请复核证据。"]).join("\n");
  assert.match(flagged, /需第二人签字/);
  assert.match(flagged, /复核人：/);
});

test("bibliography lists methodology sources", () => {
  const text = buildBibliography().join("\n");
  assert.match(text, /Wilson/);
  assert.match(text, /RUT/);
  assert.match(text, /本地估算对照/);
  assert.match(text, /Krippendorff/);
});

test("stability report embeds authority header, methodology, bibliography and disclaimer", () => {
  const report = formatStabilityReport(makeSummary(), makeSummary().records || []);
  assert.match(report, /报告信息（版本与溯源）/);
  assert.match(report, /报告模板版本：2\.0\.0/);
  assert.match(report, /方法学说明/);
  assert.match(report, /参考文献 \/ 方法学出处/);
  assert.match(report, /免责声明/);
  assert.match(report, /疑似/); // “疑似”措辞免责
});

test("stability report shows review block when recommendation is reject", () => {
  const report = formatStabilityReport(makeSummary("reject"), []);
  assert.match(report, /需第二人签字/);
});
