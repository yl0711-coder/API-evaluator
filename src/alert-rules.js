// src/alert-rules.js
// 「报警规则」：任意登录管理员可自定义阈值报警规则——测试运行完成后，若某项原始指标触发阈值即发信提醒。
// 不复用高危/回归判定逻辑，直接对运行结果的原始数值/等级字段做比较。表单沿用「自动测试配置」页的
// .panel.form-grid 观感；范围用「全部」单选 + 复用的级联渠道/模型选择器（无「全部」选项时补一个单选切换）。
import { escapeHtml, toast, renderMarkdown } from "./client-utils.js";
import { api } from "./api-client.js";
import { requireElement } from "./dom-utils.js";
import { createCascadeTargetPicker } from "./target-picker.js";
import alertRulesGuideDoc from "./docs/alert-rules-guide.md?raw";

const METRIC_LABEL = {
  successRate: "成功率",
  p95TotalMs: "P95 耗时（毫秒）",
  avgTotalMs: "平均耗时（毫秒）",
  score: "综合分（准入）",
  grade: "准入等级",
  avgQualityScore: "质量分（场景）",
  recommendationLevel: "结论等级",
  verdictLevel: "快速验证结论",
};
const COMPARATOR_LABEL = { lt: "低于", lte: "不高于", gt: "高于", gte: "不低于", eq: "等于" };
const LEVEL_METRICS = ["grade", "recommendationLevel", "verdictLevel"];
const JITTER_KIND = "stability-jitter";
const DECLINE_KIND = "stability-decline";
// 退化规则冷却默认 24 小时（其余形态 1 小时）：持续退化会让之后【每一次】运行都继续命中
// （两个窗口整体下移），1 小时冷却在 2 小时一测的节奏下等于每次都发。24 小时把一次退化事件收敛成一封信。
const DECLINE_DEFAULT_COOLDOWN_HOURS = 24;
const LEVEL_OPTIONS = {
  grade: ["A", "B", "C", "D", "E", "X", "F"],
  recommendationLevel: [
    ["pass", "通过"],
    ["watch", "观察"],
    ["fail", "不通过"],
  ],
  verdictLevel: [
    ["ok", "正常"],
    ["watch", "观察"],
    ["suspect", "疑似异常"],
  ],
};

function levelOptionsHtml(metric) {
  const opts = LEVEL_OPTIONS[metric] || [];
  return opts
    .map((o) =>
      Array.isArray(o)
        ? `<option value="${escapeHtml(o[0])}">${escapeHtml(o[1])}</option>`
        : `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`,
    )
    .join("");
}

