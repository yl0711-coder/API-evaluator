import assert from "node:assert/strict";
import test from "node:test";

import { buildStabilitySummary } from "../server/summaries.mjs";
import {
  REPORT_TEMPLATE_VERSION,
  buildBibliography,
  buildReportAuthorityHeader,
  buildReviewSection,
  collectHighSensitivityFindings,
  formatAdmissionReport,
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

// —— 手填温度被上游拒收摘掉时，长期留存的报告必须留痕 ——
// 页面提示卡是一次性的（换页即没），Markdown/HTML 报告才是被下载、归档、喂给「模型比对」的产物。
// 传输层早就按请求打了 temperatureStripped 标记，汇总也聚合了计数，但报告全文一个「温度」字都没有——
// 读者会把整份报告读成「我设的那个温度下的表现」，实际跑的是模型默认温度。
// 准入报告与另三类报告结构不同（它没有溯源头），故两条路径分别驱动，不能只测一条。

test("formatStabilityReport：手填温度被摘掉时，报告正文写明数字产自模型默认温度", () => {
  const summary = makeSummary();
  summary.temperatureStrippedCount = 10;
  const report = formatStabilityReport(summary, []);
  assert.match(report, /手填温度未生效/, "稳定性报告未记录温度被摘");
  assert.match(report, /10 次请求/, "应写明被摘掉的请求数，否则读者无法判断影响面");
  assert.match(report, /模型默认温度/, "应点明这部分实际用的是模型默认温度");
});

test("formatAdmissionReport：手填温度被摘掉时，关键指标节先声明前提", () => {
  const summary = { ...makeSummary(), type: "admission", grade: "A", score: 90, requestCount: 10, temperatureStrippedCount: 4 };
  summary.cases = [];
  const report = formatAdmissionReport(summary, []);
  assert.match(report, /手填温度未生效/, "准入报告未记录温度被摘（准入页也有温度入口）");
  assert.match(report, /4 次请求/);
  // 必须排在「请求数」之前：它是解读整节数字的前提，写在末尾等于没写。
  assert.ok(report.indexOf("手填温度未生效") < report.indexOf("- 请求数："), "温度失效说明应位于关键指标节最前，先于各项数字");
});

test("buildReportAuthorityHeader：场景报告顶层无该计数，应按各 API 的 profileDigest 求和", () => {
  // 场景是多 API 汇总，buildScenarioSummary 只把计数放进 profileDigest 的每一项，顶层没有。
  // 不做求和的话这里会静默显示不出来——恰恰是多 API 混跑时最需要这句提示。
  const text = buildReportAuthorityHeader({
    runId: "r-scenario",
    profileDigest: [{ temperatureStrippedCount: 3 }, { temperatureStrippedCount: 0 }, { temperatureStrippedCount: 4 }],
  }).join("\n");
  assert.match(text, /手填温度未生效/, "场景报告应能从 profileDigest 聚合出温度失效");
  assert.match(text, /7 次请求/, "应为各 API 之和（3+0+4=7）");
});

test("负对照：温度未被摘时三类报告都不出现该说明，不误报", () => {
  // 没有这条，上面几条的绿可能只是撞上了报告里别处的「温度」字样。
  const header = buildReportAuthorityHeader({ runId: "r-clean" }).join("\n");
  assert.doesNotMatch(header, /手填温度未生效/);
  assert.doesNotMatch(formatStabilityReport(makeSummary(), []), /手填温度未生效/);
  assert.doesNotMatch(buildReportAuthorityHeader({ profileDigest: [{ temperatureStrippedCount: 0 }] }).join("\n"), /手填温度未生效/);
});
