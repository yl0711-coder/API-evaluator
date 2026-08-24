import { escapeHtml } from "./client-utils.js";
import { reasoningEffortStrippedNotice, recommendationClass, temperatureStrippedNotice } from "./formatters.js";

export function renderStabilitySummary(container, result) {
  const levelClass = recommendationClass(result.recommendation?.level);
  const groups = Array.isArray(result.groups) ? result.groups : [];

  container.innerHTML = `
    ${temperatureStrippedNotice(result.temperatureStrippedCount, result.rounds)}
    ${reasoningEffortStrippedNotice(result.reasoningEffortStrippedCount, result.rounds)}
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
    <article class="summary-card">
      <span>缓存命中率</span>
      <strong>${escapeHtml(result.cacheHitRateText || "未提供缓存统计信号")}</strong>
      <small>命中率 = 缓存读取 token / 输入 token</small>
    </article>
    <article class="summary-card wide-summary">
      <span>测试建议</span>
      <strong class="${levelClass}">${escapeHtml(result.recommendation?.title || "-")}</strong>
      <small>${escapeHtml(result.recommendation?.detail || "-")}</small>
      <small>报告文件：${escapeHtml(result.reportPath || "-")}</small>
      <small>JSON 原始结果：${escapeHtml(result.rawJsonPath || "-")}</small>
    </article>
    ${renderGroupBreakdown(groups)}
  `;
}

function renderGroupBreakdown(groups) {
  if (groups.length <= 1) return "";
  return `
    <article class="summary-card wide-summary">
      <span>分组明细</span>
      <table class="stability-group-table">
        <thead>
          <tr>
            <th>文案</th>
            <th>次数</th>
            <th>成功率</th>
            <th>平均耗时</th>
            <th>P95</th>
            <th>缓存命中率</th>
          </tr>
        </thead>
        <tbody>
          ${groups
            .map(
              (group) => `
            <tr>
              <td>${escapeHtml(group.groupId || group.promptPreview || "-")}</td>
              <td>${group.count}</td>
              <td>${escapeHtml(group.successRateText)}</td>
              <td>${group.avgTotalMs || "-"} ms</td>
              <td>${group.p95TotalMs ?? "-"} ms</td>
              <td>${escapeHtml(group.cacheHitRateText || "未提供缓存统计信号")}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </article>
  `;
}
