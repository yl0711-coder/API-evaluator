// server/auto-test-digest.mjs
// 「自动测试巡检报告」的纯格式化内核：把已聚合好的巡检数据渲染成 Markdown（数据源无关，便于单测）。
// 数据的采集（loadJobs / buildProfileTrend / 告警）在 server.mjs 端点里做；这里只负责成文与配图。
// 每个模型一张「稳定性趋势」图：复用 shared/trend-chart.mjs 的纯函数 renderTrendChart（数字 → SVG 字符串），
// 用专用 ```chart-svg 围栏交给 report-html.mjs 原样内联（见该文件的可信 SVG 穿透）。
// 注意：从 shared/（而非前端 src/）import——后端引 src/ 会因生产镜像不打包 src/ 启动崩溃。
import { renderTrendChart } from "../shared/trend-chart.mjs";

const KIND_LABELS = { quick: "快速验证", admission: "准入评测", stability: "稳定性", scenario: "场景测试" };

const isNum = (v) => Number.isFinite(Number(v));
const pct = (v) => (isNum(v) ? `${Math.round(Number(v) * 100)}%` : "-");
const ms = (v) => (isNum(v) ? `${Math.round(Number(v))}ms` : "-");
const dt = (iso) => (iso ? String(iso).replace("T", " ").slice(0, 16) : "-");
// 表格单元格：转义竖线与换行，避免撑破 Markdown 表格（report-html 会把 \| 还原成字面量）。
const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "-";

export function windowLabel(hours) {
  const h = Number(hours);
  if (h === 24) return "最近 24 小时";
  if (h === 168) return "最近 7 天";
  if (h === 720) return "最近 30 天";
  return `最近 ${isNum(h) ? h : "?"} 小时`;
}

// 成功率环比：与上期比，给出 ↑/↓ 百分点，无上期/无值 → 空串。
function deltaPct(cur, prev) {
  if (!isNum(cur) || !isNum(prev)) return "";
  const dpp = Math.round((Number(cur) - Number(prev)) * 100);
  if (dpp === 0) return "（持平）";
  return dpp > 0 ? `（↑${dpp}pp）` : `（↓${Math.abs(dpp)}pp）`;
}

