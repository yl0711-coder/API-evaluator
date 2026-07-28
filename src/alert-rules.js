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
  const scopeTypeSelect = requireElement("#ar-scope-type");
  const targetPickerBox = requireElement("#ar-target-picker");
  const channelSelect = requireElement("#ar-channel-select");
  const modelSelect = requireElement("#ar-model-select");
  const metricSelect = requireElement("#ar-metric");
  const comparatorSelect = requireElement("#ar-comparator");
  const thresholdNumberLabel = requireElement("#ar-threshold-number-label");
  const thresholdNumberInput = requireElement("#ar-threshold-number");
  const thresholdLevelLabel = requireElement("#ar-threshold-level-label");
  const thresholdLevelSelect = requireElement("#ar-threshold-level");
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
  function syncMetric() {
    const isLevel = LEVEL_METRICS.includes(metricSelect.value);
    thresholdNumberLabel.classList.toggle("hidden", isLevel);
    thresholdLevelLabel.classList.toggle("hidden", !isLevel);
    if (isLevel) thresholdLevelSelect.innerHTML = levelOptionsHtml(metricSelect.value);
  }
  metricSelect.addEventListener("change", syncMetric);
  syncMetric();

  function resetForm() {
    ruleIdInput.value = "";
    nameInput.value = "";
    scopeTypeSelect.value = "all";
    cascade.setValue("", { silent: true });
    syncScopeType();
    metricSelect.value = "successRate";
    comparatorSelect.value = "lt";
    thresholdNumberInput.value = "";
    syncMetric();
    cooldownInput.value = "1";
    enabledInput.checked = true;
    formTitle.textContent = "新建报警规则";
  }
  resetBtn.addEventListener("click", resetForm);
  reloadBtn.addEventListener("click", loadRules);

  function collect() {
    const isLevel = LEVEL_METRICS.includes(metricSelect.value);
    const scopeType = scopeTypeSelect.value;
    return {
      id: ruleIdInput.value || undefined,
      name: nameInput.value.trim(),
      scope: scopeType === "target" ? { type: "target", targetId: cascade.value } : { type: "all" },
      metric: metricSelect.value,
      comparator: comparatorSelect.value,
      threshold: isLevel ? thresholdLevelSelect.value : Number(thresholdNumberInput.value),
      cooldownHours: Math.max(0.1, Number(cooldownInput.value) || 0.1),
      enabled: enabledInput.checked,
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
    try {
      await api("/api/alert-rules", { method: "POST", body: JSON.stringify(body) });
      toast(body.id ? "规则已更新。" : "规则已创建。");
      resetForm();
      await loadRules();
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    }
  });

  function editRule(rule) {
    ruleIdInput.value = rule.id;
    nameInput.value = rule.name || "";
    scopeTypeSelect.value = rule.scope?.type === "target" ? "target" : "all";
    syncScopeType();
    if (rule.scope?.type === "target") cascade.setValue(rule.scope.targetId, { silent: true });
    metricSelect.value = rule.metric;
    syncMetric();
    comparatorSelect.value = rule.comparator;
    if (LEVEL_METRICS.includes(rule.metric)) thresholdLevelSelect.value = String(rule.threshold ?? "");
    else thresholdNumberInput.value = String(rule.threshold ?? "");
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

  function ruleCard(rule) {
    const card = document.createElement("div");
    card.className = "atc-job-card";
    const targetWarn = rule.scope?.type === "target" && rule.targetRunnable === false ? ` <span class="pill danger">目标不可用</span>` : "";
    card.innerHTML = `
      <div class="atc-job-head">
        <b>${escapeHtml(rule.name || rule.id)}</b>
        <span class="pill ${rule.enabled ? "" : "muted"}">${rule.enabled ? "已启用" : "已停用"}</span>${targetWarn}
      </div>
      <div class="atc-job-meta">
        范围：${scopeText(rule)}<br>
        条件：${escapeHtml(METRIC_LABEL[rule.metric] || rule.metric)} ${escapeHtml(COMPARATOR_LABEL[rule.comparator] || rule.comparator)} ${escapeHtml(thresholdText(rule))}<br>
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
