// src/model-profile.js
// 「模型档案」页（总结与交付栏，登录即可用）：把某个渠道下某个模型的三类信息收在一处 ——
// ①各项指标（含每项自己的历史曲线）②90 天可用性 + 逐轮趋势 ③它名下的报告文件。
//
// 数据全部来自服务端：GET /api/model-profile?targetId=（server/model-profile.mjs 组装的契约）
// + GET /api/reports/files（报告列表，按渠道/模型筛，复用 report-id.js 的改名归并逻辑）。
//
// 前端【绝不】自算准入结论：等级/综合分/硬门槛三态直接展示服务端给的字段，
// 聚合判定归服务端独有（与任务中心同一条规矩）。
//
// 视觉风格刻意与全站其它页不同（衬线标题 + 无框排版），样式全部作用域在 #model-profile 之下。
import { api } from "./api-client.js";
import { escapeHtml, formatDateTime, protocolLabel } from "./client-utils.js";
import { requireElement } from "./dom-utils.js";
import { renderTrendChart } from "../shared/trend-chart.mjs";
import { renderSparkline } from "../shared/sparkline.mjs";
import { renderUptimeStrip, summarizeUptime } from "../shared/uptime-strip.mjs";
import { matchesReportFilter, parseReportId } from "./report-id.js";
import { openReportOverlay } from "./report-overlay.js";
import { resolveRunnableTargets } from "./runnable-targets.js";

const REPORT_TYPE_LABELS = {
  admission: "准入评测",
  "admission-batch": "批量准入",
  scenario: "场景测试",
  run: "稳定性测试",
  compare: "模型对比",
  autodigest: "自动巡检",
  load: "压力测试",
  "load-test": "压力测试",
  batch: "批量稳定性",
  quickverify: "快速验证",
  supplier: "上游证据包",
  client: "客户端回放",
  replay: "客户端回放",
};

const REPORT_PAGE_SIZE = 12;
const TIER_COLORS = { 基础: "var(--mp-ok)", 进阶: "var(--mp-accent)", 困难: "var(--mp-warn)", 极难: "var(--mp-bad)" };

// 健康阈值。集中在这里而不是散在各处渲染函数里，改口径只需改一处。
// 与 shared/thresholds.mjs 的用途不同（那个是服务端判定用），这里只影响展示着色。
const HIGHER_BETTER = {
  "stability-rate": [0.99, 0.95],
  "scenario-pass": [0.95, 0.85],
  quality: [85, 70],
  "admission-score": [85, 70],
};
const LOWER_BETTER = { "p95-latency": [8000, 15000], "first-token": [1000, 2000] };

function healthOf(id, value) {
  if (!Number.isFinite(value)) return "idle";
  if (HIGHER_BETTER[id]) return value >= HIGHER_BETTER[id][0] ? "good" : value >= HIGHER_BETTER[id][1] ? "warn" : "bad";
  if (LOWER_BETTER[id]) return value <= LOWER_BETTER[id][0] ? "good" : value <= LOWER_BETTER[id][1] ? "warn" : "bad";
  return "idle";
}