export function createAlertRules({ state, confirm }) {
  const form = requireElement("#ar-form");
  const formTitle = requireElement("#ar-form-title");
  const ruleIdInput = requireElement("#ar-rule-id");
  const nameInput = requireElement("#ar-name");
  const kindSelect = requireElement("#ar-kind");
  const scopeTypeSelect = requireElement("#ar-scope-type");
  const targetPickerBox = requireElement("#ar-target-picker");
  const channelSelect = requireElement("#ar-channel-select");
  const modelSelect = requireElement("#ar-model-select");
  const metricLabel = requireElement("#ar-metric-label");
  const metricSelect = requireElement("#ar-metric");
  const comparatorLabel = requireElement("#ar-comparator-label");
  const comparatorSelect = requireElement("#ar-comparator");
  const thresholdNumberLabel = requireElement("#ar-threshold-number-label");
  const thresholdNumberInput = requireElement("#ar-threshold-number");
  const thresholdLevelLabel = requireElement("#ar-threshold-level-label");
  const thresholdLevelSelect = requireElement("#ar-threshold-level");
  const jitterBox = requireElement("#ar-jitter-params");
  const jitterRatioInput = requireElement("#ar-jitter-ratio");
  const jitterFirstSrInput = requireElement("#ar-jitter-first-sr");
  const jitterRetryOverheadInput = requireElement("#ar-jitter-retry-overhead");
  const declineBox = requireElement("#ar-decline-params");
  const declineRecentInput = requireElement("#ar-decline-recent");
  const declineBaselineInput = requireElement("#ar-decline-baseline");
  const declineSrDropInput = requireElement("#ar-decline-sr-drop");
  const declineP95WorsenInput = requireElement("#ar-decline-p95-worsen");
  const cooldownInput = requireElement("#ar-cooldown");
  const enabledInput = requireElement("#ar-enabled");
  const resetBtn = requireElement("#ar-reset");
  const reloadBtn = requireElement("#ar-reload");
  const metricDocBtn = requireElement("#ar-metric-doc");
  const listBox = requireElement("#ar-rule-list");

  // 新标签页渲染 md 文档，与「测试场景维护」页的评分器/类别说明同款惯用法。
  function openDocInNewTab(title, md) {
    const w = window.open("", "_blank");
    if (!w) {
      toast("浏览器拦截了弹窗，请允许后重试。", true);
      return;
    }
    const style =
      "body{font-family:system-ui,'Segoe UI',sans-serif;max-width:880px;margin:24px auto;padding:0 20px;line-height:1.7;color:#1b2330}" +
      "h1{font-size:24px}h2{font-size:19px;margin-top:1.6em}h3{font-size:16px}" +
      "code{background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:.92em}" +
      "pre{background:#f2f4f7;padding:12px;border-radius:8px;overflow:auto}" +
      "table{border-collapse:collapse;width:100%;margin:12px 0}" +
      "th,td{border:1px solid #d4d9e0;padding:6px 10px;text-align:left;font-size:14px}th{background:#f2f4f7}";
    w.document.write(
      `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>${renderMarkdown(md)}</body></html>`,
    );
    w.document.close();
  }
  metricDocBtn.addEventListener("click", () => openDocInNewTab("报警规则说明", alertRulesGuideDoc));

  const cascade = createCascadeTargetPicker(channelSelect, modelSelect);

  // 范围单选：「全部」隐藏级联选择器；「指定」显示。同 auto-test-config 惯用的 .hidden class 切换。
  function syncScopeType() {
    targetPickerBox.classList.toggle("hidden", scopeTypeSelect.value !== "target");
  }
  scopeTypeSelect.addEventListener("change", syncScopeType);
  syncScopeType();

  // 指标切换：等级型指标（grade/recommendationLevel/verdictLevel）用等级下拉选阈值，其余用数值输入。
  // 复合形态（jitter/decline）下这三个控件整体隐藏，故先看 kind 再决定阈值控件的显隐。
  function syncMetric() {
    if (kindSelect.value !== "threshold") {
      thresholdNumberLabel.classList.add("hidden");
      thresholdLevelLabel.classList.add("hidden");
      return;
    }
    const isLevel = LEVEL_METRICS.includes(metricSelect.value);
    thresholdNumberLabel.classList.toggle("hidden", isLevel);
    thresholdLevelLabel.classList.toggle("hidden", !isLevel);
    if (isLevel) thresholdLevelSelect.innerHTML = levelOptionsHtml(metricSelect.value);
  }
  metricSelect.addEventListener("change", syncMetric);

  // 规则类型切换：三组控件互斥显隐——阈值形态（指标+比较符+阈值）/ 稳定性抖动（三个子阈值）/
  // 稳定性退化（两个窗口 + 两个判定阈值）。
  // 同上用 .hidden class 而非 hidden 属性——本页 .form-grid 的 display:grid 压不住 UA 的 display:none。
  function syncKind() {
    const kind = kindSelect.value;
    const isThreshold = kind === "threshold";
    metricLabel.classList.toggle("hidden", !isThreshold);
    comparatorLabel.classList.toggle("hidden", !isThreshold);
    jitterBox.classList.toggle("hidden", kind !== JITTER_KIND);
    declineBox.classList.toggle("hidden", kind !== DECLINE_KIND);
    syncMetric();
  }
  // 切到退化形态时把冷却默认值抬到 24 小时（仅在用户还没手改过、且是新建时）——
  // 避免持续退化下每 2 小时就来一封。用户随后手改的值不会被这里覆盖。
  kindSelect.addEventListener("change", () => {
    syncKind();
    if (!ruleIdInput.value) {
      cooldownInput.value = kindSelect.value === DECLINE_KIND ? String(DECLINE_DEFAULT_COOLDOWN_HOURS) : "1";
    }
  });
  syncKind();

  function resetForm() {
    ruleIdInput.value = "";
    nameInput.value = "";
    kindSelect.value = "threshold";
    scopeTypeSelect.value = "all";
    cascade.setValue("", { silent: true });
    syncScopeType();
    metricSelect.value = "successRate";
    comparatorSelect.value = "lt";
    thresholdNumberInput.value = "";
    // 抖动子阈值的默认值：倍数 6 与首次成功率 0.9 有实测依据（正常区间 2.3～3.6×），
    // 重试额外等待留空（历史数据常无 endToEndMs，默认给个数会让人以为在检查其实一直跳过）。
    jitterRatioInput.value = "6";
    jitterFirstSrInput.value = "0.9";
    jitterRetryOverheadInput.value = "";
    // 退化默认：最近 3 次 vs 之前 20 次（约 6 小时 vs 1.7 天，按 2 小时一测的节奏），
    // 跌幅 10pp / P95 恶化 1.5× 沿用趋势页既有回归判定的克制口径。
    declineRecentInput.value = "3";
    declineBaselineInput.value = "20";
    declineSrDropInput.value = "0.1";
    declineP95WorsenInput.value = "1.5";
    syncKind();
    cooldownInput.value = "1";
    enabledInput.checked = true;
    formTitle.textContent = "新建报警规则";
  }
  resetBtn.addEventListener("click", resetForm);
  reloadBtn.addEventListener("click", loadRules);

  // 空输入框送 null 而非 0：后端把 null 当「不检查该项」，0 会被当成真阈值（且非正数会被兜成 null，
  // 但语义上还是送 null 更直白）。
  const optionalNum = (input) => (input.value.trim() === "" ? null : Number(input.value));

  function collect() {
    const scopeType = scopeTypeSelect.value;
    const base = {
      id: ruleIdInput.value || undefined,
      name: nameInput.value.trim(),
      kind: kindSelect.value,
      scope: scopeType === "target" ? { type: "target", targetId: cascade.value } : { type: "all" },
      cooldownHours: Math.max(0.1, Number(cooldownInput.value) || 0.1),
      enabled: enabledInput.checked,
    };
    if (kindSelect.value === JITTER_KIND) {
      return {
        ...base,
        params: {
          jitterRatioMax: optionalNum(jitterRatioInput),
          firstAttemptSuccessRateMin: optionalNum(jitterFirstSrInput),
          retryOverheadP95MsMax: optionalNum(jitterRetryOverheadInput),
        },
      };
    }
    if (kindSelect.value === DECLINE_KIND) {
      return {
        ...base,
        params: {
          // 窗口尺寸留空也送 null，后端 normalizeWindowSize 会兜默认 3 / 20。
          recentRuns: optionalNum(declineRecentInput),
          baselineRuns: optionalNum(declineBaselineInput),
          successRateDropPp: optionalNum(declineSrDropInput),
          p95WorsenRatio: optionalNum(declineP95WorsenInput),
        },
      };
    }
    const isLevel = LEVEL_METRICS.includes(metricSelect.value);
    return {
      ...base,
      metric: metricSelect.value,
      comparator: comparatorSelect.value,
      threshold: isLevel ? thresholdLevelSelect.value : Number(thresholdNumberInput.value),
    };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = collect();
    if (!body.name) {
      toast("请填写规则名称。", true);
      return;
    }
    if (body.scope.type === "target" && !body.scope.targetId) {
      toast("请选择渠道与模型，或改为「全部渠道 + 模型」。", true);
      return;
    }
    // 后端也会拦（返回 400），这里先拦一道给即时反馈，省一次往返。
    if (body.kind === JITTER_KIND && !Object.values(body.params).some((v) => Number.isFinite(v) && v > 0)) {
      toast("稳定性抖动规则至少要配一项子阈值。", true);
      return;
    }
    // 退化规则只看两个【判定阈值】——窗口尺寸留空后端会兜默认值，不算「配了一项」。
    if (body.kind === DECLINE_KIND) {
      const thresholds = [body.params.successRateDropPp, body.params.p95WorsenRatio];
      if (!thresholds.some((v) => Number.isFinite(v) && v > 0)) {
        toast("稳定性退化规则至少要配一项判定阈值（成功率跌幅 / P95 恶化倍数）。", true);
        return;
      }
    }
    try {
      await api("/api/alert-rules", { method: "POST", body: JSON.stringify(body) });
      toast(body.id ? "规则已更新。" : "规则已创建。");
      resetForm();
      await loadRules();
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    }
  });

  // 回填数值输入：null/undefined（= 该项不检查）要留空，不能写成 "null" 或 0。
  const fillOptional = (input, value) => {
    input.value = Number.isFinite(value) ? String(value) : "";
  };

  function editRule(rule) {
    ruleIdInput.value = rule.id;
    nameInput.value = rule.name || "";
    kindSelect.value = rule.kind === JITTER_KIND || rule.kind === DECLINE_KIND ? rule.kind : "threshold";
    scopeTypeSelect.value = rule.scope?.type === "target" ? "target" : "all";
    syncScopeType();
    if (rule.scope?.type === "target") cascade.setValue(rule.scope.targetId, { silent: true });
    if (rule.kind === JITTER_KIND) {
      const p = rule.params || {};
      fillOptional(jitterRatioInput, p.jitterRatioMax);
      fillOptional(jitterFirstSrInput, p.firstAttemptSuccessRateMin);
      fillOptional(jitterRetryOverheadInput, p.retryOverheadP95MsMax);
    } else if (rule.kind === DECLINE_KIND) {
      const p = rule.params || {};
      fillOptional(declineRecentInput, p.recentRuns);
      fillOptional(declineBaselineInput, p.baselineRuns);
      fillOptional(declineSrDropInput, p.successRateDropPp);
      fillOptional(declineP95WorsenInput, p.p95WorsenRatio);
    } else {
      metricSelect.value = rule.metric;
      comparatorSelect.value = rule.comparator;
      if (LEVEL_METRICS.includes(rule.metric)) {
        // 等级下拉的 options 由 syncMetric 按指标现填，故必须先 sync 再赋 value，否则赋不上。
        syncMetric();
        thresholdLevelSelect.value = String(rule.threshold ?? "");
      } else {
        thresholdNumberInput.value = String(rule.threshold ?? "");
      }
    }
    syncKind();
    cooldownInput.value = String(rule.cooldownHours ?? 1);
    enabledInput.checked = rule.enabled !== false;
    formTitle.textContent = `编辑规则：${rule.name || rule.id}`;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function toggleEnabled(rule) {
    try {
      await api("/api/alert-rules", { method: "POST", body: JSON.stringify({ ...rule, enabled: !rule.enabled }) });
      await loadRules();
    } catch (error) {
      toast(`操作失败：${error.message}`, true);
    }
  }

  async function deleteRule(rule) {
    const ok = await confirm?.({
      title: "删除报警规则",
      message: `确定删除规则「${rule.name || rule.id}」吗？`,
      detail: "删除后不再对该规则做判断。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`/api/alert-rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
      toast("规则已删除。");
      await loadRules();
    } catch (error) {
      toast(`删除失败：${error.message}`, true);
    }
  }

  function scopeText(rule) {
    if (rule.scope?.type !== "target") return "全部渠道 + 模型";
    if (rule.targetRunnable === false) return `指定目标（已不可用）`;
    return `指定：${escapeHtml(rule.targetName || rule.scope.targetId)}`;
  }

  function thresholdText(rule) {
    if (LEVEL_METRICS.includes(rule.metric)) {
      const opts = LEVEL_OPTIONS[rule.metric] || [];
      const hit = opts.find((o) => (Array.isArray(o) ? o[0] === rule.threshold : o === rule.threshold));
      return hit ? (Array.isArray(hit) ? hit[1] : hit) : String(rule.threshold);
    }
    return String(rule.threshold);
  }

  // 卡片「条件：」行。复合规则列出已配置的子阈值（未配置的不列，与「不检查」的语义一致）。
  // 返回值会插进 innerHTML，故这里出现的动态量都得转义；数值走 Number() 后拼接，本身不含标记。
  function conditionHtml(rule) {
    const p = rule.params || {};
    if (rule.kind === JITTER_KIND) {
      const lines = [];
      if (Number.isFinite(p.jitterRatioMax)) lines.push(`耗时抖动倍数（P95÷P50）高于 ${Number(p.jitterRatioMax)}×`);
      if (Number.isFinite(p.firstAttemptSuccessRateMin)) lines.push(`首次成功率低于 ${Math.round(p.firstAttemptSuccessRateMin * 100)}%`);
      if (Number.isFinite(p.retryOverheadP95MsMax)) lines.push(`重试额外等待 P95 高于 ${Number(p.retryOverheadP95MsMax)}ms`);
      if (!lines.length) return "（未配置任何子阈值，不会触发）";
      return `任一越界即不合格<br>${lines.map((l) => `　· ${escapeHtml(l)}`).join("<br>")}`;
    }
    if (rule.kind === DECLINE_KIND) {
      const lines = [];
      if (Number.isFinite(p.successRateDropPp)) lines.push(`成功率中位数跌幅达 ${Math.round(p.successRateDropPp * 100)}pp`);
      if (Number.isFinite(p.p95WorsenRatio)) lines.push(`P95 中位数恶化达 ${Number(p.p95WorsenRatio)}×`);
      if (!lines.length) return "（未配置任何判定阈值，不会触发）";
      const window = `最近 ${Number(p.recentRuns) || 3} 次 vs 之前 ${Number(p.baselineRuns) || 20} 次`;
      return `${escapeHtml(window)}，任一越界即不合格<br>${lines.map((l) => `　· ${escapeHtml(l)}`).join("<br>")}`;
    }
    return `${escapeHtml(METRIC_LABEL[rule.metric] || rule.metric)} ${escapeHtml(COMPARATOR_LABEL[rule.comparator] || rule.comparator)} ${escapeHtml(thresholdText(rule))}`;
  }

  function ruleCard(rule) {
    const card = document.createElement("div");
    card.className = "atc-job-card";
    const targetWarn = rule.scope?.type === "target" && rule.targetRunnable === false ? ` <span class="pill danger">目标不可用</span>` : "";
    // kindPill 是硬编码 HTML，不是用户数据——刻意不转义（同 auto-test-config 的 targetWarn 惯例）。
    const kindPill =
      rule.kind === JITTER_KIND
        ? ` <span class="pill">稳定性抖动</span>`
        : rule.kind === DECLINE_KIND
          ? ` <span class="pill">稳定性退化</span>`
          : "";
    card.innerHTML = `
      <div class="atc-job-head">
        <b>${escapeHtml(rule.name || rule.id)}</b>
        <span class="pill ${rule.enabled ? "" : "muted"}">${rule.enabled ? "已启用" : "已停用"}</span>${kindPill}${targetWarn}
      </div>
      <div class="atc-job-meta">
        范围：${scopeText(rule)}<br>
        条件：${conditionHtml(rule)}<br>
        冷却：${Number(rule.cooldownHours)} 小时
      </div>
      <div class="action-row atc-job-actions"></div>`;
    const actions = card.querySelector(".atc-job-actions");
    const mkBtn = (label, cls, handler) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      b.addEventListener("click", handler);
      return b;
    };
    actions.append(
      mkBtn(rule.enabled ? "停用" : "启用", "secondary", () => toggleEnabled(rule)),
      mkBtn("编辑", "secondary", () => editRule(rule)),
      mkBtn("删除", "danger", () => deleteRule(rule)),
    );
    return card;
  }

  async function loadRules() {
    listBox.textContent = "正在加载…";
    try {
      const r = await api("/api/alert-rules");
      const rules = Array.isArray(r.rules) ? r.rules : [];
      listBox.innerHTML = "";
      if (!rules.length) {
        listBox.innerHTML = `<div class="muted">还没有配置任何报警规则。</div>`;
        return;
      }
      for (const rule of rules) listBox.append(ruleCard(rule));
    } catch (error) {
      listBox.textContent = `加载规则失败：${error.message}`;
    }
  }

  async function load() {
    cascade.refresh({ modelTargets: state.modelTargets, channels: state.channels, profiles: state.profiles });
    await loadRules();
  }

  function refreshTargets(data) {
    cascade.refresh(data);
  }

  return { load, refreshTargets };
}
