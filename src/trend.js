// src/trend.js
// 趋势图页：逐轮质量/延迟趋势 + 退化检测 + 历史告警。
//
// 从 app.js 整块搬出（16 号报告 C1 第二阶段）。代码**逐字未改**——纯搬运才能用构建产物比对证明等价。
//
// 依赖：api、escapeHtml、renderTrendChart、createCascadeTargetPicker，
// 全部通过 deps 注入。级联通过 onProfileData 自注册。
export function createTrend({ state, els, onProfileData, deps }) {
  const { api, escapeHtml, renderTrendChart, createCascadeTargetPicker } = deps;

  // 趋势图专属级联（渠道 → 模型）
  const cascade = createCascadeTargetPicker(els.trendChannelSelect, els.trendProfileSelect);
  onProfileData((data) => cascade.refresh(data));

  let trendXMode = "count"; // 趋势图 x 轴：'count'(按轮次) | 'hour'(按小时聚合)
  let trendWindowHours = 0; // 按时间模式的时间范围：0=全部，或 3/6/12/24/48/168 小时
  let trendLastRounds = []; // 最近一次拉到的逐轮数据，切换 x 轴时复用、不重复请求

  async function updateView(profileId) {
    if (!profileId) return;
    els.trendChart.innerHTML = "加载中...";
    els.trendTable.textContent = "加载中...";
    els.trendAlerts.textContent = "加载中...";
    els.trendRegression.classList.add("hidden");
    try {
      const data = await api(`/api/trend?profileId=${encodeURIComponent(profileId)}`);
      const series = data.series || [];
      trendLastRounds = data.rounds || [];
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

  els.trendProfileSelect.addEventListener("change", () => updateView(els.trendProfileSelect.value));
  document.querySelector('.nav-button[data-page="trend"]')?.addEventListener("click", () => updateView(els.trendProfileSelect.value));
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
