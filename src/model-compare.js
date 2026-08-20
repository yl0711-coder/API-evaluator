// src/model-compare.js
// 「模型比对」（高级测试栏，登录即可用）：选「所用模型」(A) 与「要对比的模型」(B)，
// 依据两者在报告中心各自最近的报告（1 稳定性 + 1 准入 + 每场景最新一份）做统计对比。
// 后端 POST /api/reports/compare 产出并落盘一份「模型对比报告」，前端用浮层查看 + 可下载 md。
import { escapeHtml, toast, downloadText, formatNumber, toCsvText } from "./client-utils.js";
import { api, cancelRemoteTask, runRemoteTask } from "./api-client.js";
import { requireElement } from "./dom-utils.js";
import { createCascadeTargetPicker } from "./target-picker.js";
import { openReportOverlay } from "./report-overlay.js";
import { buildGapFillTaskPayload, runGapFillQueue, summarizeGapFillEstimates } from "./model-compare-gap-fill.js";
import { buildComparisonXlsx } from "./model-compare-excel.js";

// 单元格转义 / 行拼装已抽到 client-utils.js（csvCell / toCsvText），与稳定性趋势页的导出共用一份
// ——防 CSV 注入那条规则是安全相关的，不该有两份各自漂移的实现。

function csvNumber(value) {
  return Number.isFinite(value) ? value : "";
}

function csvPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "";
}

function csvMetricValue(row, side) {
  const value = row?.[side === "a" ? "valueA" : "valueB"];
  if (!Number.isFinite(value)) return "";
  return row.format === "percent" ? `${(value * 100).toFixed(1)}%` : value;
}

function csvMetricUnit(row) {
  if (row?.format === "percent") return "%";
  if (row?.format === "milliseconds") return "ms";
  return row?.unit || "";
}

function csvCoverage(value) {
  return Number.isFinite(value?.reportedCount) && Number.isFinite(value?.totalCount) ? `${value.reportedCount}/${value.totalCount}` : "";
}

export function buildComparisonCsv(comparison) {
  const subjectA = comparison?.subjects?.a?.label || "对象 A";
  const subjectB = comparison?.subjects?.b?.label || "对象 B";
  const rows = [
    ["对象 A", subjectA],
    ["对象 B", subjectB],
    [],
    [
      "分区",
      "指标/场景",
      "难度",
      "对象 A",
      "对象 B",
      "单位",
      "说明",
      "对象 A Token 覆盖",
      "对象 B Token 覆盖",
      "对象 A 质量分",
      "对象 B 质量分",
      "对象 A 通过率",
      "对象 B 通过率",
      "对象 A 平均耗时 ms",
      "对象 B 平均耗时 ms",
      "对象 A P50 首 Token ms",
      "对象 B P50 首 Token ms",
      "对象 A 输出 Token（含思考）",
      "对象 B 输出 Token（含思考）",
      "对象 A 缓存命中 Token",
      "对象 B 缓存命中 Token",
      "对象 A 问题摘要",
      "对象 B 问题摘要",
    ],
  ];
  for (const row of comparison?.summary || []) {
    rows.push([
      "摘要",
      row.label || "",
      "",
      csvMetricValue(row, "a"),
      csvMetricValue(row, "b"),
      csvMetricUnit(row),
      row.detail || "",
      csvCoverage(row.coverageA),
      csvCoverage(row.coverageB),
    ]);
  }
  for (const row of comparison?.scenarios || []) {
    const a = row.a || {};
    const b = row.b || {};
    rows.push([
      "逐场景",
      row.name || "",
      row.tier || "",
      "",
      "",
      "",
      "",
      csvCoverage({ reportedCount: a.outputTokenReportedCount, totalCount: a.outputTokenTotalCount }),
      csvCoverage({ reportedCount: b.outputTokenReportedCount, totalCount: b.outputTokenTotalCount }),
      csvNumber(a.quality),
      csvNumber(b.quality),
      csvPercent(a.passRate),
      csvPercent(b.passRate),
      csvNumber(a.avgMs),
      csvNumber(b.avgMs),
      csvNumber(a.p50FirstTokenMs),
      csvNumber(b.p50FirstTokenMs),
      csvNumber(a.outputTokens),
      csvNumber(b.outputTokens),
      csvNumber(a.cacheReadTokens),
      csvNumber(b.cacheReadTokens),
      a.issue || "",
      b.issue || "",
    ]);
  }
  return toCsvText(rows);
}

// —— 单元格格式化（两列表格与 N 列表格共用）——
// 刻意做成模块级纯函数：两两对比走 formatMetricValue(row, side) 取 valueA/valueB，
// 多模型对比走 values[i]，两边只在「从哪取数」上不同，格式化规则必须只有一份。

