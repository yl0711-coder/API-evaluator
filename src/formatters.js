export function recommendationClass(level) {
  return (
    {
      pass: "ok",
      watch: "warn",
      fail: "fail",
    }[level] || "muted"
  );
}

export function formatTaskType(type) {
  return (
    {
      stability: "稳定性测试",
      "batch-admission": "批量准入评测",
      "batch-stability": "批量稳定性测试",
      scenario: "场景测试",
      "load-test": "压力测试",
    }[type] ||
    type ||
    "-"
  );
}

export function formatBatchAdmissionResult(result) {
  const reports = Array.isArray(result.reports) ? result.reports.filter(Boolean) : [];
  const reportLines = reports.length
    ? [`每模型报告（共 ${reports.length} 篇，见报告中心/浮层）：`, ...reports.map((r) => `- ${r.label || r.model || "报告"}`)]
    : [`报告文件：${result.reportPath || "-"}`];
  const lines = [
    `批次：${result.batchId}`,
    `被测 API：${result.profileCount}`,
    `同时测试 API 数：${result.maxParallelProfiles}`,
    `测试包：${result.packageLevel}`,
    `总耗时：${result.durationMs} ms`,
    ...reportLines,
    `JSON 原始结果：${result.rawJsonPath || "-"}`,
  ];
  return lines.join("\n");
}

export function formatTaskStatus(status) {
  return (
    {
      queued: "排队中",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      interrupted: "已中断",
    }[status] ||
    status ||
    "-"
  );
}

export function taskStatusClass(status) {
  return (
    {
      queued: "muted",
      running: "warn",
      completed: "ok",
      failed: "fail",
      cancelled: "warn",
      interrupted: "fail",
    }[status] || "muted"
  );
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

export function formatClientLogAnalysisResult(result) {
  const riskText =
    (result.riskFlags || [])
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
    (result.upstreamIds || [])
      .slice(0, 10)
      .map((item) => `- ${item}`)
      .join("\n") || "- 未识别到上游 request_id / trace_id",
    "",
    "建议提交给上游确认：",
    (result.askList || [])
      .slice(0, 8)
      .map((item) => `- ${item}`)
      .join("\n") || "- 请按时间窗口、模型和状态码排查。",
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
