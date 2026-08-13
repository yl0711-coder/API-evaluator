// src/high-risk-banner.js
// 高危报告提示：网站顶部红底横幅，逐条列出未读高危报告，点开即消。
//
// 从 app.js 整块搬出（16 号报告 C1）。代码**逐字未改**——纯搬运才能用构建产物比对证明等价。
//
// —— 关于那条 TDZ 警告的历史 ——
// 搬出前，`highRiskBanner` 的 requireElement 被钉在 app.js 文件顶部，旁边有注释警告
// 「不要把它挪回下面的高危提示代码块里」：因为启动流程（顶层 await 块）会
// await loadHighRiskAlerts() → renderHighRiskBanner()，那时若 const 仍在文件下方未执行，
// 就处于暂时性死区(TDZ)，抛「Cannot access 'highRiskBanner' before initialization」，
// 并被启动 try/catch 兜成「连接本地服务失败」——一个极难查的假象。
//
// 封装进工厂后这个约束**自动消解**：元素查找发生在 createHighRiskBanner() 被调用那一刻
// （app.js 顶层、顶层 await 之前），不再依赖「声明写在文件哪一行」。这正是模块化换来的东西。
//
// —— 轮询为什么不在这里 ——
// 原 `setInterval(() => void loadHighRiskAlerts(), 60_000)` 保留在 app.js。它原本在顶层 await
// **之后**执行；若搬进工厂（工厂在 await 之前被调），轮询会提前到认证完成之前启动——
// 那是行为变化，不是纯搬运。故留在原处，由 app.js 调 load()。
import { escapeHtml } from "./client-utils.js";
import { requireElement } from "./dom-utils.js";
import { api } from "./api-client.js";
import { openReportOverlay } from "./report-overlay.js";

export function createHighRiskBanner({ state }) {
  const highRiskBanner = requireElement("#high-risk-banner");

  async function load() {
    if (!state.settings?.enableHighRiskAlert) {
      state.highRiskAlerts = [];
      renderHighRiskBanner();
      return;
    }
    try {
      const r = await api("/api/high-risk-alerts");
      state.highRiskAlerts = Array.isArray(r?.alerts) ? r.alerts : [];
    } catch {
      /* 拉取失败不阻断；下次刷新再试 */
    }
    renderHighRiskBanner();
  }

  function renderHighRiskBanner() {
    const alerts = state.settings?.enableHighRiskAlert ? state.highRiskAlerts || [] : [];
    if (!alerts.length) {
      highRiskBanner.classList.add("hidden");
      highRiskBanner.innerHTML = "";
      return;
    }
    const items = alerts
      .map(
        (a) =>
          `<div class="high-risk-banner__item"><span>⚠ ${escapeHtml(a.label || "报告")}：${escapeHtml(a.reason || "高危")}</span><button type="button" data-hazard-open="${escapeHtml(a.reportId)}">查看</button></div>`,
      )
      .join("");
    highRiskBanner.innerHTML =
      `<div class="high-risk-banner__head"><span>高危报告提示（${alerts.length}）</span><button type="button" data-hazard-ack-all>全部忽略</button></div>` +
      `<div class="high-risk-banner__list">${items}</div>`;
    highRiskBanner.classList.remove("hidden");
  }

  async function ackHazard(reportId) {
    try {
      const r = await api("/api/high-risk-alerts/ack", { method: "POST", body: JSON.stringify({ reportId }) });
      state.highRiskAlerts = Array.isArray(r?.alerts) ? r.alerts : (state.highRiskAlerts || []).filter((a) => a.reportId !== reportId);
    } catch {
      state.highRiskAlerts = (state.highRiskAlerts || []).filter((a) => a.reportId !== reportId); // 本地兜底移除
    }
    renderHighRiskBanner();
  }

  highRiskBanner.addEventListener("click", async (event) => {
    const openBtn = event.target.closest?.("[data-hazard-open]");
    if (openBtn) {
      const reportId = openBtn.dataset.hazardOpen;
      openReportOverlay(reportId, { title: reportId }); // 点开即消
      await ackHazard(reportId);
      return;
    }
    if (event.target.closest?.("[data-hazard-ack-all]")) {
      try {
        await api("/api/high-risk-alerts/ack", { method: "POST", body: JSON.stringify({ all: true }) });
      } catch {
        /* 忽略：本地也清空 */
      }
      state.highRiskAlerts = [];
      renderHighRiskBanner();
    }
  });

  return { load };
}
