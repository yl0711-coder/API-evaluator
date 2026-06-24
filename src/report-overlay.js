// 报告浮层：任务完成后在应用内弹出报告（iframe 加载后端 HTTP 报告路由）。
// 桌面单机版靠后端 openReportInBrowser 开系统浏览器；Docker/远程无桌面，改用本浮层——
// 不经浏览器弹窗拦截器（异步 window.open 会被拦），稳定地把报告“自己弹出来”。
import { escapeHtml } from "./client-utils.js";

const AUTO_OPEN_KEY = "evaluator:auto-open-report";

// 客户端开关（存 localStorage，默认开）。等价于 Web 版的 EVALUATOR_OPEN_REPORT。
export function isAutoOpenEnabled() {
  try {
    return localStorage.getItem(AUTO_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAutoOpenEnabled(on) {
  try {
    localStorage.setItem(AUTO_OPEN_KEY, on ? "1" : "0");
  } catch {
    // 隐私模式 / 禁用存储：忽略，本次会话内仍按默认行为。
  }
}

export function reportViewUrl(reportId) {
  return `/api/reports/${encodeURIComponent(reportId)}/view`;
}

let overlayEl = null;

function onEsc(event) {
  if (event.key === "Escape") closeReportOverlay();
}

export function closeReportOverlay() {
  if (!overlayEl) return;
  overlayEl.remove();
  overlayEl = null;
  document.removeEventListener("keydown", onEsc);
}

// 弹出报告浮层。extraReports: [{ id, label }]（如 AI 分析独立报告），渲染为顶栏的新标签页链接。
export function openReportOverlay(reportId, { title = "测试报告", extraReports = [] } = {}) {
  if (!reportId) return;
  closeReportOverlay();
  const url = reportViewUrl(reportId);
  const extraLinks = extraReports
    .filter((r) => r && r.id)
    .map(
      (r) =>
        `<a class="report-overlay__link" href="${reportViewUrl(r.id)}" target="_blank" rel="noopener">${escapeHtml(r.label || "附报告")}</a>`,
    )
    .join("");

  const overlay = document.createElement("div");
  overlay.className = "report-overlay";
  overlay.innerHTML = `
    <div class="report-overlay__backdrop" data-close></div>
    <div class="report-overlay__panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="report-overlay__bar">
        <strong class="report-overlay__title">${escapeHtml(title)}</strong>
        <div class="report-overlay__actions">
          ${extraLinks}
          <a class="report-overlay__link" href="${url}" target="_blank" rel="noopener">在新标签页打开</a>
          <button type="button" class="report-overlay__close" data-close aria-label="关闭">✕</button>
        </div>
      </div>
      <iframe class="report-overlay__frame" src="${url}" title="${escapeHtml(title)}" sandbox="allow-same-origin allow-popups"></iframe>
      <label class="report-overlay__toggle">
        <input type="checkbox" ${isAutoOpenEnabled() ? "checked" : ""} /> 测试完成后自动弹出报告
      </label>
    </div>`;

  overlay.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.hasAttribute("data-close")) closeReportOverlay();
  });
  const toggle = overlay.querySelector(".report-overlay__toggle input");
  toggle?.addEventListener("change", () => setAutoOpenEnabled(toggle.checked));

  document.addEventListener("keydown", onEsc);
  document.body.appendChild(overlay);
  overlayEl = overlay;
}

// 任务完成后按开关自动弹报告。result 为后端公开任务结果（含 reportId / aiAnalysisId）。
export function maybeAutoOpenReport(result) {
  if (!result || typeof result !== "object" || !isAutoOpenEnabled()) return;
  const reportId = result.reportId;
  if (!reportId) return;
  const extras = result.aiAnalysisId ? [{ id: result.aiAnalysisId, label: "AI 分析" }] : [];
  openReportOverlay(reportId, { title: "测试报告", extraReports: extras });
}
