import { escapeHtml } from "./client-utils.js";
import { recommendationClass } from "./formatters.js";

// 场景测试「汇总结论」：场景测试是多 API × 多场景的矩阵，没有单一成功率，
// 因此按被测 API 逐行出卡，每张卡是该 API 的成功率 / 平均质量分 / 慢请求 + 该 API 的结论建议，
// 按平均质量分从高到低排序（与后端 selectScenarioAnalysisProfile 的择优口径一致）。
export function renderScenarioSummary(container, result) {
  // 优先用 profileDigest：任务通道会剥掉重字段 results/records，digest 是不被剥离的轻量副本。
  const source = result.profileDigest || result.results || [];
  const profiles = [...source].sort(
    (a, b) => (b.avgQualityScore || 0) - (a.avgQualityScore || 0),
  );
  if (profiles.length === 0) {
    container.innerHTML = `<p class="muted">本轮没有有效结果。</p>`;
    return;
  }

  const cards = profiles.map((profile, index) => {
    const levelClass = recommendationClass(profile.recommendation?.level);
    const rank = profiles.length > 1 ? `优${index + 1} · ` : "";
    return `
      <article class="summary-card wide-summary scenario-summary-card">
        <span>${escapeHtml(rank)}${escapeHtml(profile.profileName || "-")}（${escapeHtml(profile.model || "-")}）</span>
        <div class="scenario-summary-metrics">
          <span>成功率 <b class="${levelClass}">${escapeHtml(profile.successRateText || "-")}</b></span>
          <span>平均质量分 <b class="${levelClass}">${profile.avgQualityScore ?? "-"}</b></span>
          <span>慢请求参考 <b>${profile.p95TotalMs ?? "-"} ms</b></span>
        </div>
        <strong class="${levelClass}">${escapeHtml(profile.recommendation?.title || "-")}</strong>
        <small>${escapeHtml(profile.recommendation?.detail || "-")}</small>
      </article>
    `;
  });

  const reportCard = `
    <article class="summary-card wide-summary">
      <span>报告位置</span>
      <small>报告文件：${escapeHtml(result.reportPath || "-")}</small>
      <small>JSON 原始结果：${escapeHtml(result.rawJsonPath || "-")}</small>
    </article>
  `;

  container.innerHTML = cards.join("") + reportCard;
}
