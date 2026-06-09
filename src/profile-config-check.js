import { escapeHtml } from "./client-utils.js";
import { validateProfileConfig } from "./operator-guidance.js";

export function renderProfileConfigCheck({ form, container, validation = null }) {
  const payload = Object.fromEntries(new FormData(form).entries());
  const result = validation || validateProfileConfig(payload);
  if (!payload.baseUrl && !payload.defaultModel && !payload.apiKey) {
    container.className = "wide check-panel muted";
    container.textContent = "填写配置后，这里会提示明显风险。";
    return;
  }

  if (!result.issues.length) {
    container.className = "wide check-panel pass-card";
    container.innerHTML = "<strong>配置初检通过。</strong><span>保存并测试通过后，再进入标准评测生成可交付结论。</span>";
    return;
  }

  const levelClass = result.hasBlockers ? "fail-card" : "watch-card";
  const title = result.hasBlockers ? "需要先修正这些问题" : "可以保存，但建议先确认";
  container.className = `wide check-panel ${levelClass}`;
  container.innerHTML = `
    <strong>${title}</strong>
    <ul>
      ${result.issues
        .map((issue) => `<li><b>${escapeHtml(issue.title)}：</b>${escapeHtml(issue.detail)}</li>`)
        .join("")}
    </ul>
  `;
}
