import { formatNumber } from "./client-utils.js";

export function recommendationClass(level) {
  return {
    pass: "ok",
    watch: "warn",
    fail: "fail",
  }[level] || "muted";
}

// 预测 vs 实际消耗（跑前预估 token/请求 vs 跑后真实 token/成本，含裁判审计）。
export function formatConsumptionLines(result) {
  const lines = [];
  const p = result?.predictedConsumption;
  if (p && (Number.isFinite(Number(p.requests)) || Number.isFinite(Number(p.highTokens)))) {
    const bits = [];
    if (Number.isFinite(Number(p.requests))) bits.push(`${p.requests} 次请求`);
    if (Number.isFinite(Number(p.lowTokens)) && Number.isFinite(Number(p.highTokens))) {
      bits.push(`预计 ${formatNumber(p.lowTokens)}–${formatNumber(p.highTokens)} tokens`);
    }
    lines.push(`预测消耗：${bits.join(" · ")}`);
  }
  const actualCost = result?.actualConsumption?.totalCost ?? result?.estimatedCost ?? null;
  const judge = result?.actualConsumption?.judge || null;
  const bits = [];
  const inTok = Number(result?.inputTokens);
  const outTok = Number(result?.outputTokens);
  if (Number.isFinite(inTok) || Number.isFinite(outTok)) {
    bits.push(`输入 ${formatNumber(inTok || 0)} / 输出 ${formatNumber(outTok || 0)} tokens`);
  }
  if (typeof actualCost === "number" && Number.isFinite(actualCost)) {
    bits.push(`成本 $${formatCost(actualCost)}`);
    if (judge && typeof judge.cost === "number") bits.push(`含裁判 ${judge.calls} 次 / $${formatCost(judge.cost)}`);
  }
  if (bits.length) lines.push(`实际消耗：${bits.join(" · ")}`);
  return lines;
}

export function formatTaskType(type) {
  return {
    stability: "稳定性测试",
    "batch-admission": "批量准入评测",
    "batch-stability": "批量稳定性测试",
    scenario: "场景测试",
  }[type] || type || "-";
}

export function formatBatchAdmissionResult(result) {
  const lines = [
    `批次：${result.batchId}`,
    `被测 API：${result.profileCount}`,
    `同时测试 API 数：${result.maxParallelProfiles}`,
    `测试包：${result.packageLevel}`,
    `总耗时：${result.durationMs} ms`,
    `报告文件：${result.reportPath || "-"}`,
    `JSON 原始结果：${result.rawJsonPath || "-"}`,
  ];
  return lines.join("\n");
}

export function formatTaskStatus(status) {
  return {
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  }[status] || status || "-";
}

export function taskStatusClass(status) {
  return {
    queued: "muted",
    running: "warn",
    completed: "ok",
    failed: "fail",
    cancelled: "warn",
    interrupted: "fail",
  }[status] || "muted";
}

export function formatResult(result) {
  const statusText = result.success ? "这条配置可以正常请求。" : "这条配置暂时不能正常使用。";
  const issueText = result.success ? "没有发现明显问题。" : `问题类型：${result.normalizedError || "未知错误"}。`;
  const lines = [
    `结论：${result.success ? "可继续测试" : "先不要继续测试"}`,
    `说明：${statusText}`,
    `问题：${issueText}`,
    `耗时：${result.totalMs ?? "-"} ms`,
    `输出长度：${result.outputChars ?? 0} 字符`,
    "",
    "响应摘要：",
    result.responseSummary || result.rawError || "-",
  ];
  return lines.join("\n");
}

export function formatBatchResult(result) {
  const lines = [
    `批次：${result.batchId}`,
    `被测 API：${result.profileCount}`,
    `同时测试 API 数：${result.maxParallelProfiles}`,
    `每个 API 轮数：${result.rounds}`,
    `总耗时：${result.durationMs} ms`,
    `报告文件：${result.reportPath || "-"}`,
    `JSON 原始结果：${result.rawJsonPath || "-"}`,
  ];
  return lines.join("\n");
}

export function formatStabilityResult(result) {
  const lines = [
    `测试 ID：${result.runId || "-"}`,
    `被测 API：${result.profileName || "-"}`,
    `模型：${result.model || "-"}`,
    `测试轮数：${result.rounds ?? "-"}`,
    `成功率：${result.successRateText || "-"}`,
    `平均耗时：${result.avgTotalMs || "-"} ms`,
    `慢请求参考：${result.p95TotalMs ?? "-"} ms`,
    `结论：${result.recommendation?.title || "-"}`,
    `说明：${result.recommendation?.detail || "-"}`,
    ...formatConsumptionLines(result),
    `Markdown 报告：${result.reportPath || "-"}`,
    `HTML 报告：${result.reportHtmlPath || "-"}`,
    `JSON 原始结果：${result.rawJsonPath || "-"}`,
  ];
  return lines.join("\n");
}

