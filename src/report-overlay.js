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

// 多报告浮层：tabs=[{ id, label, extras:[{id,label}] }]。>1 个时顶部出模型分页，点 tab 切 iframe；
// 单个时不显分页（与旧行为一致）。每个 tab 的 extras（如 AI 分析）渲染成当前页的附报告链接。
function openReportTabs(tabs, { title = "测试报告" } = {}) {
  const list = (tabs || []).filter((t) => t && t.id);
  if (!list.length) return;
  closeReportOverlay();
  let active = 0;

  const overlay = document.createElement("div");
  overlay.className = "report-overlay";

  const render = () => {
    const tab = list[active];
    const url = reportViewUrl(tab.id);
    const tabRow =
      list.length > 1
        ? `<div class="report-overlay__tabs">${list
            .map(
              (t, i) =>
                `<button type="button" class="report-overlay__tab${i === active ? " is-active" : ""}" data-tab="${i}">${escapeHtml(t.label || "报告")}</button>`,
            )
            .join("")}</div>`
        : "";
    const extraLinks = (tab.extras || [])
      .filter((r) => r && r.id)
      .map(
        (r) =>
          `<a class="report-overlay__link" href="${reportViewUrl(r.id)}" target="_blank" rel="noopener">${escapeHtml(r.label || "附报告")}</a>`,
      )
      .join("");
    const barTitle = list.length > 1 ? `${escapeHtml(title)} · ${escapeHtml(tab.label || "报告")}` : escapeHtml(title);
    overlay.innerHTML = `
      <div class="report-overlay__backdrop" data-close></div>
      <div class="report-overlay__panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="report-overlay__bar">
          <strong class="report-overlay__title">${barTitle}</strong>
          <div class="report-overlay__actions">
            ${extraLinks}
            <a class="report-overlay__link" href="${url}" target="_blank" rel="noopener">在新标签页打开</a>
            <button type="button" class="report-overlay__close" data-close aria-label="关闭">✕</button>
          </div>
        </div>
        ${tabRow}
        <iframe class="report-overlay__frame" src="${url}" title="${escapeHtml(title)}" sandbox="allow-same-origin allow-popups"></iframe>
        <label class="report-overlay__toggle">
          <input type="checkbox" ${isAutoOpenEnabled() ? "checked" : ""} /> 测试完成后自动弹出报告
        </label>
      </div>`;
    const toggle = overlay.querySelector(".report-overlay__toggle input");
    toggle?.addEventListener("change", () => setAutoOpenEnabled(toggle.checked));
  };

  // 事件委托挂在 overlay 上（render 只换 innerHTML，不动此监听）。
  overlay.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.hasAttribute("data-close")) {
      closeReportOverlay();
      return;
    }
    const tabBtn = target.closest("[data-tab]");
    if (tabBtn) {
      active = Number(tabBtn.getAttribute("data-tab")) || 0;
      render();
    }
  });

  render();
  document.addEventListener("keydown", onEsc);
  document.body.appendChild(overlay);
  overlayEl = overlay;
}

// 弹出报告浮层（单篇）。extraReports: [{ id, label }]（如 AI 分析独立报告）。
export function openReportOverlay(reportId, { title = "测试报告", extraReports = [] } = {}) {
  if (!reportId) return;
  openReportTabs([{ id: reportId, label: title, extras: extraReports }], { title });
}

// 弹出多篇报告浮层（每模型一篇）。reports: [{ id, aiAnalysisId, label, model }]。
export function openMultiReportOverlay(reports, { title = "测试报告" } = {}) {
  const tabs = (reports || [])
    .filter((r) => r && r.id)
    .map((r) => ({
      id: r.id,
      label: r.label || r.model || "报告",
      extras: r.aiAnalysisId ? [{ id: r.aiAnalysisId, label: "AI 分析" }] : [],
    }));
  openReportTabs(tabs, { title });
}

// 任务完成后按开关自动弹报告。result 为后端公开任务结果（含 reports[] 或标量 reportId / aiAnalysisId）。
export function maybeAutoOpenReport(result) {
  if (!result || typeof result !== "object" || !isAutoOpenEnabled()) return;
  // 每模型一篇：分页浮层一次弹出全部。
  if (Array.isArray(result.reports) && result.reports.length) {
    openMultiReportOverlay(result.reports, { title: "测试报告" });
    return;
  }
  const reportId = result.reportId;
  if (!reportId) return;
  const extras = result.aiAnalysisId ? [{ id: result.aiAnalysisId, label: "AI 分析" }] : [];
  openReportOverlay(reportId, { title: "测试报告", extraReports: extras });
}
