// src/report-browser.js
// 「查看报告」面板：列出「评测数据/报告」里的报告文件（每页 10 个，分页 + 按渠道/模型/种类/日期筛选）。
//
// 从 app.js 整块搬出（16 号报告 C1）。代码**逐字未改**——纯搬运才能用构建产物比对证明等价。
//
// 命名：叫 report-browser 而非 report-files，避开与后端 server/report-files.mjs 撞名（两者不同层）。
//
// 它不是「页面」而是个 <details> 面板：展开时才加载，故不进 showPage 的懒加载派发，
// 由模块自己接管 toggle 事件。
import { escapeHtml } from "./client-utils.js";
import { requireElement } from "./dom-utils.js";
import { api } from "./api-client.js";
import { openReportOverlay } from "./report-overlay.js";
import { computeDateBounds, matchesReportFilter, parseReportId, reportChannelModelOptions } from "./report-id.js";

const REPORT_TYPE_LABELS = {
  admission: "准入评测",
  "admission-batch": "批量准入",
  scenario: "场景测试",
  run: "稳定性测试",
  compare: "模型对比",
  autodigest: "自动巡检",
  load: "压力测试", // runId 前缀 buildReportId("load", ...)
  "load-test": "压力测试",
  batch: "批量稳定性",
  quickverify: "快速验证",
  supplier: "上游证据包",
  client: "客户端回放",
  replay: "客户端回放",
};
const REPORT_PAGE_SIZE = 10;