const fmtPct = (v, digits = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : "-");
const fmtNum = (v, digits = 1) => (Number.isFinite(v) ? v.toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "-");
const fmtMs = (v) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString("zh-CN")} ms` : "-");
const fmtTokens = (v) => (Number.isFinite(v) ? v.toLocaleString("zh-CN") : "-");
const fmtBytes = (b) => (b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);

/**
 * 异常点判定：偏离该序列自身中位数超过阈值即标记。
 * 刻意用序列自身的中位数而非全局阈值 —— sparkline 表达的是「这条线自己的形状」：
 * 一个 P95 常年 15s 的模型，15s 不是异常；常年 2s 的模型，15s 才是。
 */
function anomalyDetector(values, direction) {
  const nums = (values || []).filter(Number.isFinite);
  if (nums.length < 4) return undefined;
  const sorted = nums.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return undefined;
  return (v) => (direction === "lower" ? v > median * 1.6 : v < median * 0.9);
}

export function createModelProfile({ state, deps }) {
  const { createCascadeTargetPicker } = deps;

  const channelSelect = requireElement("#mp-channel");
  const modelSelect = requireElement("#mp-model");
  const titleElement = requireElement("#mp-title");
  const dekElement = requireElement("#mp-dek");
  const ledeElement = requireElement("#mp-lede");
  const uptimeSub = requireElement("#mp-uptime-sub");
  const uptimeStrip = requireElement("#mp-uptime-strip");
  const uptimeTicks = requireElement("#mp-uptime-ticks");
  const metricsTable = requireElement("#mp-metrics");
  const metricsCaption = requireElement("#mp-metrics-caption");
  const flagsList = requireElement("#mp-flags");
  const tiersTable = requireElement("#mp-tiers");
  const regressionBox = requireElement("#mp-regression");
  const trendChart = requireElement("#mp-trend-chart");
  const alertCount = requireElement("#mp-alert-count");
  const alertsTable = requireElement("#mp-alerts");
  const scenariosTable = requireElement("#mp-scenarios");
  const scTier = requireElement("#mp-sc-tier");
  const scSort = requireElement("#mp-sc-sort");
  const reportsTable = requireElement("#mp-reports");
  const pager = requireElement("#mp-pager");
  const repType = requireElement("#mp-rep-type");
  const repRange = requireElement("#mp-rep-range");
  const trendXMode = requireElement("#mp-trend-xmode");
  const trendWindow = requireElement("#mp-trend-window");
  const PARTS = ["uptime", "metrics", "obs", "tiers", "trend", "scenarios", "reports"].map((k) => requireElement(`#mp-part-${k}`));

  const cascade = createCascadeTargetPicker(channelSelect, modelSelect);

  let view = null; // 当前 /api/model-profile 的结果
  let reportFiles = []; // 当前模型名下的报告（已按渠道/模型筛过）
  let reportPage = 0;
  let xMode = "count";
  let windowHours = 0;
  // 请求序号：切换模型时丢弃迟到的旧响应，否则慢请求会把上一个模型的数据画到当前页上。
  let requestSeq = 0;

  function setPartsVisible(visible) {
    for (const part of PARTS) part.hidden = !visible;
  }

  async function load() {
    // 进页面时刷新一次级联（渠道/模型可能在别处改过），并尽量保留已选值。
    cascade.refresh({ modelTargets: state.modelTargets, channels: state.channels, profiles: state.profiles });
    // 无论有没有选中值都走 loadTarget：没选中时它负责渲染空状态文案
    // （区分「还没选」与「压根没有模型目标」），否则页面会停在初始的 HTML 占位文字上。
    await loadTarget(modelSelect.value);
  }

  function refreshTargets(data) {
    cascade.refresh(data);
  }

  // 程序化选中某个模型目标（供 ?targetId= 深链用）。silent：只回填下拉、不触发 change，
  // 避免与紧随其后的 load() 各拉一次接口。
  function selectTarget(targetId) {
    cascade.setValue(targetId, { silent: true });
  }

  // 把当前选中的模型写进地址栏（replaceState，不塞浏览器历史——连点几个模型后
  // 用户按后退应该回到主站，而不是在几个模型之间倒退）。
  // 只在独立页面上有意义；嵌在主站 SPA 里时地址栏是主站的，故用 history.replaceState 保守处理：
  // 仅改 query，不动路径。
  function syncUrl(targetId) {
    if (typeof history?.replaceState !== "function") return;
    try {
      const url = new URL(location.href);
      if (targetId) url.searchParams.set("targetId", targetId);
      else url.searchParams.delete("targetId");
      history.replaceState(null, "", url);
    } catch {
      /* 地址栏同步是锦上添花，失败不影响页面 */
    }
  }

  async function loadTarget(targetId) {
    if (!targetId) {
      setPartsVisible(false);
      dekElement.textContent = "";
      // 区分「有模型可选但还没选」与「压根没有可运行的模型目标」——后者下拉本来就是空的，
      // 若还提示「请先选择」，用户会以为是页面坏了而不是尚未配置。
      const hasTargets = resolveRunnableTargets(state).length > 0;
      if (hasTargets) {
        titleElement.textContent = "请先选择渠道与模型";
        ledeElement.textContent = "选择一个模型后，这里给出一段可直接对外交付的结论摘要。";
      } else {
        titleElement.textContent = "还没有可查看的模型";
        ledeElement.innerHTML =
          "档案页只读既有报告与历史记录，所以需要先有<b>模型目标</b>。请到「模型管理」新建一个（选渠道 + 填模型名），跑过任意一次测试后再回来。";
      }
      return;
    }
    const seq = ++requestSeq;
    titleElement.textContent = "读取中…";
    dekElement.textContent = "";
    ledeElement.textContent = "正在汇总该模型的既有报告与历史记录…";
    setPartsVisible(false);
    try {
      // 两个请求并行：档案本体 + 报告文件列表（后者是全量的，需前端按渠道/模型筛）。
      const [profile, files] = await Promise.all([
        api(`/api/model-profile?targetId=${encodeURIComponent(targetId)}`),
        api("/api/reports/files").catch(() => []), // 报告列表失败不该让整页崩，档案本体更重要
      ]);
      if (seq !== requestSeq) return; // 已切到别的模型，丢弃本次结果
      view = profile;
      reportFiles = filterFilesForTarget(files, profile.target);
      reportPage = 0;
      renderAll();
      setPartsVisible(true);
    } catch (error) {
      if (seq !== requestSeq) return;
      view = null;
      titleElement.textContent = "读取失败";
      dekElement.textContent = "";
      ledeElement.innerHTML = `读取该模型的档案失败：${escapeHtml(error.message)}`;
      setPartsVisible(false);
    }
  }

  // 报告列表按渠道/模型筛。复用 report-id.js 的 matchesReportFilter + aliases 归并，
  // 不另写一套匹配 —— 渠道/模型改名后旧报告靠 aliases 才能归并进来。
  function filterFilesForTarget(files, target) {
    const aliasMaps = { channel: {}, model: {} };
    for (const channel of state.channels || []) {
      for (const alias of Array.isArray(channel.aliases) ? channel.aliases : [])
        if (alias && channel.name) aliasMaps.channel[alias] = channel.name;
    }
    for (const item of state.modelTargets || []) {
      for (const alias of Array.isArray(item.aliases) ? item.aliases : []) if (alias && item.model) aliasMaps.model[alias] = item.model;
    }
    const filter = { channel: target.channel || "", model: target.model || "", type: "", from: "", to: "" };
    return (files || [])
      .map((f) => ({ ...f, parsed: parseReportId(f.id) }))
      .filter((f) => matchesReportFilter(f.parsed, filter, aliasMaps));
  }

  function renderAll() {
    renderMast();
    renderLede();
    renderUptime();
    renderMetrics();
    renderFlags();
    renderTiers();
    renderTrend();
    renderScenarioFilters();
    renderScenarios();
    renderReportFilters();
    renderReports();
  }

  // —— 刊头 ——
  function renderMast() {
    const t = view.target;
    titleElement.textContent = t.label;
    const counts = view.reportCounts;
    dekElement.textContent = [
      protocolLabel(t.protocol),
      `依据 ${counts.total} 份既有报告（稳定性 ${counts.run} · 场景 ${counts.scenario} · 准入 ${counts.admission} · 压测 ${counts.load}）`,
      t.lastTestedAt ? `最近测试 ${formatDateTime(t.lastTestedAt)}` : "尚未测试",
      t.channelStatus === "disabled" ? "渠道已停用" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // —— 摘要段：结论写成一句话，关键数字内联、趋势直接嵌在数字后面 ——
  // Tufte 的主张：别把图形和文字隔离开，标签紧贴它描述的数据。
  function renderLede() {
    const inline = (id, direction, label) => {
      const values = view.histories?.[id]?.values;
      if (!values || values.length < 2) return "";
      return `<span class="mp-inline-spark">${renderSparkline(values, {
        width: 54,
        height: 15,
        anomaly: anomalyDetector(values, direction),
        ariaLabel: label,
      })}</span>`;
    };

    const bits = [];
    const admission = view.admission;
    if (admission?.grade) {
      const cls = admission.grade === "A" ? "good" : /^[BC]$/.test(admission.grade) ? "warn" : "bad";
      const gates = admission.hardGates || {};
      // A 级除分数外还硬要求工具/JSON/流式三项全过（评分标准里容易漏看的门槛）。
      // 三态：false 明确未通过、null 本次没测 —— 两者要说清，不能都说成「未通过」。
      const failed = Object.entries({ "JSON 模式": gates.json, 工具调用: gates.tool, 流式响应: gates.stream })
        .filter(([, v]) => v === false)
        .map(([k]) => k);
      const untested = Object.entries({ "JSON 模式": gates.json, 工具调用: gates.tool, 流式响应: gates.stream })
        .filter(([, v]) => v === null)
        .map(([k]) => k);
      let gateText = "工具调用、JSON 模式、流式响应三项硬门槛全过";
      if (failed.length) gateText = `${failed.join("、")}未通过硬门槛，因此评不到 A 级`;
      else if (untested.length) gateText = `${untested.join("、")}本次未测，硬门槛结论不完整`;
      bits.push(
        `最近一次准入评为 <b class="mp-g-${cls}">${escapeHtml(admission.grade)} 级</b>${
          Number.isFinite(admission.composite) ? `（综合 <b>${fmtNum(admission.composite)}</b> 分）` : ""
        }${inline("admission-score", "higher", "准入综合分趋势")}，${escapeHtml(gateText)}。`,
      );
    } else {
      bits.push("这个模型<b>还没有准入评测报告</b>，等级与硬门槛结论暂缺。");
    }

    const stab = view.stability;
    if (stab && Number.isFinite(stab.rate)) {
      bits.push(
        `近 ${view.reportCounts.run} 份稳定性报告池化后成功率 <b>${fmtPct(stab.rate)}</b>${inline("stability-rate", "higher", "成功率趋势")}（${stab.succ}/${stab.total} 轮）`,
      );
    }
    if (Number.isFinite(view.scenarioPass?.rate)) {
      bits.push(`场景通过率 <b>${fmtPct(view.scenarioPass.rate)}</b>，平均质量 <b>${fmtNum(view.quality?.mean)}</b> 分`);
    }
    if (stab && Number.isFinite(stab.p95TotalMs)) {
      const reg = view.trend?.regression;
      bits.push(
        `P95 总耗时 <b>${fmtMs(stab.p95TotalMs)}</b>${inline("p95-latency", "lower", "P95 趋势")}${
          reg?.status === "regressed" ? `，<b class="mp-g-bad">已触发基线回归告警</b>` : reg?.status === "stable" ? "，与基线一致" : ""
        }`,
      );
    }
    const tokens = view.tokens;
    if (tokens && (tokens.input || tokens.output)) {
      bits.push(`累计消耗 <b>${fmtTokens((tokens.input || 0) + (tokens.output || 0))}</b> Token`);
    }
    ledeElement.innerHTML = bits.length ? `${bits.join("。").replace(/。。/g, "。")}。`.replace(/。。$/, "。") : "这个模型还没有任何报告。";
  }

  // —— Ⅰ 可用性条带 ——
  function renderUptime() {
    const days = view.uptime || [];
    const s = summarizeUptime(days);
    uptimeStrip.innerHTML = renderUptimeStrip(days, { height: 40, barWidth: 5, gap: 2 });
    // 覆盖率必须说出来：测试是人/定时任务触发的，不说清楚用户会把条带误读成连续监控。
    uptimeSub.innerHTML = days.length
      ? `最近 ${days.length} 天里实际测过 <b>${s.testedDays}</b> 天（覆盖 ${(s.coverage * 100).toFixed(0)}%），按运行数加权的总成功率 <b>${
          s.overallRate == null ? "—" : fmtPct(s.overallRate)
        }</b>；其中 ${s.goodDays} 天正常、${s.warnDays} 天降级、${s.badDays} 天故障。`
      : "还没有可用性历史。";
    // 日期刻度：均匀取 6 个，按比例定位（条带 preserveAspectRatio="none" 横向拉伸，比例严格对应）。
    const n = days.length;
    if (!n) {
      uptimeTicks.innerHTML = "";
      return;
    }
    const k = Math.min(6, n);
    uptimeTicks.innerHTML = Array.from({ length: k }, (_, i) => {
      const idx = k === 1 ? 0 : Math.round((i * (n - 1)) / (k - 1));
      const pct = n === 1 ? 50 : (idx / (n - 1)) * 100;
      return `<span style="left:${pct.toFixed(2)}%">${escapeHtml(days[idx].date.slice(5))}</span>`;
    }).join("");
  }

  // —— Ⅱ 指标表：数字与曲线同行 ——
  function metricRows() {
    const stab = view.stability || {};
    const knee = view.loadKnee;
    return [
      {
        id: "stability-rate",
        label: "稳定性成功率",
        value: stab.rate,
        text: fmtPct(stab.rate),
        denom: Number.isFinite(stab.succ) ? `${stab.succ}/${stab.total} 轮` : "-",
        detail: `近 ${view.coverage?.runReportLimit ?? 6} 份稳定性报告池化`,
        direction: "higher",
      },
      {
        id: "scenario-pass",
        label: "场景通过率",
        value: view.scenarioPass?.rate,
        text: fmtPct(view.scenarioPass?.rate),
        denom: Number.isFinite(view.scenarioPass?.succ) ? `${view.scenarioPass.succ}/${view.scenarioPass.total} 例` : "-",
        detail: "全部已测场景池化",
        direction: "higher",
      },
      {
        id: "quality",
        label: "平均质量分",
        value: view.quality?.mean,
        text: fmtNum(view.quality?.mean),
        denom: `${view.quality?.n ?? 0} 个场景`,
        detail: "有质量分的场景取均值",
        direction: "higher",
      },
      {
        id: "admission-score",
        label: "准入综合分",
        value: view.admission?.composite,
        text: fmtNum(view.admission?.composite),
        denom: view.admission?.grade ? `${view.admission.grade} 级` : "-",
        detail: "8 个加权分项减惩罚，取最近一份",
        direction: "higher",
      },
      {
        id: "p95-latency",
        label: "P95 总耗时",
        value: stab.p95TotalMs,
        text: fmtMs(stab.p95TotalMs),
        denom: `P50 ${fmtMs(stab.p50TotalMs)}`,
        detail: `P99 ${fmtMs(stab.p99TotalMs)} · 均值 ${fmtMs(stab.avgTotalMs)}`,
        direction: "lower",
      },
      {
        id: "first-token",
        label: "P50 首 Token",
        value: view.firstToken?.p50Ms,
        text: fmtMs(view.firstToken?.p50Ms),
        denom: `${view.firstToken?.scenarioCount ?? 0} 个场景`,
        detail: "仅流式请求的首 Token 样本，取各场景 P50 的中位数",
        direction: "lower",
      },
      {
        id: "load",
        label: "压测推荐容量",
        value: null,
        text: knee && Number.isFinite(knee.goodput) ? fmtNum(knee.goodput, 2) : "-",
        denom: "有效 QPS",
        detail: knee
          ? `拐点 ${fmtNum(knee.qps, 1)} QPS × ${fmtPct(knee.successRate, 0)}${Number.isFinite(knee.concurrency) ? ` · 并发 ${knee.concurrency}` : ""}`
          : "还没有压测报告",
        direction: "higher",
      },
      {
        id: "spend",
        label: "累计 Token",
        value: null,
        text: fmtTokens((view.tokens?.input || 0) + (view.tokens?.output || 0)),
        denom: `入 ${fmtTokens(view.tokens?.input)} / 出 ${fmtTokens(view.tokens?.output)}`,
        detail: "全部报告合计，不作优劣评判",
        direction: "none",
      },
    ];
  }

  function renderMetrics() {
    const rows = metricRows();
    metricsTable.innerHTML = `<tbody>${rows
      .map((m) => {
        const health = m.direction === "none" ? "idle" : healthOf(m.id, m.value);
        const hist = view.histories?.[m.id];
        const spark = hist?.values?.length
          ? renderSparkline(hist.values, {
              width: 132,
              height: 26,
              anomaly: anomalyDetector(hist.values, m.direction),
              ariaLabel: `${m.label} 历史趋势`,
            })
          : `<span class="mp-nohist" title="${escapeHtml(hist?.reason || "")}">无历史</span>`;
        return `<tr class="${health}">
        <td class="mp-f-name">${escapeHtml(m.label)}</td>
        <td class="mp-f-value">${escapeHtml(m.text)}</td>
        <td class="mp-f-spark">${spark}</td>
        <td class="mp-f-denom">${escapeHtml(m.denom)}</td>
        <td class="mp-f-detail">${escapeHtml(m.detail)}</td>
      </tr>`;
      })
      .join("")}</tbody>`;

    // 图注如实交代哪些指标没有曲线、为什么 —— 数据诚实性的一部分。
    const missing = rows.filter((m) => !view.histories?.[m.id]?.values?.length);
    metricsCaption.innerHTML = missing.length
      ? `曲线为该指标的历史走势，末点为当前值，红点为偏离自身中位数的异常点。其中 ${missing
          .map((m) => `<b>${escapeHtml(m.label)}</b>（${escapeHtml(view.histories?.[m.id]?.reason || "暂无历史")}）`)
          .join("、")} 暂无历史曲线。`
      : "曲线为该指标的历史走势，末点为当前值，红点为偏离自身中位数的异常点。";
  }

  // —— Ⅲ 观察（诚信旗标）——
  function renderFlags() {
    const integrity = view.integrity || {};
    const gates = view.admission?.hardGates || {};
    const gateItem = (name, value) =>
      value === true
        ? { s: "good", t: `${name}通过`, n: "" }
        : value === false
          ? { s: "bad", t: `${name}未通过`, n: "硬门槛" }
          : { s: "warn", t: `${name}未测`, n: "" };

    const items = [
      integrity.baselineRegressed ? { s: "bad", t: "基线回归", n: integrity.baselineText || "" } : { s: "good", t: "与基线一致", n: "" },
      Number.isFinite(integrity.tokenInflation) && integrity.tokenInflation > 0.02
        ? { s: "warn", t: "Token 虚报", n: `+${(integrity.tokenInflation * 100).toFixed(1)}%` }
        : { s: "good", t: "Token 计量正常", n: "" },
      integrity.billingAudit ? { s: "bad", t: "计费疑点", n: integrity.billingAudit } : { s: "good", t: "计费无疑点", n: "" },
      gateItem("JSON 模式", gates.json),
      gateItem("工具调用", gates.tool),
      gateItem("流式响应", gates.stream),
    ];
    if (view.admission?.crossChannelMismatch) items.push({ s: "bad", t: "横向对照不一致", n: "疑似挂羊头" });
    if (view.admission?.nominalFamily && view.admission?.selfFamily && view.admission.selfFamily !== "unknown") {
      const same = String(view.admission.nominalFamily).toLowerCase().includes(String(view.admission.selfFamily).toLowerCase());
      items.push(
        same
          ? { s: "good", t: "标称与自述家族一致", n: view.admission.selfFamily }
          : { s: "warn", t: "标称与自述家族不符", n: `自述 ${view.admission.selfFamily}` },
      );
    }
    for (const [code, count] of Object.entries(integrity.errorCounts || {})) {
      items.push({ s: "warn", t: `错误 ${code}`, n: `${count} 次` });
    }
    flagsList.innerHTML = items
      .map(
        (f) => `<li class="${f.s}">
        <span class="mp-dot"></span>
        <span class="mp-o-name">${escapeHtml(f.t)}</span>
        ${f.n ? `<span class="mp-o-note" title="${escapeHtml(f.n)}">${escapeHtml(f.n)}</span>` : ""}
      </li>`,
      )
      .join("");
  }

  // —— Ⅳ 难度剖面 ——
  function renderTiers() {
    const tiers = view.tiers || [];
    if (!tiers.length) {
      tiersTable.innerHTML = `<tbody><tr><td class="mp-empty">还没有场景测试，无法给出难度剖面。</td></tr></tbody>`;
      return;
    }
    tiersTable.innerHTML = `<tbody>${tiers
      .map(
        (t) => `<tr>
        <td class="mp-t-name">${escapeHtml(t.tier || "未分档")}</td>
        <td class="mp-t-bar"><div class="mp-t-track"><div class="mp-t-fill" style="width:${((t.passRate || 0) * 100).toFixed(1)}%;background:${
          TIER_COLORS[t.tier] || "var(--mp-dim)"
        }"></div></div></td>
        <td class="num">${fmtPct(t.passRate, 0)}</td>
        <td class="num">${fmtNum(t.quality)} 分</td>
        <td class="num">${t.count} 例</td>
      </tr>`,
      )
      .join("")}</tbody>`;
  }

  // —— Ⅴ 逐轮明细 ——
  function renderTrend() {
    if (!view) return;
    const rounds = view.trend?.rounds || [];
    trendChart.innerHTML = rounds.length
      ? renderTrendChart(rounds, xMode, { windowHours: xMode === "hour" ? windowHours : 0 })
      : `<p class="mp-empty">还没有逐轮明细。跑一次稳定性测试后，这里会显示成功率与耗时的双轴曲线。</p>`;

    const reg = view.trend?.regression;
    regressionBox.innerHTML =
      reg?.status === "regressed"
        ? `<div class="mp-regress bad"><b>疑似退化（${escapeHtml(reg.severity || "")}）</b><ul>${(reg.changes || [])
            .map((c) => `<li>${escapeHtml(c.detail)}</li>`)
            .join("")}</ul></div>`
        : reg?.status === "stable"
          ? `<div class="mp-regress good"><b>与基线一致，未见退化</b></div>`
          : reg?.verdict
            ? `<div class="mp-regress"><b>${escapeHtml(reg.verdict)}</b></div>`
            : "";

    const alerts = view.alerts || [];
    alertCount.textContent = alerts.length ? `${alerts.length} 条` : "无";
    alertsTable.innerHTML = alerts.length
      ? `<thead><tr><th>时间</th><th>级别</th><th>说明</th></tr></thead><tbody>${alerts
          .map(
            (a) => `<tr>
          <td class="mp-mono">${escapeHtml(formatDateTime(a.created_at))}</td>
          <td><span class="mp-sev ${escapeHtml(a.severity || "")}">${escapeHtml(a.severity || "-")}</span></td>
          <td>${escapeHtml(a.summary || "-")}</td>
        </tr>`,
          )
          .join("")}</tbody>`
      : `<tbody><tr><td class="mp-empty">暂无回归告警。</td></tr></tbody>`;
  }

  // —— Ⅵ 场景 ——
  function renderScenarioFilters() {
    const tiers = [...new Set((view.scenarios || []).map((s) => s.tier).filter(Boolean))];
    const current = scTier.value;
    scTier.innerHTML = `<option value="">全部难度</option>${tiers.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("")}`;
    if (tiers.includes(current)) scTier.value = current;
  }

  function renderScenarios() {
    if (!view) return;
    const comparators = {
      "quality-asc": (a, b) => (a.quality ?? 0) - (b.quality ?? 0),
      "quality-desc": (a, b) => (b.quality ?? 0) - (a.quality ?? 0),
      slow: (a, b) => (b.avgMs ?? 0) - (a.avgMs ?? 0),
      name: (a, b) => a.name.localeCompare(b.name, "zh"),
    };
    const list = (view.scenarios || [])
      .filter((s) => !scTier.value || s.tier === scTier.value)
      .slice()
      .sort(comparators[scSort.value] || comparators["quality-asc"]);
    const qColor = (q) => (q >= 85 ? "var(--mp-ok)" : q >= 70 ? "var(--mp-warn)" : "var(--mp-bad)");

    scenariosTable.innerHTML = `
      <thead><tr>
        <th>场景</th><th>难度</th><th class="num">质量分</th><th class="num">通过率</th>
        <th class="num">平均耗时</th><th class="num">首 Token</th><th class="num">输出</th>
      </tr></thead>
      <tbody>${
        list.length
          ? list
              .map(
                (s) => `<tr>
            <td class="mp-s-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}${
              s.issue ? `<span class="mp-s-issue">${escapeHtml(s.issue)}</span>` : ""
            }</td>
            <td><span class="mp-tier">${escapeHtml(s.tier || "-")}</span></td>
            <td class="num">${
              Number.isFinite(s.quality) ? `<span class="mp-qdot" style="background:${qColor(s.quality)}"></span>${fmtNum(s.quality)}` : "-"
            }</td>
            <td class="num">${fmtPct(s.rate, 0)}</td>
            <td class="num">${fmtMs(s.avgMs)}</td>
            <td class="num">${fmtMs(s.p50FirstTokenMs)}</td>
            <td class="num">${fmtTokens(s.outputTokens)}</td>
          </tr>`,
              )
              .join("")
          : `<tr><td colspan="7" class="mp-empty">${view.scenarios?.length ? "没有符合筛选条件的场景。" : "还没有场景测试报告。"}</td></tr>`
      }</tbody>`;
  }

  // —— Ⅶ 报告归档 ——
  function renderReportFilters() {
    const types = [...new Set(reportFiles.map((f) => f.parsed?.type).filter(Boolean))].sort();
    const current = repType.value;
    repType.innerHTML = `<option value="">全部种类</option>${types
      .map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(REPORT_TYPE_LABELS[t] || t)}</option>`)
      .join("")}`;
    if (types.includes(current)) repType.value = current;
  }

  function filteredReports() {
    const days = Number(repRange.value) || 0;
    const cutoff = days ? Date.now() - days * 86400_000 : 0;
    return reportFiles.filter((f) => (!repType.value || f.parsed?.type === repType.value) && (!cutoff || f.mtimeMs >= cutoff));
  }

  function renderReports() {
    if (!view) return;
    const list = filteredReports();
    const totalPages = Math.max(1, Math.ceil(list.length / REPORT_PAGE_SIZE));
    reportPage = Math.min(Math.max(reportPage, 0), totalPages - 1);
    const slice = list.slice(reportPage * REPORT_PAGE_SIZE, reportPage * REPORT_PAGE_SIZE + REPORT_PAGE_SIZE);

    reportsTable.innerHTML = `
      <thead><tr><th>种类</th><th>报告 ID</th><th class="num">生成时间</th><th class="num">大小</th><th></th></tr></thead>
      <tbody>${
        slice.length
          ? slice
              .map(
                (f) => `<tr>
            <td class="mp-r-kind">${escapeHtml(REPORT_TYPE_LABELS[f.parsed?.type] || "报告")}</td>
            <td class="mp-r-id" title="${escapeHtml(f.id)}">${escapeHtml(f.id)}</td>
            <td class="num mp-mono">${escapeHtml(formatDateTime(f.mtimeMs))}</td>
            <td class="num mp-mono">${fmtBytes(f.sizeBytes)}</td>
            <td class="num"><button type="button" class="mp-link" data-mp-report="${escapeHtml(f.id)}">查看 →</button></td>
          </tr>`,
              )
              .join("")
          : `<tr><td colspan="5" class="mp-empty">${
              reportFiles.length ? "没有符合筛选条件的报告。" : "这个模型名下还没有报告文件。"
            }</td></tr>`
      }</tbody>`;

    pager.innerHTML = list.length
      ? `<button type="button" class="mp-link" data-mp-page="prev"${reportPage === 0 ? " disabled" : ""}>← 上一页</button>
         <span>第 ${reportPage + 1} / ${totalPages} 页 · 共 ${list.length} 份</span>
         <button type="button" class="mp-link" data-mp-page="next"${reportPage >= totalPages - 1 ? " disabled" : ""}>下一页 →</button>`
      : "";
  }

  // —— 事件 ——
  modelSelect.addEventListener("change", () => {
    syncUrl(modelSelect.value);
    void loadTarget(modelSelect.value);
  });
  trendXMode.addEventListener("change", () => {
    xMode = trendXMode.value === "hour" ? "hour" : "count";
    trendWindow.classList.toggle("hidden", xMode !== "hour");
    renderTrend();
  });
  trendWindow.addEventListener("change", () => {
    windowHours = Number(trendWindow.value) || 0;
    renderTrend();
  });
  scTier.addEventListener("change", renderScenarios);
  scSort.addEventListener("change", renderScenarios);
  for (const element of [repType, repRange]) {
    element.addEventListener("change", () => {
      reportPage = 0;
      renderReports();
    });
  }
  // 分页与「查看」都是 innerHTML 新建的子节点，故把监听挂在容器上（同报告中心的做法）——
  // 否则每次重渲染都要重新绑一遍，还会叠加。
  pager.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mp-page]");
    if (!button) return;
    const total = Math.max(1, Math.ceil(filteredReports().length / REPORT_PAGE_SIZE));
    reportPage = button.dataset.mpPage === "next" ? Math.min(reportPage + 1, total - 1) : Math.max(reportPage - 1, 0);
    renderReports();
  });
  reportsTable.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mp-report]");
    if (!button) return;
    const id = button.dataset.mpReport;
    openReportOverlay(id, { title: id });
  });

  return { load, refreshTargets, selectTarget };
}
