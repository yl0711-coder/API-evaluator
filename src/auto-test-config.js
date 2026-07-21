// src/auto-test-config.js
// 「自动测试配置」：为某渠道的某模型配置定时自动测试作业（种类 + 周期），
// 到点由后端调度器自动跑一次并产出报告。表单沿用「高级测试」各页的 .panel.form-grid 观感（两列网格 + .wide 跨行 + .checkbox-option）。
// 渠道→模型用共享级联选择器；场景题用简单勾选列表。CRUD 走 /api/auto-test-jobs（登录即可用，普通管理员 role 10 也可）。
import { escapeHtml, toast, downloadText } from "./client-utils.js";
import { api } from "./api-client.js";
import { requireElement } from "./dom-utils.js";
import { createCascadeTargetPicker } from "./target-picker.js";
import { createScenarioCasePicker } from "./scenario-case-picker.js";
import { renderPromptPresetOptions, getPromptPreset } from "./prompt-presets.js";
import { openReportOverlay } from "./report-overlay.js";

const KIND_LABEL = {
  quick: "快速测试",
  admission: "准入评测",
  stability: "稳定性测试",
  scenario: "场景测试",
};
const STATUS_LABEL = { running: "运行中", success: "成功", failed: "失败" };

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function createAutoTestConfig({ state, confirm }) {
  const form = requireElement("#atc-form");
  const formTitle = requireElement("#atc-form-title");
  const jobIdInput = requireElement("#atc-job-id");
  const nameInput = requireElement("#atc-name");
  const channelSelect = requireElement("#atc-channel-select");
  const modelSelect = requireElement("#atc-model-select");
  const kindSelect = requireElement("#atc-kind");
  const periodInput = requireElement("#atc-period");
  const enabledInput = requireElement("#atc-enabled");
  const roundsSelect = requireElement("#atc-rounds");
  const concurrencySelect = requireElement("#atc-concurrency");
  const packageLevelSelect = requireElement("#atc-package-level");
  const promptPresetSelect = requireElement("#atc-prompt-preset");
  const promptInput = requireElement("#atc-prompt");
  const scenarioSelect = requireElement("#atc-scenario-select");
  const scenarioPickerBox = requireElement("#atc-scenario-picker");
  const optStability = requireElement("#atc-opt-stability");
  const optAdmission = requireElement("#atc-opt-admission");
  const optScenario = requireElement("#atc-opt-scenario");
  const resetBtn = requireElement("#atc-reset");
  const reloadBtn = requireElement("#atc-reload");
  const listBox = requireElement("#atc-job-list");
  const digestWindow = requireElement("#atc-digest-window");
  const digestGenerate = requireElement("#atc-digest-generate");
  const digestResult = requireElement("#atc-digest-result");

  const cascade = createCascadeTargetPicker(channelSelect, modelSelect);
  // 场景多选：复用「场景测试」页的同款选择器（勾选列表 + 分组筛选 + 全选/清空 + chips），
  // 背后写回隐藏的 <select multiple>；与场景测试页一致。
  const scenarioPicker = createScenarioCasePicker(scenarioPickerBox, scenarioSelect);

  // 稳定性「测试文案场景」下拉：与稳定性页同源（复用 prompt-presets）。选预设自动填文案；自定义则可编辑。
  promptPresetSelect.innerHTML = renderPromptPresetOptions("stability", "basic");
  function applyPromptPreset() {
    const preset = getPromptPreset("stability", promptPresetSelect.value);
    const isCustom = preset.id === "custom";
    promptInput.readOnly = !isCustom;
    promptInput.classList.toggle("readonly-prompt", !isCustom);
    if (isCustom) promptInput.focus();
    else promptInput.value = preset.prompt;
  }
  promptPresetSelect.addEventListener("change", applyPromptPreset);
  applyPromptPreset(); // 初始化：把默认预设文案填进 textarea（即便当前隐藏）

  // 按测试种类显隐对应选项区（种类为空 → 全部隐藏，满足“选定后再显示”）。
  // 用内联 style.display 而非 hidden 属性：本页 CSS 给这些块设了 id 选择器的 display（网格/边框），
  // 会盖过 [hidden]；内联样式优先级最高，才切得动（与 developer.js 同一处理）。
  function syncKindOptions() {
    const kind = kindSelect.value;
    optStability.style.display = kind === "stability" ? "" : "none";
    optAdmission.style.display = kind === "admission" ? "" : "none";
    optScenario.style.display = kind === "scenario" ? "" : "none";
  }
  kindSelect.addEventListener("change", syncKindOptions);
  syncKindOptions(); // 初始（种类为空）即隐藏全部配置块，防首帧闪现

  // 用 state.scenarios（脱敏，含 id/name/difficulty/tag/group）填隐藏 <select multiple> 的 options，
  // 标记 selectedIds 为选中，再刷新选择器 UI。option 标记与场景测试页 renderScenarioOptions 同源。
  function populateScenarioOptions(selectedIds = []) {
    const scenarios = Array.isArray(state.scenarios) ? state.scenarios : [];
    const sel = new Set(selectedIds);
    scenarioSelect.innerHTML = scenarios.length
      ? scenarios
          .map(
            (s) =>
              `<option value="${escapeHtml(s.id)}" data-name="${escapeHtml(s.name)}" data-difficulty="${escapeHtml(s.difficulty || "")}" data-tag="${escapeHtml(s.tag || "")}" data-group="${escapeHtml(s.group || "")}"${sel.has(s.id) ? " selected" : ""}>${escapeHtml(s.name)} / ${escapeHtml(s.difficulty || "")}</option>`,
          )
          .join("")
      : "";
    scenarioPicker.refresh();
  }
  function selectedScenarioIds() {
    return [...scenarioSelect.selectedOptions].map((o) => o.value).filter(Boolean);
  }

  function resetForm() {
    jobIdInput.value = "";
    nameInput.value = "";
    kindSelect.value = "";
    periodInput.value = "24";
    enabledInput.checked = true;
    roundsSelect.value = "10";
    concurrencySelect.value = "1";
    packageLevelSelect.value = "standard";
    promptPresetSelect.value = "basic";
    applyPromptPreset();
    cascade.setValue("", { silent: true });
    populateScenarioOptions([]);
    syncKindOptions();
    formTitle.textContent = "新建自动测试作业";
  }
  resetBtn.addEventListener("click", resetForm);

  // 表单 → 作业载荷。稳定性额外带测试文案（prompt）与预设 id；场景不再带重复次数（默认 1）。
  function collect() {
    return {
      id: jobIdInput.value || undefined,
      name: nameInput.value.trim(),
      targetId: cascade.value,
      kind: kindSelect.value,
      periodHours: Math.max(0.5, Number(periodInput.value) || 0.5),
      scenarioIds: kindSelect.value === "scenario" ? selectedScenarioIds() : [],
      options: {
        rounds: Number(roundsSelect.value) || 10,
        concurrency: Number(concurrencySelect.value) || 1,
        packageLevel: packageLevelSelect.value,
        prompt: promptInput.value,
        promptPresetId: promptPresetSelect.value,
      },
      enabled: enabledInput.checked,
    };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = collect();
    if (!body.kind) {
      toast("请选择测试种类。", true);
      return;
    }
    if (!body.targetId) {
      toast("请选择被测渠道与模型。", true);
      return;
    }
    try {
      await api("/api/auto-test-jobs", { method: "POST", body: JSON.stringify(body) });
      toast(body.id ? "作业已更新。" : "作业已创建。");
      resetForm();
      await loadJobs();
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    }
  });

  // 编辑：回填表单。
  function editJob(job) {
    jobIdInput.value = job.id;
    nameInput.value = job.name || "";
    kindSelect.value = job.kind;
    periodInput.value = String(job.periodHours || 24);
    enabledInput.checked = job.enabled !== false;
    const o = job.options || {};
    roundsSelect.value = String(o.rounds || 10);
    concurrencySelect.value = String(o.concurrency || 1);
    packageLevelSelect.value = o.packageLevel || "standard";
    promptPresetSelect.value = o.promptPresetId || "custom";
    applyPromptPreset();
    // 自定义（或历史无预设 id）时以存下的文案为准，覆盖 applyPromptPreset 对 custom 的“不填”。
    if (promptPresetSelect.value === "custom" && typeof o.prompt === "string") promptInput.value = o.prompt;
    syncKindOptions();
    populateScenarioOptions(job.scenarioIds || []);
    cascade.setValue(job.targetId, { silent: true });
    formTitle.textContent = `编辑作业：${job.name || job.id}`;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function toggleEnabled(job) {
    try {
      await api("/api/auto-test-jobs", {
        method: "POST",
        body: JSON.stringify({ ...job, enabled: !job.enabled }),
      });
      await loadJobs();
    } catch (error) {
      toast(`操作失败：${error.message}`, true);
    }
  }

  async function runNow(job) {
    try {
      const r = await api(`/api/auto-test-jobs/${encodeURIComponent(job.id)}/run`, { method: "POST" });
      toast(r.ok ? "已触发一次运行，测试在后台进行，稍后刷新查看结果。" : r.message || "无法运行。", !r.ok);
      if (r.ok) setTimeout(loadJobs, 1500);
    } catch (error) {
      toast(`运行失败：${error.message}`, true);
    }
  }

  async function deleteJob(job) {
    const ok = await confirm?.({
      title: "删除自动测试作业",
      message: `确定删除作业「${job.name || job.id}」吗？`,
      detail: "删除后不再自动运行；已生成的报告不受影响。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`/api/auto-test-jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
      toast("作业已删除。");
      await loadJobs();
    } catch (error) {
      toast(`删除失败：${error.message}`, true);
    }
  }

  // 巡检报告：不传 profileId → 跨全部作业的汇总；传 profileId → 单个模型单独出报告。
  // trigger 为触发按钮（作业卡片的「出报告」传自己，好显示「生成中…」并禁用）。
  async function generateDigest({ profileId = null, trigger = null } = {}) {
    const windowHours = Number(digestWindow.value) || 168;
    const btn = trigger || digestGenerate;
    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "生成中…";
    try {
      const r = await api("/api/reports/auto-test-digest", {
        method: "POST",
        body: JSON.stringify({ windowHours, ...(profileId ? { profileId } : {}) }),
      });
      renderDigestResult(r);
      openReportOverlay(r.reportId, { title: "自动测试巡检报告" });
      toast("巡检报告已生成。");
    } catch (error) {
      toast(`生成失败：${error.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }

  function renderDigestResult({ reportId, markdown, summary, profileId }) {
    const s = summary || {};
    digestResult.innerHTML = `
      <div class="panel" style="margin-top:12px">
        <div class="action-row" style="justify-content:flex-start">
          <button type="button" class="secondary" data-atd-view>查看报告</button>
          <button type="button" class="secondary" data-atd-download>下载 Markdown</button>
        </div>
        <p class="field-hint" style="margin-top:10px">
          ${profileId ? "单模型报告：" : "汇总报告："}覆盖作业 ${s.jobs ?? 0} 个 · 模型 ${s.targets ?? 0} 个 · 回归告警 ${s.regressions ?? 0} 条 · 高危 ${s.highRisk ?? 0} 条。
        </p>
      </div>`;
    digestResult.querySelector("[data-atd-view]").addEventListener("click", () => openReportOverlay(reportId, { title: "自动测试巡检报告" }));
    digestResult.querySelector("[data-atd-download]").addEventListener("click", () => downloadText(`${reportId}.md`, markdown));
  }

  digestGenerate.addEventListener("click", () => generateDigest());

  function jobCard(job) {
    const card = document.createElement("div");
    card.className = "atc-job-card";
    const statusText = job.lastStatus ? STATUS_LABEL[job.lastStatus] || job.lastStatus : "尚未运行";
    const reportLink =
      job.lastReportId && job.lastStatus === "success"
        ? `<a href="/api/reports/${encodeURIComponent(job.lastReportId)}/view" target="_blank" rel="noopener">查看报告</a>`
        : "";
    const errNote = job.lastStatus === "failed" && job.lastError ? ` — ${escapeHtml(job.lastError)}` : "";
    const targetWarn = job.targetRunnable === false ? ` <span class="pill danger">目标不可用</span>` : "";
    card.innerHTML = `
      <div class="atc-job-head">
        <b>${escapeHtml(job.name || KIND_LABEL[job.kind] || job.kind)}</b>
        <span class="pill">${escapeHtml(KIND_LABEL[job.kind] || job.kind)}</span>
        <span class="pill">每 ${Number(job.periodHours)} 小时</span>
        <span class="pill ${job.enabled ? "" : "muted"}">${job.enabled ? "已启用" : "已停用"}</span>${targetWarn}
      </div>
      <div class="atc-job-meta">
        目标：${escapeHtml(job.targetName || job.targetId)}<br>
        上次运行：${fmtTime(job.lastRunAt)}（${escapeHtml(statusText)}${errNote}）${reportLink ? " " + reportLink : ""}<br>
        下次运行：${job.enabled ? fmtTime(job.nextRunAt) : "—"}
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
      mkBtn("立即运行", "secondary", () => runNow(job)),
      mkBtn("出报告", "secondary", (event) => generateDigest({ profileId: job.targetId, trigger: event.currentTarget })),
      mkBtn(job.enabled ? "停用" : "启用", "secondary", () => toggleEnabled(job)),
      mkBtn("编辑", "secondary", () => editJob(job)),
      mkBtn("删除", "danger", () => deleteJob(job)),
    );
    return card;
  }

  async function loadJobs() {
    listBox.textContent = "正在加载…";
    try {
      const r = await api("/api/auto-test-jobs");
      const jobs = Array.isArray(r.jobs) ? r.jobs : [];
      listBox.innerHTML = "";
      if (!jobs.length) {
        listBox.innerHTML = `<div class="muted">还没有配置任何自动测试作业。</div>`;
        return;
      }
      for (const job of jobs) listBox.append(jobCard(job));
    } catch (error) {
      listBox.textContent = `加载作业失败：${error.message}`;
    }
  }

  // 进入页面时加载：刷新级联目标 + 场景勾选项 + 作业列表。
  async function load() {
    cascade.refresh({ modelTargets: state.modelTargets, channels: state.channels, profiles: state.profiles });
    populateScenarioOptions(selectedScenarioIds());
    syncKindOptions();
    await loadJobs();
  }

  // 供 renderProfileOptions 在渠道/模型数据变化时刷新级联。
  function refreshTargets(data) {
    cascade.refresh(data);
  }

  return { load, refreshTargets };
}