export function createReportBrowser({ state }) {
  const reportFilesPanel = requireElement("#report-files-panel");
  const reportFilesList = requireElement("#report-files-list");
  const rfFilterChannel = requireElement("#rf-filter-channel");
  const rfFilterModel = requireElement("#rf-filter-model");
  const rfFilterType = requireElement("#rf-filter-type");
  const rfFilterDateFrom = requireElement("#rf-filter-date-from");
  const rfFilterDateTo = requireElement("#rf-filter-date-to");
  const REPORT_FILTERS = [rfFilterChannel, rfFilterModel, rfFilterType, rfFilterDateFrom, rfFilterDateTo];

  let reportFiles = []; // 每条已附 parsed = parseReportId(id)
  let reportFilesPage = 0;
  // 是否超级管理员（role≥100）：仅其可见/可用报告删除按钮（安全另在服务端强制）。
  // 由 app.js 在认证完成后经 setCanConfig 推入——那一刻在顶层 await 之后，故不能在 create 时传值。
  let currentUserCanConfig = false;
  let reportDateMin = ""; // 报告实际日期范围（YYYY-MM-DD），给日期框设 min/max 用
  let reportDateMax = "";

  // 令「终止」日历不早于「起始」、「起始」不晚于「终止」（同时夹在报告日期范围内）。
  function syncDateBounds() {
    const { toMin, fromMax } = computeDateBounds(rfFilterDateFrom.value, rfFilterDateTo.value, reportDateMin, reportDateMax);
    rfFilterDateTo.min = toMin;
    rfFilterDateFrom.max = fromMax;
  }

  // 展开「全部报告文件」面板时自动加载（已无独立「查看报告」按钮）。
  reportFilesPanel.addEventListener("toggle", () => {
    if (reportFilesPanel.open) loadReportFiles();
  });
  // 点日期框即弹出原生日历选择器（不必只点小图标）。
  for (const dateInput of [rfFilterDateFrom, rfFilterDateTo]) {
    dateInput.addEventListener("click", () => {
      try {
        dateInput.showPicker?.();
      } catch {
        /* 未由用户手势激活 / 不支持 → 忽略，仍可用默认日历图标 */
      }
    });
  }
  REPORT_FILTERS.forEach((sel) =>
    sel.addEventListener("change", () => {
      // 渠道↔模型联动：重算两下拉可选项（保留仍有效的选中值）。内部亦会 syncDateBounds 收紧日历范围。
      populateReportFilters();
      reportFilesPage = 0;
      renderReportFilesPage();
    }),
  );
  reportFilesList.addEventListener("click", (event) => {
    const pager = event.target.closest?.("[data-report-page]");
    if (pager) {
      const totalPages = Math.max(1, Math.ceil(filteredReportFiles().length / REPORT_PAGE_SIZE));
      reportFilesPage =
        pager.dataset.reportPage === "next" ? Math.min(reportFilesPage + 1, totalPages - 1) : Math.max(reportFilesPage - 1, 0);
      renderReportFilesPage();
      return;
    }
    const del = event.target.closest?.("[data-report-del]");
    if (del) {
      const id = del.dataset.reportDel;
      if (!confirm(`确认删除报告「${id}」？此操作不可撤销。`)) return;
      api(`/api/reports/files/${encodeURIComponent(id)}`, { method: "DELETE" })
        .then(() => loadReportFiles())
        .catch((error) => alert(`删除失败：${error.message}`));
      return;
    }
    const btn = event.target.closest?.("[data-report-id]");
    if (btn) openReportOverlay(btn.dataset.reportId, { title: btn.dataset.reportId });
  });

  function reportKindLabel(id) {
    if (/[-_]ai-analysis$/i.test(id)) return "AI 分析";
    const parsed = parseReportId(id);
    const token = parsed.isNew ? parsed.type : String(id).split("-")[0];
    return REPORT_TYPE_LABELS[token] || "报告";
  }
  function formatBytes(bytes) {
    return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
  }
  function formatReportDate(yyyymmdd) {
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }
  // 报告归并映射：{曾用名→当前名}（渠道名、模型名各一份），据当前渠道/模型的 aliases 生成。
  // 让改名前落盘的历史报告（文件名是旧名）在筛选/下拉里归并到当前对象。
  function reportAliasMaps() {
    const channel = {};
    for (const c of state.channels || []) {
      for (const a of Array.isArray(c.aliases) ? c.aliases : []) if (a && c.name) channel[a] = c.name;
    }
    const model = {};
    for (const t of state.modelTargets || []) {
      for (const a of Array.isArray(t.aliases) ? t.aliases : []) if (a && t.model) model[a] = t.model;
    }
    return { channel, model };
  }
  // 任一筛选生效 → 只留 isNew 且四项都匹配；无任何筛选 → 全部（新+老）。老报告不参与筛选。
  function filteredReportFiles() {
    const filter = {
      channel: rfFilterChannel.value,
      model: rfFilterModel.value,
      type: rfFilterType.value,
      from: rfFilterDateFrom.value.replace(/-/g, ""), // YYYY-MM-DD → YYYYMMDD
      to: rfFilterDateTo.value.replace(/-/g, ""),
    };
    const aliasMaps = reportAliasMaps();
    return reportFiles.filter((f) => matchesReportFilter(f.parsed, filter, aliasMaps));
  }
  // 据新格式报告去重值填充四个下拉（保留当前选中值）。
  // 渠道/模型互相联动：渠道选项据「当前所选模型」收窄、模型选项据「当前所选渠道」收窄（见 reportChannelModelOptions）。
  function populateReportFilters() {
    // 用「当前选中值」做交叉约束，故须在重填（改动 select 内容）之前先读取。
    const { channels, models } = reportChannelModelOptions(
      reportFiles.map((f) => f.parsed),
      { channel: rfFilterChannel.value, model: rfFilterModel.value },
      reportAliasMaps(),
    );
    const types = new Set();
    const dates = new Set();
    for (const f of reportFiles) {
      const p = f.parsed;
      if (!p.isNew) continue;
      if (p.type) types.add(p.type);
      if (p.date) dates.add(p.date);
    }
    const fill = (sel, allLabel, items, label = (x) => x) => {
      const cur = sel.value;
      sel.innerHTML =
        `<option value="">${allLabel}</option>` +
        items.map((x) => `<option value="${escapeHtml(x)}"${x === cur ? " selected" : ""}>${escapeHtml(label(x))}</option>`).join("");
    };
    fill(rfFilterChannel, "全部渠道", channels);
    fill(rfFilterModel, "全部模型", models);
    fill(rfFilterType, "全部种类", [...types].sort(), (t) => REPORT_TYPE_LABELS[t] || t);
    // 日期范围用原生日期控件：按报告实际日期范围设 min/max（不填充下拉项）。
    const ds = [...dates].sort();
    reportDateMin = ds.length ? formatReportDate(ds[0]) : "";
    reportDateMax = ds.length ? formatReportDate(ds[ds.length - 1]) : "";
    syncDateBounds();
  }
  function renderReportFilesPage() {
    const list = filteredReportFiles();
    if (!list.length) {
      reportFilesList.innerHTML = reportFiles.length
        ? `<p class="muted">没有符合筛选条件的报告。</p>`
        : `<p class="muted">暂无报告（「评测数据/报告」为空）。</p>`;
      return;
    }
    const totalPages = Math.max(1, Math.ceil(list.length / REPORT_PAGE_SIZE));
    reportFilesPage = Math.min(Math.max(reportFilesPage, 0), totalPages - 1);
    const start = reportFilesPage * REPORT_PAGE_SIZE;
    const rows = list
      .slice(start, start + REPORT_PAGE_SIZE)
      .map(
        (f) => `
        <div class="row report-file-row">
          <div><strong>${escapeHtml(reportKindLabel(f.id))}</strong><br /><small>${escapeHtml(f.id)}</small></div>
          <small>${escapeHtml(new Date(f.mtimeMs).toLocaleString("zh-CN"))}</small>
          <small>${formatBytes(f.sizeBytes)}</small>
          <div class="report-file-actions">
            <button class="secondary" type="button" data-report-id="${escapeHtml(f.id)}">查看</button>
            ${currentUserCanConfig ? `<button class="danger" type="button" data-report-del="${escapeHtml(f.id)}">删除</button>` : ""}
          </div>
        </div>`,
      )
      .join("");
    const pager = `
    <div class="report-files-pager">
      <button class="secondary" type="button" data-report-page="prev"${reportFilesPage === 0 ? " disabled" : ""}>上一页</button>
      <span class="muted">第 ${reportFilesPage + 1} / ${totalPages} 页 · 共 ${list.length} 个</span>
      <button class="secondary" type="button" data-report-page="next"${reportFilesPage >= totalPages - 1 ? " disabled" : ""}>下一页</button>
    </div>`;
    reportFilesList.innerHTML = rows + pager;
  }
  async function loadReportFiles() {
    reportFilesList.innerHTML = `<p class="muted">加载中…</p>`;
    try {
      const files = await api("/api/reports/files");
      reportFiles = files.map((f) => ({ ...f, parsed: parseReportId(f.id) }));
      reportFilesPage = 0;
      populateReportFilters();
      renderReportFilesPage();
    } catch (error) {
      reportFilesList.innerHTML = `<p class="muted">加载报告列表失败：${escapeHtml(error.message)}</p>`;
    }
  }

  // 由 app.js 在 `await ensureAuthenticated()` 之后调用。不能在 create 时传值：
  // 那时认证还没跑完，canConfig 未知。
  function setCanConfig(canConfig) {
    currentUserCanConfig = Boolean(canConfig);
  }

  return { setCanConfig, refresh: loadReportFiles };    // refresh 暴露给 app.js 的刷新按钮调用
}