export function formatAutoTestDigestReport(data = {}, { now = null, chartNonce = "" } = {}) {
  const windowHours = data.windowHours;
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const targets = Array.isArray(data.targets) ? data.targets : [];
  const regressionAlerts = Array.isArray(data.regressionAlerts) ? data.regressionAlerts : [];
  const highRiskAlerts = Array.isArray(data.highRiskAlerts) ? data.highRiskAlerts : [];

  const lines = [];
  lines.push("# 自动测试巡检报告");
  lines.push("");
  lines.push(
    `**时间窗口**：${windowLabel(windowHours)} · **生成时间**：${dt(data.generatedAt || (now ? now.toISOString() : null))} · ` +
      `**覆盖作业**：${jobs.length} 个 · **覆盖模型**：${targets.length} 个`,
  );
  if (data.scopeLabel) lines.push(`**范围**：${data.scopeLabel}`);
  lines.push("");

  // ——需要关注（置顶）——
  lines.push("## 需要关注");
  const attention = [];
  for (const j of jobs) {
    if (j.autoDisabled) attention.push(`作业「${j.name || j.targetLabel || j.targetId}」已因连续失败被自动停用，请核查上游/配置。`);
    else if (j.overdue) attention.push(`作业「${j.name || j.targetLabel || j.targetId}」已过计划时间仍未运行（下次计划 ${dt(j.nextRunAt)}），可能调度停滞。`);
    else if (isNum(j.consecutiveFailures) && Number(j.consecutiveFailures) > 0)
      attention.push(`作业「${j.name || j.targetLabel || j.targetId}」连续失败 ${j.consecutiveFailures} 次${j.lastError ? `：${j.lastError}` : ""}。`);
  }
  for (const t of targets) {
    if (t.regression && t.regression.status === "regressed") {
      const detail = (t.regression.changes || []).map((c) => c.detail).filter(Boolean).join("；");
      attention.push(`模型「${t.label}${t.model ? " · " + t.model : ""}」疑似退化：${detail || t.regression.verdict || "见趋势"}。`);
    }
  }
  for (const a of regressionAlerts) attention.push(`回归告警（${a.severity || "-"}）：${a.profile_name || ""} ${a.summary || ""}`.trim());
  for (const a of highRiskAlerts) attention.push(`高危报告：${a.title || a.summary || a.reportId || "见报告中心"}`);
  if (attention.length) {
    for (const item of attention) lines.push(`- ${item}`);
  } else {
    lines.push("✅ 本周期未见回归、高危或作业异常。");
  }
  lines.push("");

  // ——执行概览（调度健康）——
  lines.push("## 执行概览（调度健康）");
  if (jobs.length) {
    lines.push("| 作业 | 种类 | 目标模型 | 启用 | 周期(h) | 上次运行 | 上次结果 | 下次计划 | 窗口内运行 | 连续失败 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const j of jobs) {
      const status = j.autoDisabled ? "已自动停用" : j.overdue ? "⚠️ 逾期未跑" : j.lastStatus || "-";
      lines.push(
        `| ${cell(j.name || "-")} | ${cell(KIND_LABELS[j.kind] || j.kind || "-")} | ${cell(`${j.targetLabel || ""}${j.model ? " · " + j.model : ""}`)} | ` +
          `${j.enabled ? "是" : "否"} | ${cell(j.periodHours)} | ${cell(dt(j.lastRunAt))} | ${cell(status)} | ${cell(dt(j.nextRunAt))} | ` +
          `${cell(j.runsInWindow ?? "-")} | ${cell(j.consecutiveFailures || 0)} |`,
      );
    }
  } else {
    lines.push("_尚未配置任何自动测试作业。本报告改按「窗口内测过的模型」汇总。_");
  }
  lines.push("");

  // ——逐模型小结——
  lines.push("## 逐模型小结");
  if (targets.length) {
    lines.push("| 模型 | 窗口内运行 | 最近准入 | 稳定性成功率 | P95 | 与上期 |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const t of targets) {
      const latest = t.latest || null;
      const d = deltaPct(latest?.successRate, t.prev?.successRate);
      lines.push(
        `| ${cell(`${t.label}${t.model ? " · " + t.model : ""}`)} | ${cell(t.runsInWindow ?? 0)} | ${cell(latest?.grade || "-")} | ` +
          `${pct(latest?.successRate)} | ${ms(latest?.p95Ms)} | ${cell(d || "-")} |`,
      );
    }
  } else {
    lines.push("_窗口内没有任何模型的测试运行。_");
  }
  lines.push("");

  // ——稳定性趋势（每模型一张）——
  lines.push("## 稳定性趋势（每模型一张）");
  lines.push("");
  lines.push("成功率(左轴) + 耗时(右轴) 双轴同图，含稳定性运行与「基础」场景轮次（融合）。");
  lines.push("");
  if (targets.length) {
    for (const t of targets) {
      lines.push(`### ${t.label}${t.model ? " · " + t.model : ""}`);
      const rounds = Array.isArray(t.rounds) ? t.rounds : [];
      if (rounds.length) {
        const svg = renderTrendChart(rounds, "count");
        // nonce 标记的可信图表围栏：只有 report-html.mjs 收到同一 nonce 才会原样内联此 SVG，
        // 不可信正文即便伪造 ```chart-svg / ```svg 也因 nonce 不符而被转义。
        lines.push(`\`\`\`chart-svg${chartNonce ? ":" + chartNonce : ""}`);
        lines.push(`<div style="background:#0b1220;border-radius:12px;padding:12px;margin:8px 0;overflow-x:auto">${svg}</div>`);
        lines.push("```");
      } else {
        lines.push("_窗口内暂无可绘制的逐轮数据。_");
      }
      lines.push("");
    }
  } else {
    lines.push("_无可绘制的模型。_");
    lines.push("");
  }

  // ——方法学与免责——
  lines.push("## 方法学与免责");
  lines.push("- 巡检范围＝已配置的自动测试作业的目标模型；无作业时回退为窗口内测过的模型。");
  lines.push("- 稳定性成功率/P95 取窗口内最近一次运行；「基础」场景轮次按分组并入稳定性趋势（见「稳定性趋势」页说明）。");
  lines.push("- 回归判定以同类历史中位数为基线（成功率跌 ≥10pp / P95 恶化 ≥1.5× / 准入等级下滑 ≥2 档），为「疑似退化，建议复核」，非铁证。");
  lines.push("- 本报告由平台本地生成，只读既有测试数据，不发起新测试、不含 API Key。");
  lines.push("");

  return lines.join("\n");
}
