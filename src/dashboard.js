// src/dashboard.js
// 仪表盘页：渠道健康 / 结论分布 / 待办 / 最近报告 / 工作流引导。
//
// 从 app.js 整块搬出（16 号报告 C1 第二阶段）。代码**逐字未改**——纯搬运才能用构建产物比对证明等价。
//
// 依赖：escapeHtml（纯函数）、resolveRunnableTargets（纯函数）、buildWorkflowStatus / getNextWorkflowStep / renderNextActionHtml（工作流引导）
// 全部通过 deps 注入；模块自身不 import 任何文件（零外部耦合）。
export function createDashboard({ state, els, deps }) {
  const { escapeHtml, resolveRunnableTargets, buildWorkflowStatus, getNextWorkflowStep, renderNextActionHtml, showPage } = deps;

  // 总览用的"可运行测试目标"：统一走 resolveRunnableTargets（单一事实源）。
  function runnableTargets() {
    return resolveRunnableTargets(state);
  }

  function render() {
    const hasProfiles = runnableTargets().length > 0;
    els.dashboardEmpty.classList.toggle("hidden", hasProfiles);
    els.dashboardPopulated.classList.toggle("hidden", !hasProfiles);
    renderWorkflowGuide();
    renderDashboardStatus();
    renderDashboardRecent();
  }

  // recommendation.level → 结论展示（pass/watch/fail）
  function dashVerdict(run) {
    const level = run?.recommendation?.level;
    if (level === "pass") return { cls: "good", label: "推荐" };
    if (level === "watch") return { cls: "warn", label: "观察" };
    if (level === "fail") return { cls: "bad", label: "不推荐" };
    return null;
  }

  function dashTypeLabel(type) {
    const map = {
      admission: "准入评测",
      "batch-admission": "批量准入",
      "batch-stability": "批量稳定性",
      scenario: "场景测试",
      stability: "稳定性测试",
      "load-test": "压力测试",
    };
    return map[type] || "稳定性测试";
  }

  function dashFormatMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return "";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
  }

  function dashRelTime(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const diff = Date.now() - t;
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }

  function renderDashboardStatus() {
    const targets = runnableTargets();
    const runs = state.testRuns || []; // newest-first

    // 渠道健康：每个被测渠道按最近一次有结论的运行聚合；无运行 → 未测
    const latest = new Map();
    for (const run of runs) {
      const id = run.profileId || run.profileName;
      if (id && !latest.has(id)) latest.set(id, run);
    }
    let good = 0;
    let warn = 0;
    let bad = 0;
    let idle = 0;
    for (const p of targets) {
      const v = dashVerdict(latest.get(p.id) || latest.get(p.name));
      if (!v) idle += 1;
      else if (v.cls === "good") good += 1;
      else if (v.cls === "warn") warn += 1;
      else bad += 1;
    }
    els.statChannels.innerHTML = `${targets.length} <em>个测试目标</em>`;
    // 健康占比条：按 正常/观察/异常/未测 的数量做 flex 比例
    els.statChannelsBars.innerHTML =
      targets.length === 0
        ? `<i style="flex:1;background:var(--line)"></i>`
        : [
            good ? `<i style="flex:${good};background:var(--good)"></i>` : "",
            warn ? `<i style="flex:${warn};background:var(--accent)"></i>` : "",
            bad ? `<i style="flex:${bad};background:var(--bad)"></i>` : "",
            idle ? `<i style="flex:${idle};background:var(--muted)"></i>` : "",
          ]
            .filter(Boolean)
            .join("");
    els.statChannelsChips.innerHTML =
      targets.length === 0
        ? `<span class="chip muted-chip"><i style="background:var(--muted)"></i>暂无被测渠道</span>`
        : [
            good ? `<span class="chip good"><i></i>${good} 正常</span>` : "",
            warn ? `<span class="chip warn"><i></i>${warn} 需观察</span>` : "",
            bad ? `<span class="chip bad"><i></i>${bad} 异常</span>` : "",
            idle ? `<span class="chip idle muted-chip"><i></i>${idle} 未测</span>` : "",
          ]
            .filter(Boolean)
            .join("");

    // 最近结论：按 recommendation.level 统计
    let pass = 0;
    let watchN = 0;
    let fail = 0;
    for (const run of runs) {
      const v = dashVerdict(run);
      if (v?.cls === "good") pass += 1;
      else if (v?.cls === "warn") watchN += 1;
      else if (v?.cls === "bad") fail += 1;
    }
    els.statVerdicts.innerHTML = `${runs.length} <em>份报告</em>`;
    els.statVerdictsChips.innerHTML =
      runs.length === 0
        ? `<span class="chip muted-chip"><i style="background:var(--muted)"></i>还没有报告</span>`
        : `<span class="chip good"><i></i>推荐 ${pass}</span><span class="chip warn"><i></i>观察 ${watchN}</span><span class="chip bad"><i></i>不推荐 ${fail}</span>`;

    // 待办：疑似计费（tokenAuditFindings 含 high/medium）+ 待复测（最近为观察的渠道）
    let billing = 0;
    for (const run of runs) {
      const findings = run.tokenAuditFindings || [];
      if (findings.some((f) => f && (f.level === "high" || f.level === "medium"))) billing += 1;
    }
    const todoCount = warn + billing;
    els.statTodos.innerHTML = `${todoCount} <em>项</em>`;
    els.statTodosChips.innerHTML =
      todoCount === 0
        ? `<span class="chip muted-chip"><i style="background:var(--muted)"></i>暂无待办</span>`
        : [
            warn ? `<span class="chip blue"><i></i>${warn} 待复测</span>` : "",
            billing ? `<span class="chip bad"><i></i>${billing} 疑似计费异常</span>` : "",
          ]
            .filter(Boolean)
            .join("");
  }

  function renderDashboardRecent() {
    const runs = (state.testRuns || []).slice(0, 5);
    if (runs.length === 0) {
      els.dashboardRecent.innerHTML = `<p class="muted" style="padding:10px 12px">还没有测试报告。完成一次准入或标准评测后，这里会显示最近结论。</p>`;
      return;
    }
    els.dashboardRecent.innerHTML = runs
      .map((run) => {
        const v = dashVerdict(run);
        const pill = v ? `<span class="verdict-pill ${v.cls}">${v.label}</span>` : `<span class="verdict-pill idle">—</span>`;
        const metricBits = [];
        if (run.successRateText) metricBits.push(escapeHtml(run.successRateText));
        if (run.p95TotalMs) metricBits.push(`P95 ${dashFormatMs(run.p95TotalMs)}`);
        return `<div class="rep-row" data-go-page="reports">
        <div class="who"><b>${escapeHtml(run.profileName || "未命名渠道")}</b><small>${escapeHtml(run.model || "")}</small></div>
        <div class="kind">${escapeHtml(dashTypeLabel(run.type))}</div>
        ${pill}
        <div class="when">${escapeHtml(dashRelTime(run.endedAt || run.startedAt))}</div>
        <div class="go">›</div>
      </div>`;
      })
      .join("");
  }

  function renderWorkflowGuide() {
    const status = buildWorkflowStatus(state);
    const next = getNextWorkflowStep(status);

    els.nextAction.innerHTML = renderNextActionHtml(next);
    els.nextAction.querySelector("[data-go-page]").addEventListener("click", () => showPage(next.page));

    els.workflowSteps.forEach((step) => {
      const key = step.dataset.step;
      step.classList.toggle("done", Boolean(status[key]));
      step.classList.toggle("current", key === next.step);
    });
  }

  return { render };
}
