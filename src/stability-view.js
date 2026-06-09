import { escapeHtml } from "./client-utils.js";
import { recommendationClass } from "./formatters.js";

export function renderStabilitySummary(container, result) {
  const levelClass = recommendationClass(result.recommendation?.level);

  container.innerHTML = `
    <article class="summary-card">
      <span>成功率</span>
      <strong class="${levelClass}">${escapeHtml(result.successRateText)}</strong>
      <small>${result.successCount}/${result.rounds} 成功</small>
    </article>
    <article class="summary-card">
      <span>平均耗时</span>
      <strong>${result.avgTotalMs || "-"} ms</strong>
      <small>平均首包 ${result.avgFirstByteMs || "-"} ms</small>
    </article>
    <article class="summary-card">
      <span>慢请求参考</span>
      <strong>${result.p95TotalMs ?? "-"} ms</strong>
      <small>最慢 ${result.maxTotalMs ?? "-"} ms</small>
    </article>
    <article class="summary-card wide-summary">
      <span>测试建议</span>
      <strong class="${levelClass}">${escapeHtml(result.recommendation?.title || "-")}</strong>
      <small>${escapeHtml(result.recommendation?.detail || "-")}</small>
      <small>报告文件：${escapeHtml(result.reportPath || "-")}</small>
      <small>JSON 原始结果：${escapeHtml(result.rawJsonPath || "-")}</small>
    </article>
  `;
}
