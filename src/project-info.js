import { escapeHtml } from "./client-utils.js";

export const PROJECT_INFO_STORAGE_KEY = "evaluator.project-info";

export function loadProjectInfo() {
  try {
    return JSON.parse(localStorage.getItem(PROJECT_INFO_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveProjectInfo(projectInfo) {
  localStorage.setItem(PROJECT_INFO_STORAGE_KEY, JSON.stringify(projectInfo));
}

export function hydrateProjectInfoForm(form, projectInfo) {
  for (const [key, value] of Object.entries(projectInfo)) {
    if (form.elements[key]) {
      form.elements[key].value = value;
    }
  }
}

export function renderProjectInfoSummary(projectInfo) {
  const items = [
    ["项目 / 客户", projectInfo.projectName],
    ["测试批次", projectInfo.batchName],
    ["测试人员", projectInfo.testerName],
    ["测试目的", projectInfo.testPurpose],
  ];
  if (!items.some(([, value]) => value?.trim())) {
    return `<p class="muted">还没有填写项目和批次信息。建议回到总览页补充后再交付。</p>`;
  }
  return `
    <div class="meta-grid">
      ${items
        .map(
          ([label, value]) => `
            <article>
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value || "-")}</strong>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}