export function formatScenarioResult(result) {
  const lines = [
    `测试 ID：${result.runId}`,
    `被测 API：${result.profileCount}`,
    `测试场景：${result.scenarioCount}`,
    `每个场景重复次数：${result.repeats}`,
    `总耗时：${result.durationMs} ms`,
    ...formatConsumptionLines(result),
    `报告文件：${result.reportPath || "-"}`,
    `JSON 原始结果：${result.rawJsonPath || "-"}`,
  ];
  return lines.join("\n");
}

export function formatClientLogAnalysisResult(result) {
  const riskText = (result.riskFlags || [])
    .slice(0, 5)
    .map((item) => `- ${item.title}：${item.detail}`)
    .join("\n") || "- 未发现明显风险。";
  const lines = [
    `分析 ID：${result.runId || "-"}`,
    `来源：${result.sourceName || "-"}`,
    `日志数量：${result.recordCount ?? "-"}`,
    `成功率：${result.successRateText || "-"}`,
    `失败数量：${result.failureCount ?? "-"}`,
    `P95 耗时：${result.p95DurationMs ?? "-"} ms`,
    `结论：${result.recommendation?.title || "-"}`,
    `说明：${result.recommendation?.detail || "-"}`,
    `Markdown 报告：${result.reportPath || "-"}`,
    `HTML 报告：${result.reportHtmlPath || "-"}`,
    `JSON 原始结果：${result.rawJsonPath || "-"}`,
    "",
    "风险提示：",
    riskText,
  ];
  return lines.join("\n");
}

export function formatSupplierEvidenceResult(result) {
  const lines = [
    `证据包 ID：${result.runId || "-"}`,
    `上游名称：${result.providerName || "-"}`,
    `来源：${result.sourceName || "-"}`,
    `日志数量：${result.recordCount ?? "-"}`,
    `失败数量：${result.failureCount ?? "-"}`,
    `结论：${result.conclusion || "-"}`,
    `Markdown 报告：${result.reportPath || "-"}`,
    `HTML 报告：${result.reportHtmlPath || "-"}`,
    `JSON 原始结果：${result.rawJsonPath || "-"}`,
    "",
    "上游可检索 ID：",
    (result.upstreamIds || []).slice(0, 10).map((item) => `- ${item}`).join("\n") || "- 未识别到上游 request_id / trace_id",
    "",
    "建议提交给上游确认：",
    (result.askList || []).slice(0, 8).map((item) => `- ${item}`).join("\n") || "- 请按时间窗口、模型和状态码排查。",
  ];
  return lines.join("\n");
}

export function formatAdmissionResult(result) {
  const lines = [
    `测试 ID：${result.runId || "-"}`,
    `被测 API：${result.profileName || "-"}`,
    `模型：${result.model || "-"}`,
    `协议：${result.protocol || "-"}`,
    `准入等级：${result.grade || "-"}`,
    `综合分：${result.score ?? "-"}/100`,
    `模型纯度初判：${result.purityAssessment?.title || "-"}（${result.purityAssessment?.score ?? "-"}/100）`,
    `指纹探针：${formatFingerprintLine(result.fingerprintSummary)}`,
    `成功率：${result.successRateText || "-"}`,
    `工具调用：${result.toolCallPassed ? "通过" : "未通过或未测试"}`,
    `标称一致性：${formatIdentityLine(result.identityCheck)}`,
    `JSON 结构：${result.jsonPassed ? "通过" : "未通过或未测试"}`,
    `平均耗时：${result.avgTotalMs ?? "-"} ms`,
    `慢请求参考：${result.p95TotalMs ?? "-"} ms`,
    `估算成本：${formatCost(result.estimatedCost)}`,
    `估算收入：${formatCost(result.estimatedRevenue)}`,
    `估算毛利：${formatCost(result.estimatedGrossProfit)}`,
    `结论：${result.recommendation?.title || "-"}`,
    `说明：${result.recommendation?.detail || "-"}`,
    `下一步：${result.nextAction || "-"}`,
    `Markdown 报告：${result.reportPath || "-"}`,
    `HTML 报告：${result.reportHtmlPath || "-"}`,
    `JSON 原始结果：${result.rawJsonPath || "-"}`,
  ];
  return lines.join("\n");
}

export function formatCost(value) {
  if (!Number.isFinite(Number(value))) return "-";
  const number = Number(value);
  if (number === 0) return "0";
  if (number < 0.01) return number.toFixed(4);
  return number.toFixed(2);
}

function formatFingerprintLine(fingerprintSummary) {
  if (!fingerprintSummary?.totalCount) return "未测试";
  const version = fingerprintSummary.libraryVersion ? `，题库 ${fingerprintSummary.libraryVersion}` : "";
  return `${fingerprintSummary.passedCount}/${fingerprintSummary.totalCount} 通过（${fingerprintSummary.passRateText || "-"}${version}）`;
}

function formatIdentityLine(identityCheck) {
  if (!identityCheck) return "未测试";
  if (identityCheck.status === "aligned") return "一致";
  if (identityCheck.status === "conflict") return `冲突：标称 ${identityCheck.expectedFamily}，自述 ${identityCheck.reportedFamily}`;
  if (identityCheck.status === "observed") return `已记录：${identityCheck.reportedFamily}`;
  return "无法确认";
}
