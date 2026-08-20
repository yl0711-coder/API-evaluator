// src/trend.js
// 趋势图页：逐轮质量/延迟趋势 + 退化检测 + 历史告警。
//
// 从 app.js 整块搬出（16 号报告 C1 第二阶段）。搬运时代码逐字未改——纯搬运才能用构建产物比对证明等价。
// 此后的功能改动（CSV 导出）是在搬运完成之后加的，等价性证明只覆盖到搬运那一刻。
//
// 依赖：api、escapeHtml、renderTrendChart、createCascadeTargetPicker，
// 全部通过 deps 注入。级联通过 onProfileData 自注册。
//
// CSV 导出（拿趋势数据做数据分析）：表格拼装在 src/trend-export.js（纯函数、可单测），
// 这里只负责取当前选中的渠道/模型名 + 触发下载。
import { downloadText, toast } from "./client-utils.js";
import { buildTrendRoundsCsv, buildTrendSeriesCsv, trendExportFilename } from "./trend-export.js";

export function createTrend({ state, els, onProfileData, deps }) {
  const { api, escapeHtml, renderTrendChart, createCascadeTargetPicker } = deps;

  // 趋势图专属级联（渠道 → 模型）
  const cascade = createCascadeTargetPicker(els.trendChannelSelect, els.trendProfileSelect);
  onProfileData((data) => cascade.refresh(data));

  let trendXMode = "count"; // 趋势图 x 轴：'count'(按轮次) | 'hour'(按小时聚合)
  let trendWindowHours = 0; // 按时间模式的时间范围：0=全部，或 3/6/12/24/48/168 小时
  let trendLastRounds = []; // 最近一次拉到的逐轮数据，切换 x 轴时复用、不重复请求
  let trendLastSeries = []; // 同上，历次运行点；供 CSV 导出（导出用全量，不套用图上的时间范围）

  async function updateView(profileId) {
    if (!profileId) return;
    els.trendChart.innerHTML = "加载中...";
    els.trendTable.textContent = "加载中...";
    els.trendAlerts.textContent = "加载中...";
    els.trendRegression.classList.add("hidden");
    // 先清空缓存再请求：否则请求失败时，导出按钮若被点到会拿上一个模型的数据、套着新模型的名字导出。
    trendLastSeries = [];
    trendLastRounds = [];
    setExportEnabled(false);
    try {
      const data = await api(`/api/trend?profileId=${encodeURIComponent(profileId)}`);
      const series = data.series || [];
      trendLastRounds = data.rounds || [];
      trendLastSeries = series;
      setExportEnabled(true);
      redraw();
      const reg = data.regression;
      if (reg && reg.status === "regressed") {
        els.trendRegression.classList.remove("hidden");
        els.trendRegression.innerHTML = `<strong>⚠️ 疑似退化（${reg.severity}）</strong><br>${(reg.changes || []).map((c) => escapeHtml(c.detail)).join("<br>")}`;
      } else if (reg && reg.status === "stable") {
        els.trendRegression.classList.remove("hidden");
        els.trendRegression.textContent = "✅ 与基线一致，未见退化";
      }
      els.trendTable.textContent = series.length
        ? series
            .slice()
            .reverse()
            .map(
              (p) =>
                `${String(p.at || "")
                  .replace("T", " ")
                  .slice(
                    0,
                    19,
                  )} | ${p.type} | 成功率 ${p.successRate != null ? Math.round(p.successRate * 100) + "%" : "-"} | P95 ${p.p95Ms ?? "-"}ms${p.grade ? " | " + p.grade : ""}${p.cost != null ? " | $" + p.cost : ""}`,
            )
            .join("\n")
        : "暂无历史。";
      const alerts = data.alerts || [];
      els.trendAlerts.textContent = alerts.length
        ? alerts
            .map(
              (a) =>
                `${String(a.created_at || "")
                  .replace("T", " ")
                  .slice(0, 19)} | ${a.severity} | ${a.summary}`,
            )
            .join("\n")
        : "暂无告警。";
    } catch (error) {
      els.trendChart.textContent = `加载失败：${error.message}`;
    }
  }

  // 用当前 x 轴 / 时间范围重绘（复用最近一次逐轮数据，不重复请求）。时间范围只在按时间模式生效。
  function redraw() {
    els.trendChart.innerHTML = renderTrendChart(trendLastRounds, trendXMode, {
      windowHours: trendXMode === "hour" ? trendWindowHours : 0,
    });
  }

  // 导出按钮：没数据时禁用，避免导出一张只有表头的空表。
  function setExportEnabled(enabled) {
    els.trendExportSeries.disabled = !enabled || !trendLastSeries.length;
    els.trendExportRounds.disabled = !enabled || !trendLastRounds.length;
  }

  // 当前所选渠道/模型的中文名（下拉里的显示文本）——写进 CSV 每一行，
  // 于是多个模型各导一份后可直接首尾相接成一张大表，行仍可区分。
  function selectedLabels() {
    const pick = (select) => select.options[select.selectedIndex]?.textContent?.trim() || "";
    return { channelLabel: pick(els.trendChannelSelect), modelLabel: pick(els.trendProfileSelect) };
  }

  function exportCsv(kind) {
    const rows = kind === "rounds" ? trendLastRounds : trendLastSeries;
    if (!rows.length) {
      toast("当前模型还没有可导出的数据。", true);
      return;
    }
    const meta = selectedLabels();
    const csv = kind === "rounds" ? buildTrendRoundsCsv(trendLastRounds, meta) : buildTrendSeriesCsv(trendLastSeries, meta);
    // BOM 是必需的：没有它，Excel 用系统 ANSI 码页打开，中文表头和渠道名全是乱码。
    downloadText(trendExportFilename(kind, meta), `﻿${csv}`, "text/csv");
    toast(`已导出 ${rows.length} 行。`);
  }

  els.trendProfileSelect.addEventListener("change", () => updateView(els.trendProfileSelect.value));
  document.querySelector('.nav-button[data-page="trend"]')?.addEventListener("click", () => updateView(els.trendProfileSelect.value));
  els.trendExportSeries.addEventListener("click", () => exportCsv("series"));
  els.trendExportRounds.addEventListener("click", () => exportCsv("rounds"));
  // 切换 x 轴（按轮次 / 按小时）：时间范围选择器仅在「按时间」时显示；切换即重绘。
  els.trendXModeSelect.addEventListener("change", () => {
    trendXMode = els.trendXModeSelect.value === "hour" ? "hour" : "count";
    els.trendWindowField.classList.toggle("hidden", trendXMode !== "hour");
    redraw();
  });
  // 切换时间范围（3/6/12/24/48/168 小时或全部）：仅重绘。
  els.trendWindowSelect.addEventListener("change", () => {
    trendWindowHours = Number(els.trendWindowSelect.value) || 0;
    redraw();
  });

  return { updateView };
}