function formatMetricNumber(value, format, unit, coverage) {
  if (!Number.isFinite(value)) return "-";
  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  if (format === "milliseconds") return `${Math.round(value).toLocaleString("zh-CN")} ms`;
  const fractionDigits = Math.abs(value) >= 100 || Number.isInteger(value) ? 0 : 1;
  const suffix = unit === "分" ? " 分" : unit === "有效 QPS" ? " 有效 QPS" : unit === "Token" ? " Token" : "";
  const coverageText =
    unit === "Token" && Number.isFinite(coverage?.reportedCount) && Number.isFinite(coverage?.totalCount)
      ? `（${coverage.reportedCount}/${coverage.totalCount} 次上报）`
      : "";
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: fractionDigits })}${suffix}${coverageText}`;
}

function shortIssue(issue) {
  const text = String(issue || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 42 ? `${text.slice(0, 42)}...` : text;
}

// 逐场景单元格：只认「一侧的数据对象」，不关心它来自 row.a / row.b / values[i]。
// extraClass 由调用方给（两列用 is-winner，N 列用 is-winner/is-base）。
function scenarioCellFrom(data, extraClass = "") {
  const d = data || {};
  const quality = Number.isFinite(d.quality) ? `${d.quality.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 分` : "-";
  const passRate = Number.isFinite(d.passRate) ? `${(d.passRate * 100).toFixed(1)}% 通过` : "通过率 -";
  const avgMs = Number.isFinite(d.avgMs) ? `${Math.round(d.avgMs).toLocaleString("zh-CN")} ms` : "耗时 -";
  const firstTokenMs = Number.isFinite(d.p50FirstTokenMs)
    ? `P50 首 Token ${Math.round(d.p50FirstTokenMs).toLocaleString("zh-CN")} ms`
    : "P50 首 Token -";
  const usageText = (value, reportedCount, totalCount, label) => {
    const coverage =
      Number.isFinite(reportedCount) && Number.isFinite(totalCount) ? `（${reportedCount}/${totalCount} 次上报）` : "（覆盖未知）";
    return Number.isFinite(value) ? `${label} ${Math.round(value).toLocaleString("zh-CN")} Token${coverage}` : `${label} -${coverage}`;
  };
  const outputTokens = usageText(d.outputTokens, d.outputTokenReportedCount, d.outputTokenTotalCount, "输出（含思考）");
  const cacheReadTokens = usageText(d.cacheReadTokens, d.cacheReadTokenReportedCount, d.cacheReadTokenTotalCount, "缓存命中");
  const issue = shortIssue(d.issue);
  return `<td class="mc-compare-value mc-scenario-value${extraClass}">
      <strong>${escapeHtml(quality)}</strong>
      <span>${escapeHtml(passRate)} · ${escapeHtml(avgMs)} · ${escapeHtml(firstTokenMs)} · ${escapeHtml(outputTokens)} · ${escapeHtml(cacheReadTokens)}</span>
      ${issue ? `<small title="${escapeHtml(d.issue)}">${escapeHtml(issue)}</small>` : ""}
    </td>`;
}

// 一次最多并排几个对比模型。必须与后端 server.mjs 的 MULTI_COMPARE_MAX_PEERS 一致——
// 前端这道限制只是「早一步给出人话提示」，真正的门是后端那道（越限会返回 400 too_many_peers）。
const MULTI_MAX_PEERS = 6;

// 多模型对比 CSV：表头随 subjects 数量动态生成。
// 不改 buildComparisonCsv —— 那个是两列专用契约，被 tests/model-compare-csv.test.mjs 钉住。
export function buildMultiComparisonCsv(comparison) {
  const subjects = Array.isArray(comparison?.subjects) ? comparison.subjects : [];
  const labels = subjects.map((s, i) => s?.label || `对象 ${i + 1}`);
  const rows = [
    ["基准模型", labels[0] || "-"],
    ["对比模型", ...labels.slice(1)],
    ["共享场景数", String(comparison?.sharedScenarioCount ?? "")],
    [],
    ["分区", "指标/场景", "难度", ...labels, "单位", "说明"],
  ];
  for (const row of comparison?.summary || []) {
    const values = (row.values || []).map((v) =>
      !Number.isFinite(v?.value) ? "" : row.format === "percent" ? `${(v.value * 100).toFixed(1)}%` : v.value,
    );
    rows.push(["摘要", row.label || "", "", ...values, csvMetricUnit(row), row.detail || ""]);
  }
  for (const row of comparison?.scenarios || []) {
    const values = (row.values || []).map((v) => (Number.isFinite(v?.quality) ? v.quality : ""));
    rows.push(["逐场景（质量分）", row.name || "", row.tier || "", ...values, "分", ""]);
  }
  return toCsvText(rows);
}

export function createModelCompare({ state, confirm }) {
  const form = requireElement("#mc-form");
  const aChannel = requireElement("#mc-a-channel");
  const aModel = requireElement("#mc-a-model");
  const aName = requireElement("#mc-a-name");
  const bChannel = requireElement("#mc-b-channel");
  const bModel = requireElement("#mc-b-model");
  const bName = requireElement("#mc-b-name");
  const aiInput = requireElement("#mc-ai");
  const generateBtn = requireElement("#mc-generate");
  const resultBox = requireElement("#mc-result");
  const loadScenariosBtn = requireElement("#mc-load-scenarios");
  const scenariosBox = requireElement("#mc-scenarios");
  const scenarioHint = requireElement("#mc-scenario-hint");
  const gapFillBox = requireElement("#mc-gap-fill");
  const fillGapsBtn = requireElement("#mc-fill-gaps");
  const gapHint = requireElement("#mc-gap-hint");
  const gapProgress = requireElement("#mc-gap-progress");

  // 多模型比对（并排）：基准模型 + 勾选若干「曾与它比对过」的模型。
  const multiForm = requireElement("#mcm-form");
  const baseChannel = requireElement("#mcm-base-channel");
  const baseModel = requireElement("#mcm-base-model");
  const loadPeersBtn = requireElement("#mcm-load-peers");
  const peersBox = requireElement("#mcm-peers");
  const peerHint = requireElement("#mcm-peer-hint");
  const multiGenerateBtn = requireElement("#mcm-generate");
  const multiResultBox = requireElement("#mcm-result");

  const cascadeA = createCascadeTargetPicker(aChannel, aModel);
  const cascadeB = createCascadeTargetPicker(bChannel, bModel);
  const cascadeBase = createCascadeTargetPicker(baseChannel, baseModel);

  // null = 未加载可选场景（生成时不带 scenarios 字段，后端用全部共有场景）；
  // 数组 = 已加载的两方共有场景 [{name, tier}]，勾选状态在 DOM 上。
  let loadedScenarios = null;
  // 「补齐单方场景」：{ onlyA: [{name,tier}], onlyB: [...] } | null（未算出 / 已重置）。
  // onlyA = A 测过但 B 没测过（需要补给 B）；onlyB 反之（需要补给 A）。
  let gaps = null;
  // 每次清空结果都会推进版本；迟到的请求不能把旧模型组合的表格重新写回页面。
  let compareRevision = 0;
  let gapFillRunning = false;
  let gapFillCancellationRequested = false;
  // 多模型比对：null = 未加载可比对模型；数组 = 已加载的 peer 列表（勾选状态在 DOM 上）。
  let loadedPeers = null;
  // 同 compareRevision，但管的是多模型表格——两个表格各自独立防「迟到响应写回旧组合」。
  let multiRevision = 0;

  // 由模型目标 id 反查 { channel(渠道名), model, 曾用名 }，供后端按报告文件名匹配。
  // 带上渠道与模型的曾用名(aliases)，让改名前的历史报告也能被本模型认领。
  function subjectOf(targetId) {
    const t = (state.modelTargets || []).find((x) => x.id === targetId);
    if (!t) return null;
    const ch = (state.channels || []).find((c) => c.id === t.channelId);
    return {
      channel: t.channelName || "",
      model: t.model || "",
      channelAliases: Array.isArray(ch?.aliases) ? ch.aliases : [],
      modelAliases: Array.isArray(t.aliases) ? t.aliases : [],
    };
  }

  async function onSubmit(event) {
    event.preventDefault();
    const idA = cascadeA.value;
    const idB = cascadeB.value;
    if (!idA || !idB) {
      toast("请为两个对象都选好渠道与模型。", true);
      return;
    }
    if (idA === idB) {
      toast("两个对象不能是同一个模型，请选不同的。", true);
      return;
    }
    const a = subjectOf(idA);
    const b = subjectOf(idB);
    if (!a || !b) {
      toast("找不到所选模型信息，请刷新后重试。", true);
      return;
    }

    // 已加载且有共有场景时，只用勾选的（未勾选任何 → 拦下）；未加载或无共有场景时不带 scenarios（后端用全部共有）。
    let scenarios;
    if (loadedScenarios && loadedScenarios.length) {
      scenarios = checkedScenarioNames();
      if (!scenarios.length) {
        toast("请至少勾选一个场景，或点「重置」用全部共有场景。", true);
        return;
      }
    }

    // 可选：为两个对象取一个「只用于本次报告」的显示名（留空则后端回退 渠道 / 模型）。
    const aNameVal = aName.value.trim();
    const bNameVal = bName.value.trim();

    generateBtn.disabled = true;
    const prevLabel = generateBtn.textContent;
    generateBtn.textContent = aiInput.checked ? "生成中…（含 AI 叙述，可能较久）" : "生成中…";
    const requestRevision = clearResult();
    try {
      const r = await api("/api/reports/compare", {
        method: "POST",
        body: JSON.stringify({
          a,
          b,
          aiNarrative: aiInput.checked,
          ...(aNameVal ? { aName: aNameVal } : {}),
          ...(bNameVal ? { bName: bNameVal } : {}),
          ...(scenarios ? { scenarios } : {}),
        }),
      });
      if (requestRevision !== compareRevision) return;
      renderResult(r);
      toast("对比报告已生成。");
    } catch (error) {
      if (requestRevision !== compareRevision) return;
      toast(`生成失败：${error.message}`, true);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = prevLabel;
    }
  }

  function clearResult() {
    compareRevision += 1;
    resultBox.innerHTML = "";
    return compareRevision;
  }

  function formatMetricValue(row, side) {
    return formatMetricNumber(
      row?.[side === "a" ? "valueA" : "valueB"],
      row?.format,
      row?.unit,
      row?.[side === "a" ? "coverageA" : "coverageB"],
    );
  }

  function comparisonCell(row, side) {
    const winner = row.winner === side ? " is-winner" : "";
    return `<td class="mc-compare-value${winner}"><strong>${escapeHtml(formatMetricValue(row, side))}</strong></td>`;
  }

  function scenarioCell(row, side) {
    return scenarioCellFrom(row[side], row.winner === side ? " is-winner" : "");
  }

  function renderComparison(comparison) {
    if (!comparison || !Array.isArray(comparison.summary)) return "";
    const subjectA = comparison.subjects?.a?.label || "对象 A";
    const subjectB = comparison.subjects?.b?.label || "对象 B";
    const overallWinner = comparison.summary.find((row) => row.id === "overall-score")?.winner;
    const summaryWinnerClass = overallWinner === "a" || overallWinner === "b" ? ` mc-overall-winner-${overallWinner}` : "";
    const summaryRows = comparison.summary
      .map(
        (row) => `<tr class="${row.status === "insufficient" ? "is-insufficient" : ""}">
          <th scope="row"><span>${escapeHtml(row.label || "-")}</span>${row.detail ? `<small>${escapeHtml(row.detail)}</small>` : ""}</th>
          ${comparisonCell(row, "a")}
          ${comparisonCell(row, "b")}
        </tr>`,
      )
      .join("");
    const scenarios = Array.isArray(comparison.scenarios) ? comparison.scenarios : [];
    const scenarioRows = scenarios
      .map(
        (row) => `<tr class="${row.status === "insufficient" ? "is-insufficient" : ""}">
          <th scope="row"><span>${escapeHtml(row.name || "-")}</span>${row.tier ? `<small>${escapeHtml(row.tier)}</small>` : ""}</th>
          ${scenarioCell(row, "a")}
          ${scenarioCell(row, "b")}
        </tr>`,
      )
      .join("");
    return `
      <section class="mc-compare-table" aria-label="模型对比摘要">
        <div class="mc-compare-table-head">
          <h3>直观对比</h3>
          <span>${scenarios.length} 个共有场景</span>
        </div>
        <div class="mc-compare-scroll">
          <table class="mc-compare-summary${summaryWinnerClass}">
            <thead><tr><th scope="col">指标</th><th scope="col">${escapeHtml(subjectA)}</th><th scope="col">${escapeHtml(subjectB)}</th></tr></thead>
            <tbody>${summaryRows}</tbody>
          </table>
        </div>
        <details class="mc-scenario-details">
          <summary>逐场景对照 <span>${scenarios.length}</span></summary>
          ${
            scenarios.length
              ? `<div class="mc-compare-scroll"><table><thead><tr><th scope="col">场景</th><th scope="col">${escapeHtml(subjectA)}</th><th scope="col">${escapeHtml(subjectB)}</th></tr></thead><tbody>${scenarioRows}</tbody></table></div>`
              : '<p class="field-hint">没有可逐项配对的共有场景。</p>'
          }
        </details>
      </section>`;
  }

  function renderResult({ reportId, markdown, notes, comparison }) {
    resultBox.innerHTML = `
      <section class="mc-result" aria-live="polite">
        ${renderComparison(comparison)}
        <div class="action-row" style="justify-content:flex-start">
          <button type="button" class="secondary" data-mc-view>查看报告</button>
          <button type="button" class="secondary" data-mc-download>下载 Markdown</button>
          <button type="button" class="secondary" data-mc-export-csv>导出 CSV</button>
          <button type="button" class="secondary" data-mc-export-xlsx>导出 Excel</button>
        </div>
        <p class="field-hint" style="margin-top:10px">
          对象 A 采用报告：${escapeHtml(notes?.a || "-")}；对象 B 采用报告：${escapeHtml(notes?.b || "-")}。
          ${notes?.aiApplied ? "已附 AI 叙述。" : notes?.ai ? `AI 叙述：${escapeHtml(notes.ai)}` : ""}
        </p>
      </section>`;
    resultBox.querySelector("[data-mc-view]").addEventListener("click", () => openReportOverlay(reportId, { title: "模型对比报告" }));
    resultBox.querySelector("[data-mc-download]").addEventListener("click", () => downloadText(`${reportId}.md`, markdown));
    resultBox
      .querySelector("[data-mc-export-csv]")
      .addEventListener("click", () => downloadText(`${reportId}.csv`, `\uFEFF${buildComparisonCsv(comparison)}`, "text/csv"));
    resultBox
      .querySelector("[data-mc-export-xlsx]")
      .addEventListener("click", () =>
        downloadText(
          `${reportId}.xlsx`,
          buildComparisonXlsx(comparison),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
      );
  }

  // 勾选的场景名。
  function checkedScenarioNames() {
    return [...scenariosBox.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
  }

  // 渲染两方共有场景为复选框（默认全选）+ 全选/全不选/重置控件。
  function renderScenarioChecklist(scenarios) {
    if (!scenarios.length) {
      scenariosBox.innerHTML = `<p class="field-hint">两方没有共有的同名场景（可能只共有稳定性/准入）。将按全部共有报告生成。</p>`;
      scenariosBox.classList.remove("hidden");
      return;
    }
    const items = scenarios
      .map(
        (s) =>
          `<label class="mc-scenario-item"><input type="checkbox" value="${escapeHtml(s.name)}" checked /><span>${escapeHtml(s.name)}${s.tier ? ` <em>${escapeHtml(s.tier)}</em>` : ""}</span></label>`,
      )
      .join("");
    scenariosBox.innerHTML = `
      <div class="mc-scenario-tools">
        <span class="field-hint" id="mc-scenario-count"></span>
        <span class="mc-scenario-actions">
          <button type="button" class="link-button" data-mc-all>全选</button>
          <button type="button" class="link-button" data-mc-none>全不选</button>
          <button type="button" class="link-button" data-mc-reset>重置(用全部共有)</button>
        </span>
      </div>
      <div class="mc-scenario-list">${items}</div>`;
    scenariosBox.classList.remove("hidden");
    // 以下按钮是本次 innerHTML 新建的子节点，随重渲染一起丢弃，故可在渲染函数里挂监听。
    scenariosBox.querySelector("[data-mc-all]").addEventListener("click", () => {
      scenariosBox.querySelectorAll('input[type="checkbox"]').forEach((el) => (el.checked = true));
      updateScenarioCount();
    });
    scenariosBox.querySelector("[data-mc-none]").addEventListener("click", () => {
      scenariosBox.querySelectorAll('input[type="checkbox"]').forEach((el) => (el.checked = false));
      updateScenarioCount();
    });
    scenariosBox.querySelector("[data-mc-reset]").addEventListener("click", resetScenarios);
    updateScenarioCount();
  }

  // 计数文案：读模块级 loadedScenarios（渲染时传的就是它），不闭包 scenarios 参数——
  // 这样 change 监听可在 init 处只挂一次。scenariosBox 是 requireElement 拿到的持久元素，
  // innerHTML 只换子节点、不换它自己；若在渲染函数里给它挂监听，每点一次「加载共有场景」就叠加一个。
  // 重置后 #mc-scenario-count 随子节点消失，故需空值保护。
  function updateScenarioCount() {
    const el = scenariosBox.querySelector("#mc-scenario-count");
    if (!el) return;
    el.textContent = `已选 ${checkedScenarioNames().length} / ${loadedScenarios?.length ?? 0} 个共有场景`;
  }

  // 清空场景选择：回到「未加载」态（生成时不带 scenarios → 用全部共有）。
  function resetScenarios() {
    clearResult();
    loadedScenarios = null;
    scenariosBox.innerHTML = "";
    scenariosBox.classList.add("hidden");
    scenarioHint.classList.remove("hidden");
    resetGaps();
  }

  // 清空「补齐单方场景」状态：换模型/渠道，或补齐流程结束后回到未算出的初始态。
  function resetGaps() {
    gaps = null;
    gapFillBox.classList.add("hidden");
    gapHint.textContent = "";
    gapProgress.classList.add("hidden");
    const choiceBox = gapFillBox.querySelector("[data-mc-gap-choices]");
    if (choiceBox) choiceBox.innerHTML = "";
    resetGapOptions();
  }

  function resetGapOptions() {
    const options = gapFillBox.querySelector("[data-mc-gap-options]");
    if (!options) return;
    options.open = false;
    options.querySelector("[data-mc-gap-max-tokens]").value = "";
    options.querySelector("[data-mc-gap-timeout-ms]").value = "";
    options.querySelector("[data-mc-gap-temperature]").value = "";
    options.querySelector("[data-mc-gap-repeats]").value = "1";
    options.querySelector("[data-mc-gap-request-concurrency]").value = "1";
    options.querySelector("[data-mc-gap-full-response]").checked = false;
    options.querySelector("[data-mc-gap-stream-request]").checked = false;
  }

  function readGapOptions() {
    return {
      maxTokens: gapFillBox.querySelector("[data-mc-gap-max-tokens]").value,
      timeoutMs: gapFillBox.querySelector("[data-mc-gap-timeout-ms]").value,
      temperature: gapFillBox.querySelector("[data-mc-gap-temperature]").value,
      repeats: gapFillBox.querySelector("[data-mc-gap-repeats]").value,
      requestConcurrency: gapFillBox.querySelector("[data-mc-gap-request-concurrency]").value,
      fullResponseInReport: gapFillBox.querySelector("[data-mc-gap-full-response]").checked,
      streamRequest: gapFillBox.querySelector("[data-mc-gap-stream-request]").checked,
    };
  }

  async function onLoadScenarios() {
    const idA = cascadeA.value;
    const idB = cascadeB.value;
    if (!idA || !idB || idA === idB) {
      toast("请先选好两个不同的模型。", true);
      return;
    }
    const a = subjectOf(idA);
    const b = subjectOf(idB);
    if (!a || !b) {
      toast("找不到所选模型信息，请刷新后重试。", true);
      return;
    }
    clearResult();
    loadScenariosBtn.disabled = true;
    const prev = loadScenariosBtn.textContent;
    loadScenariosBtn.textContent = "加载中…";
    try {
      const [scenarioRes, gapRes] = await Promise.all([
        api("/api/reports/compare/scenarios", { method: "POST", body: JSON.stringify({ a, b }) }),
        api("/api/reports/compare/gaps", { method: "POST", body: JSON.stringify({ a, b }) }).catch(() => null),
      ]);
      loadedScenarios = Array.isArray(scenarioRes.scenarios) ? scenarioRes.scenarios : [];
      renderScenarioChecklist(loadedScenarios);
      renderGaps(gapRes);
    } catch (error) {
      toast(`加载场景失败：${error.message}`, true);
    } finally {
      loadScenariosBtn.disabled = false;
      loadScenariosBtn.textContent = prev;
    }
  }

  // 补齐清单：onlyA 中的场景补给 B，onlyB 中的场景补给 A。
  function gapEntries() {
    if (!gaps) return [];
    return [
      ...(gaps.onlyA || []).map((scenario, index) => ({ key: `a:${index}`, scenario, forLabel: "B" })),
      ...(gaps.onlyB || []).map((scenario, index) => ({ key: `b:${index}`, scenario, forLabel: "A" })),
    ];
  }

  function updateGapCount() {
    const count = gapFillBox.querySelector("[data-mc-gap-count]");
    if (!count) return;
    const selected = gapFillBox.querySelectorAll("[data-mc-gap-choice]:checked").length;
    count.textContent = `已选 ${selected} / ${gapEntries().length} 个待补场景`;
  }

  // 渲染「补齐单方场景」清单：默认全选，用户可在实际调用前缩小范围。
  function renderGaps(gapRes) {
    const onlyA = Array.isArray(gapRes?.onlyA) ? gapRes.onlyA : [];
    const onlyB = Array.isArray(gapRes?.onlyB) ? gapRes.onlyB : [];
    if (!onlyA.length && !onlyB.length) {
      resetGaps();
      return;
    }
    gaps = { onlyA, onlyB };
    gapFillBox.classList.remove("hidden");
    gapHint.textContent = `发现 A 有 ${onlyA.length} 个场景 B 未测，B 有 ${onlyB.length} 个场景 A 未测。请选择需要补测的场景（真实消耗额度）。`;
    const choiceBox = gapFillBox.querySelector("[data-mc-gap-choices]");
    const entries = gapEntries();
    const group = (forLabel) => entries.filter((entry) => entry.forLabel === forLabel);
    const renderGroup = (forLabel) => {
      const items = group(forLabel);
      if (!items.length) return "";
      const heading = forLabel === "A" ? "对象 B 已测，补给对象 A" : "对象 A 已测，补给对象 B";
      return `
        <div class="mc-gap-group">
          <p class="field-hint">${heading}</p>
          <div class="mc-scenario-list">
            ${items
              .map(
                ({ key, scenario }) =>
                  `<label class="mc-scenario-item"><input type="checkbox" data-mc-gap-choice value="${key}" checked /><span>${escapeHtml(scenario.name)}${scenario.tier ? ` <em>${escapeHtml(scenario.tier)}</em>` : ""}</span></label>`,
              )
              .join("")}
          </div>
        </div>`;
    };
    choiceBox.innerHTML = `
      <div class="mc-scenario-tools">
        <span class="field-hint" data-mc-gap-count></span>
        <span class="mc-scenario-actions">
          <button type="button" class="link-button" data-mc-gap-all>全选</button>
          <button type="button" class="link-button" data-mc-gap-none>全不选</button>
        </span>
      </div>
      ${renderGroup("B")}
      ${renderGroup("A")}`;
    choiceBox.querySelector("[data-mc-gap-all]").addEventListener("click", () => {
      choiceBox.querySelectorAll("[data-mc-gap-choice]").forEach((el) => (el.checked = true));
      updateGapCount();
    });
    choiceBox.querySelector("[data-mc-gap-none]").addEventListener("click", () => {
      choiceBox.querySelectorAll("[data-mc-gap-choice]").forEach((el) => (el.checked = false));
      updateGapCount();
    });
    choiceBox.onchange = updateGapCount;
    updateGapCount();
    gapProgress.classList.add("hidden");
  }

  // 把场景名映射为场景 id：state.scenarios 是当前生效的题库（可能已改名/下架场景不在其中）。
  // 已知问题（暂不修）：场景 name 没有唯一性校验（server/scenarios/store.mjs 的 validateScenario
  // 只查 id/prompt），若题库里存在同名但内容不同的场景，find 只取第一个匹配——补齐时可能选中
  // 「同名但已不是原本被测的那道题」，且完全静默、无告警。触发条件较窄（需管理员曾创建过重名场景）。
  function scenarioIdByName(name) {
    const s = (state.scenarios || []).find((x) => x.name === name);
    return s ? s.id : null;
  }

  async function onFillGaps() {
    if (!gaps || (!gaps.onlyA.length && !gaps.onlyB.length)) return;
    const idA = cascadeA.value;
    const idB = cascadeB.value;
    if (!idA || !idB) {
      toast("请先选好两个不同的模型。", true);
      return;
    }
    const selectedKeys = new Set([...gapFillBox.querySelectorAll("[data-mc-gap-choice]:checked")].map((el) => el.value));
    if (!selectedKeys.size) {
      toast("请至少选择一个要补齐的场景。", true);
      return;
    }
    const rawOptions = readGapOptions();
    // jobs：[{ targetId, scenarioId, scenarioName, forLabel }]；只补齐用户勾选的条目，名字在当前题库里找不到 id 的场景（已改名/下架）跳过。
    const jobs = [];
    const skipped = [];
    for (const entry of gapEntries()) {
      if (!selectedKeys.has(entry.key)) continue;
      const scenarioId = scenarioIdByName(entry.scenario.name);
      if (scenarioId) {
        jobs.push({
          targetId: entry.forLabel === "A" ? idA : idB,
          scenarioId,
          scenarioName: entry.scenario.name,
          forLabel: entry.forLabel,
          payload: buildGapFillTaskPayload({
            targetId: entry.forLabel === "A" ? idA : idB,
            scenarioId,
            rawOptions,
            scenarios: state.scenarios,
          }),
        });
      } else {
        skipped.push(entry.scenario.name);
      }
    }
    if (!jobs.length) {
      toast("待补场景均已从当前题库下架/改名，无法自动补齐。", true);
      return;
    }
    const estimate = summarizeGapFillEstimates(jobs.map((job) => job.payload));

    const detail = [
      `将补齐 ${jobs.length} 个选中场景，共发起 ${estimate.requests} 次场景请求，逐个进行、每次都真实调用被测 API。`,
      `预计消耗 ${formatNumber(estimate.lowTokens)} - ${formatNumber(estimate.highTokens)} tokens。`,
      skipped.length ? `另有 ${skipped.length} 个场景已从当前题库下架/改名，无法补齐，将跳过：${skipped.join("、")}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const confirmed = confirm
      ? await confirm({
          title: "补齐单方场景",
          message: detail,
          detail: "确认后会逐个开始测试，可能耗时较久，请不要关闭窗口。",
          confirmLabel: "确认开始补齐",
          cancelLabel: "先不运行",
          tone: estimate.risk === "高" || estimate.risk === "中高" ? "danger" : "normal",
        })
      : window.confirm(detail);
    if (!confirmed) return;

    gapFillRunning = true;
    gapFillCancellationRequested = false;
    fillGapsBtn.disabled = true;
    const prevLabel = fillGapsBtn.textContent;
    let outcome;
    try {
      outcome = await runGapFillQueue({
        jobs,
        isCancellationRequested: () => gapFillCancellationRequested,
        onJobStart: (job, index) => {
          fillGapsBtn.textContent = `补齐中…（${index + 1}/${jobs.length}）`;
          // 中途换模型下拉会触发 resetGaps 把父容器 #mc-gap-fill 隐藏，但补测仍在逐个真实调用 API 计费——
          // 每轮都把容器和进度条重新亮出来，绝不允许"额度在烧、界面上却什么都看不到"。
          gapFillBox.classList.remove("hidden");
          gapProgress.classList.remove("hidden");
          const p = gapProgress.querySelector("p");
          if (p) p.textContent = `补齐中 ${index + 1}/${jobs.length}：《${job.scenarioName}》→ 补给对象 ${job.forLabel} (0%)`;
        },
        runJob: async (job) => {
          // idempotencyKey：显式声明去重身份（服务端 task-manager 只信这个字段，不按 payload
          // 形状猜）。补齐同一 {模型, 场景} 时用同一个键，让"轮询误报失败后用户再点一次补齐"
          // 拿到的是同一个仍在跑的任务，而不是发起第二次真实付费调用。
          await runRemoteTask(state, "mc-gap-fill", "scenario", { ...job.payload }, gapProgress, {
            onCreated: () => {
              if (gapFillCancellationRequested) void cancelRemoteTask(state, "mc-gap-fill");
            },
          });
        },
      });
    } finally {
      gapFillRunning = false;
      fillGapsBtn.disabled = false;
      fillGapsBtn.textContent = prevLabel;
      gapProgress.classList.add("hidden");
    }

    if (outcome.cancelled) {
      toast(`已取消本次补齐：${outcome.completed}/${jobs.length} 个场景已完成。`);
    } else if (outcome.failures.length) {
      toast(`补齐完成：${outcome.completed}/${jobs.length} 成功，${outcome.failures.length} 个失败。`, true);
    } else {
      toast(`补齐完成：${jobs.length} 个场景测试已全部完成。`);
    }
    // 补齐后重新拉一次共有场景 + 差集，让用户能立刻看到最新可对比场景。
    // 仅当两个下拉仍是本次补齐的组合时才自动刷新——中途换过模型的话，自动刷新会拿【新】组合发请求，
    // 界面呈现与刚补完的对象脱节（补的是旧组合、列表却是新组合的）。
    if (cascadeA.value === idA && cascadeB.value === idB) {
      await onLoadScenarios();
    } else {
      toast("补齐期间模型选择已变更，请重新点「加载可选场景」查看结果。");
    }
  }

  // —— 多模型并排比对（基准 + 1~6 个对比模型；只在前端出表，不落报告文件）——

  function clearMultiResult() {
    multiRevision += 1;
    multiResultBox.innerHTML = "";
    return multiRevision;
  }

  // 勾选的 peer。复选框 value 存的是 loadedPeers 的【下标】而不是「渠道/模型」拼串——
  // 渠道名可含任意字符（含分隔符本身），拼串再解析必然有歧义。
  function checkedPeers() {
    if (!loadedPeers) return [];
    return [...peersBox.querySelectorAll("[data-mcm-peer]:checked")].map((el) => loadedPeers[Number(el.value)]).filter(Boolean);
  }

  // 计数文案：读模块级 loadedPeers（同 updateScenarioCount 的理由——change 监听挂在持久容器
  // peersBox 上、只挂一次，故不能闭包渲染时的参数）。重置后计数节点随子节点消失，需空值保护。
  function updatePeerCount() {
    const el = peersBox.querySelector("#mcm-peer-count");
    if (!el) return;
    el.textContent = `已选 ${checkedPeers().length} / ${loadedPeers?.length ?? 0} 个对比模型（最多 ${MULTI_MAX_PEERS} 个）`;
  }

  // 回到「未加载」态：换基准模型后旧清单不再适用（那是上一个基准的比对史）。
  function resetPeers() {
    clearMultiResult();
    loadedPeers = null;
    peersBox.innerHTML = "";
    peersBox.classList.add("hidden");
    peerHint.classList.remove("hidden");
  }

  async function onLoadPeers() {
    const id = cascadeBase.value;
    if (!id) {
      toast("请先选好基准模型（渠道 + 模型）。", true);
      return;
    }
    const baseSubject = subjectOf(id);
    if (!baseSubject) {
      toast("找不到所选模型信息，请刷新后重试。", true);
      return;
    }
    clearMultiResult();
    loadPeersBtn.disabled = true;
    const prev = loadPeersBtn.textContent;
    loadPeersBtn.textContent = "加载中…";
    try {
      const r = await api("/api/reports/compare/peers", {
        method: "POST",
        body: JSON.stringify({ base: { ...baseSubject, targetId: id } }),
      });
      loadedPeers = Array.isArray(r.peers) ? r.peers : [];
      renderPeerChecklist(loadedPeers, r.unresolved);
    } catch (error) {
      toast(`加载可比对模型失败：${error.message}`, true);
    } finally {
      loadPeersBtn.disabled = false;
      loadPeersBtn.textContent = prev;
    }
  }

  // 渲染可比对模型清单为平铺复选框（默认【不】勾选：并排列数直接影响可读性，交给用户挑）。
  function renderPeerChecklist(peers, unresolved) {
    peerHint.classList.add("hidden");
    const unresolvedNote = unresolved
      ? `<p class="field-hint">另有 ${unresolved} 份对比报告的两侧模型无法对应到当前配置（渠道/模型已删除，或改名且未留曾用名），未计入清单。</p>`
      : "";
    if (!peers.length) {
      peersBox.innerHTML = `<p class="field-hint">这个基准模型还没有任何两两对比报告。请先在上面的「模型比对」里让它与其它模型各生成一次对比报告，再回来并排查看。</p>${unresolvedNote}`;
      peersBox.classList.remove("hidden");
      return;
    }
    const items = peers
      .map(
        (p, i) =>
          `<label class="mc-scenario-item"><input type="checkbox" data-mcm-peer value="${i}" /><span>${escapeHtml(`${p.channel} / ${p.model}`)} <em>${escapeHtml(`比对 ${p.compareCount} 次 · 最近 ${p.lastComparedAt}`)}</em></span></label>`,
      )
      .join("");
    peersBox.innerHTML = `
      <div class="mc-scenario-tools">
        <span class="field-hint" id="mcm-peer-count"></span>
        <span class="mc-scenario-actions">
          <button type="button" class="link-button" data-mcm-all>选前 ${MULTI_MAX_PEERS} 个</button>
          <button type="button" class="link-button" data-mcm-none>清空</button>
        </span>
      </div>
      <div class="mc-scenario-list">${items}</div>
      ${unresolvedNote}`;
    peersBox.classList.remove("hidden");
    // 这两个按钮是本次 innerHTML 新建的子节点、随重渲染一起丢弃，故可在渲染函数里挂监听
    // （与 renderScenarioChecklist 同一判据）。持久容器 peersBox 的 change 监听在 init 处只挂一次。
    peersBox.querySelector("[data-mcm-all]").addEventListener("click", () => {
      [...peersBox.querySelectorAll("[data-mcm-peer]")].forEach((el, i) => (el.checked = i < MULTI_MAX_PEERS));
      updatePeerCount();
      clearMultiResult();
    });
    peersBox.querySelector("[data-mcm-none]").addEventListener("click", () => {
      peersBox.querySelectorAll("[data-mcm-peer]").forEach((el) => (el.checked = false));
      updatePeerCount();
      clearMultiResult();
    });
    updatePeerCount();
  }

  async function onMultiSubmit(event) {
    event.preventDefault();
    const id = cascadeBase.value;
    if (!id) {
      toast("请先选好基准模型（渠道 + 模型）。", true);
      return;
    }
    const baseSubject = subjectOf(id);
    if (!baseSubject) {
      toast("找不到所选模型信息，请刷新后重试。", true);
      return;
    }
    if (!loadedPeers) {
      toast("请先点「加载可比对模型」。", true);
      return;
    }
    const picked = checkedPeers();
    if (!picked.length) {
      toast("请至少勾选一个对比模型。", true);
      return;
    }
    if (picked.length > MULTI_MAX_PEERS) {
      toast(`一次最多并排 ${MULTI_MAX_PEERS} 个对比模型，请减少勾选。`, true);
      return;
    }
    // peer 的曾用名要用本地 state 补齐：后端靠「渠道_模型」前缀认领历史报告，缺曾用名会漏掉改名前的报告。
    const peers = picked.map((p) => {
      const local = p.targetId ? subjectOf(p.targetId) : null;
      return local ? { ...local, targetId: p.targetId } : { channel: p.channel, model: p.model };
    });

    multiGenerateBtn.disabled = true;
    const prevLabel = multiGenerateBtn.textContent;
    multiGenerateBtn.textContent = "生成中…";
    const requestRevision = clearMultiResult();
    try {
      const r = await api("/api/reports/compare/multi", {
        method: "POST",
        body: JSON.stringify({ base: { ...baseSubject, targetId: id }, peers }),
      });
      if (requestRevision !== multiRevision) return;
      renderMultiResult(r);
    } catch (error) {
      if (requestRevision !== multiRevision) return;
      toast(`生成失败：${error.message}`, true);
    } finally {
      multiGenerateBtn.disabled = false;
      multiGenerateBtn.textContent = prevLabel;
    }
  }

  // N 列单元格：列数不固定，故胜出/基准高亮走【单元格级 class】，不能用 CSS nth-child。
  function multiMetricCell(row, index) {
    const v = row.values?.[index] || {};
    const cls = `${index === 0 ? " is-base" : ""}${row.bestIndex === index ? " is-winner" : ""}`;
    return `<td class="mc-compare-value${cls}"><strong>${escapeHtml(formatMetricNumber(v.value, row.format, row.unit, v.coverage))}</strong></td>`;
  }

  function multiScenarioCell(row, index) {
    return scenarioCellFrom(row.values?.[index], `${index === 0 ? " is-base" : ""}${row.bestIndex === index ? " is-winner" : ""}`);
  }

  function renderMultiComparison(comparison) {
    if (!comparison || !Array.isArray(comparison.summary) || !comparison.summary.length) return "";
    const subjects = Array.isArray(comparison.subjects) ? comparison.subjects : [];
    const headCells = subjects
      .map((s, i) => `<th scope="col"><span>${escapeHtml(s?.label || `对象 ${i + 1}`)}</span>${i === 0 ? "<small>基准</small>" : ""}</th>`)
      .join("");
    const summaryRows = comparison.summary
      .map(
        (row) => `<tr class="${row.status === "insufficient" ? "is-insufficient" : ""}">
          <th scope="row"><span>${escapeHtml(row.label || "-")}</span>${row.detail ? `<small>${escapeHtml(row.detail)}</small>` : ""}</th>
          ${subjects.map((_, i) => multiMetricCell(row, i)).join("")}
        </tr>`,
      )
      .join("");
    const scenarios = Array.isArray(comparison.scenarios) ? comparison.scenarios : [];
    const scenarioRows = scenarios
      .map(
        (row) => `<tr class="${row.status === "insufficient" ? "is-insufficient" : ""}">
          <th scope="row"><span>${escapeHtml(row.name || "-")}</span>${row.tier ? `<small>${escapeHtml(row.tier)}</small>` : ""}</th>
          ${subjects.map((_, i) => multiScenarioCell(row, i)).join("")}
        </tr>`,
      )
      .join("");
    return `
      <section class="mc-compare-table" aria-label="多模型并排对比">
        <div class="mc-compare-table-head">
          <h3>并排对比</h3>
          <span>${Math.max(subjects.length - 1, 0)} 个对比模型 · ${comparison.sharedScenarioCount ?? 0} 个共享场景</span>
        </div>
        <div class="mc-compare-scroll">
          <table class="mc-compare-summary"><thead><tr><th scope="col">指标</th>${headCells}</tr></thead><tbody>${summaryRows}</tbody></table>
        </div>
        <details class="mc-scenario-details">
          <summary>逐场景对照 <span>${scenarios.length}</span></summary>
          ${
            scenarios.length
              ? `<div class="mc-compare-scroll"><table><thead><tr><th scope="col">场景</th>${headCells}</tr></thead><tbody>${scenarioRows}</tbody></table></div>`
              : '<p class="field-hint">没有 N 方共享的同名场景（各对比模型与基准的共有场景取交集后为空），摘要里的场景派生指标也会因此为空。可先用上面的两两对比「补齐单方场景」。</p>'
          }
        </details>
      </section>`;
  }

  function renderMultiResult({ comparison, skipped, notes }) {
    const skipNote =
      Array.isArray(skipped) && skipped.length
        ? `<p class="field-hint">已跳过 ${skipped.length} 个模型：${escapeHtml(skipped.map((s) => `${s.label}（${s.reason}）`).join("、"))}</p>`
        : "";
    const usedNote = [`基准采用报告：${notes?.base || "-"}`, ...(notes?.peers || []).map((p) => `${p.label}：${p.used}`)].join("；");
    multiResultBox.innerHTML = `
      <section class="mc-result" aria-live="polite">
        ${renderMultiComparison(comparison)}
        <div class="action-row" style="justify-content:flex-start">
          <button type="button" class="secondary" data-mcm-export-csv>导出 CSV</button>
        </div>
        ${skipNote}
        <p class="field-hint" style="margin-top:10px">${escapeHtml(usedNote)}</p>
      </section>`;
    multiResultBox.querySelector("[data-mcm-export-csv]").addEventListener("click", () => {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "");
      downloadText(`多模型对比_${stamp}.csv`, `﻿${buildMultiComparisonCsv(comparison)}`, "text/csv");
    });
  }

  loadScenariosBtn.addEventListener("click", onLoadScenarios);
  fillGapsBtn.addEventListener("click", onFillGaps);
  loadPeersBtn.addEventListener("click", onLoadPeers);
  multiForm.addEventListener("submit", onMultiSubmit);
  // 勾选变化 → 更新计数并清掉旧表格。挂在持久容器上，故只在此挂一次。
  peersBox.addEventListener("change", () => {
    updatePeerCount();
    clearMultiResult();
  });
  // 换基准模型 → 旧的可比对清单属于上一个基准，必须重置，避免拿旧清单发请求。
  for (const el of [baseChannel, baseModel]) el.addEventListener("change", resetPeers);
  // 勾选变化 → 更新计数。挂在持久容器上，故只在此挂一次（放渲染函数里会每次渲染叠加）。
  scenariosBox.addEventListener("change", () => {
    updateScenarioCount();
    clearResult();
  });
  // 换模型/渠道后，已加载的场景列表可能不再适用 → 重置，避免用旧场景生成。
  for (const el of [aChannel, aModel, bChannel, bModel]) el.addEventListener("change", resetScenarios);

  form.addEventListener("submit", onSubmit);

  function refreshTargets(data) {
    cascadeA.refresh(data);
    cascadeB.refresh(data);
    cascadeBase.refresh(data);
  }

  // 进入页面：用当前 state 刷新三个级联下拉（两两对比的 A/B + 多模型对比的基准）。
  function load() {
    refreshTargets({ modelTargets: state.modelTargets, channels: state.channels, profiles: state.profiles });
  }

  async function cancelGapFill() {
    if (!gapFillRunning) {
      toast("当前没有进行中的补齐任务。", true);
      return;
    }
    gapFillCancellationRequested = true;
    const p = gapProgress.querySelector("p");
    if (p) p.textContent = "正在取消本次补齐，后续场景不会再开始。";
    if (state.activeTasks["mc-gap-fill"]) await cancelRemoteTask(state, "mc-gap-fill");
  }

  return { load, refreshTargets, cancelGapFill };
}
