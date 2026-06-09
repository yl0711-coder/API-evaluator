import {
  downloadText,
  escapeHtml,
  renderMarkdown,
  toast,
} from "./client-utils.js";
import { renderAdmissionResult } from "./admission-view.js";
import { installClientErrorReporter } from "./client-error-reporter.js";
import { copyText } from "./clipboard.js";
import { api, cancelRemoteTask } from "./api-client.js";
import { applyRoleVisibility, ensureAuthenticated, wireUnauthorizedRedirect } from "./auth-gate.js";
import { createConfirmDialog } from "./confirm-dialog.js";
import {
  confirmExecution,
  estimateAdmissionBatchCost,
  estimateAdmissionCost,
  estimateStandardCost,
  estimateBatchCost,
  estimateScenarioCost,
  estimateStabilityCost,
} from "./cost-estimates.js";
import { renderDeliveryPanels } from "./delivery-panel.js";
import {
  formatBatchResult,
  formatBatchAdmissionResult,
  formatClientLogAnalysisResult,
  formatSupplierEvidenceResult,
  formatScenarioResult,
  formatStabilityResult,
} from "./formatters.js";
import { renderRequestList, renderTaskEventList, renderTestRunList } from "./history-view.js";
import { buildWorkflowStatus, getNextWorkflowStep, renderNextActionHtml } from "./workflow-guide.js";
import { buildDemoData } from "./demo-data.js";
import { requireElement, requireElements } from "./dom-utils.js";
import { createKeyModal } from "./key-modal.js";
import { renderPageHelp as renderPageHelpPanel } from "./page-help.js";
import { renderProfileConfigCheck as renderProfileConfigCheckPanel } from "./profile-config-check.js";
import { renderMissingKeyPanel, renderProfileList, renderProfileSelectOptions } from "./profile-view.js";
import {
  applyPromptPresetToForm,
  renderPromptPresetOptions,
} from "./prompt-presets.js";
import { createProfileController } from "./profile-controller.js";
import { createQuickTestController } from "./quick-test-controller.js";
import { createQuickFailurePanel } from "./quick-failure-panel.js";
import { createStandardEvalController } from "./standard-eval-controller.js";
import { renderStabilitySummary as renderStabilitySummaryPanel } from "./stability-view.js";
import { updateEstimateLabels } from "./test-estimates.js";
import { createTaskFormController, requireSelectedValues } from "./test-form-controller.js";
import {
  applyBatchTemplate as applyBatchTemplateToForm,
  applyProfileTemplate as applyProfileTemplateToForm,
  applyScenarioTemplate as applyScenarioTemplateToForm,
  applyStabilityTemplate as applyStabilityTemplateToForm,
} from "./test-templates.js";
import {
  hydrateProjectInfoForm as hydrateProjectInfoFormFields,
  loadProjectInfo,
  saveProjectInfo,
} from "./project-info.js";

installClientErrorReporter();

const state = {
  profiles: [],
  requests: [],
  testRuns: [],
  taskEvents: [],
  scenarios: [],
  manualLoaded: false,
  latestReportCopies: {
    stability: "",
    scenario: "",
  },
  activeTasks: {},
  projectInfo: loadProjectInfo(),
  latestStandardProfileId: "",
  demoMode: false,
  health: null,
};

const pages = requireElements(".page");
const navButtons = requireElements(".nav-button");
const projectInfoForm = requireElement("#project-info-form");
const projectInfoSummary = requireElement("#project-info-summary");
const profileForm = requireElement("#profile-form");
const profileList = requireElement("#profile-list");
const profileTemplate = requireElement("#profile-template");
const profileCheckResult = requireElement("#profile-check-result");
const quickTestForm = requireElement("#quick-test-form");
const quickProfileSelect = requireElement("#quick-profile-select");
const quickTestResult = requireElement("#quick-test-result");
const quickVerifyProfileSelect = requireElement("#quickverify-profile-select");
const quickVerifySubmit = requireElement("#quickverify-submit");
const quickVerifyResult = requireElement("#quickverify-result");
const trendProfileSelect = requireElement("#trend-profile-select");
const trendChart = requireElement("#trend-chart");
const trendRegression = requireElement("#trend-regression");
const trendTable = requireElement("#trend-table");
const trendAlerts = requireElement("#trend-alerts");
const quickPromptPreset = requireElement("#quick-prompt-preset");
const quickPromptHint = requireElement("#quick-prompt-hint");
const requestList = requireElement("#request-list");
const standardEvalForm = requireElement("#standard-eval-form");
const standardProfileSelect = requireElement("#standard-profile-select");
const standardPromptPreset = requireElement("#standard-prompt-preset");
const standardPromptHint = requireElement("#standard-prompt-hint");
const standardEvalSubmit = requireElement("#standard-eval-submit");
const standardPlainResult = requireElement("#standard-plain-result");
const standardEvalResult = requireElement("#standard-eval-result");
const standardNextActions = requireElement("#standard-next-actions");
const standardEvalProgress = requireElement("#standard-eval-progress");
const standardTaskProgress = requireElement("#standard-task-progress");
const admissionTestForm = requireElement("#admission-test-form");
const admissionProfileSelect = requireElement("#admission-profile-select");
const admissionSubmit = requireElement("#admission-submit");
const admissionEstimate = requireElement("#admission-estimate");
const admissionResult = requireElement("#admission-result");
const admissionBatchForm = requireElement("#admission-batch-form");
const admissionBatchProfileSelect = requireElement("#admission-batch-profile-select");
const admissionBatchSubmit = requireElement("#admission-batch-submit");
const admissionBatchEstimate = requireElement("#admission-batch-estimate");
const admissionBatchProgress = requireElement("#admission-batch-progress");
const admissionBatchResult = requireElement("#admission-batch-result");
const stabilityTestForm = requireElement("#stability-test-form");
const stabilityProfileSelect = requireElement("#stability-profile-select");
const stabilitySubmit = requireElement("#stability-submit");
const stabilitySummary = requireElement("#stability-summary");
const stabilityReport = requireElement("#stability-report");
const batchTestForm = requireElement("#batch-test-form");
const batchProfileSelect = requireElement("#batch-profile-select");
const batchSubmit = requireElement("#batch-submit");
const batchTestResult = requireElement("#batch-test-result");
const scenarioTestForm = requireElement("#scenario-test-form");
const scenarioProfileSelect = requireElement("#scenario-profile-select");
const scenarioCaseSelect = requireElement("#scenario-case-select");
const scenarioSubmit = requireElement("#scenario-submit");
const scenarioTestResult = requireElement("#scenario-test-result");
const testRunList = requireElement("#test-run-list");
const clientLogForm = requireElement("#client-log-form");
const clientLogSubmit = requireElement("#client-log-submit");
const clientEvidenceSubmit = requireElement("#client-evidence-submit");
const clientLogDirectoryImport = requireElement("#client-log-directory-import");
const clientLogResult = requireElement("#client-log-result");
const clientLogFile = requireElement("#client-log-file");
const clientReplayForm = requireElement("#client-replay-form");
const clientReplayProfileSelect = requireElement("#client-replay-profile-select");
const clientReplaySubmit = requireElement("#client-replay-submit");
const clientReplayResult = requireElement("#client-replay-result");
const clientReplayExtract = requireElement("#client-replay-extract");
const clientReplayBatch = requireElement("#client-replay-batch");
const taskEventList = requireElement("#task-event-list");
const stabilityTemplate = requireElement("#stability-template");
const batchTemplate = requireElement("#batch-template");
const stabilityPromptPreset = requireElement("#stability-prompt-preset");
const stabilityPromptHint = requireElement("#stability-prompt-hint");
const batchPromptPreset = requireElement("#batch-prompt-preset");
const batchPromptHint = requireElement("#batch-prompt-hint");
const scenarioTemplate = requireElement("#scenario-template");
const scenarioTemplateHint = requireElement("#scenario-template-hint");
const stabilityEstimate = requireElement("#stability-estimate");
const batchEstimate = requireElement("#batch-estimate");
const scenarioEstimate = requireElement("#scenario-estimate");
const stabilityProgress = requireElement("#stability-progress");
const batchProgress = requireElement("#batch-progress");
const scenarioProgress = requireElement("#scenario-progress");
const reportInsights = requireElement("#report-insights");
const plainConclusion = requireElement("#plain-conclusion");
const rankingList = requireElement("#ranking-list");
const modelComparisonList = requireElement("#model-comparison-list");
const handoffSummary = requireElement("#handoff-summary");
const handoffTemplate = requireElement("#handoff-template");
const pageHelpContent = requireElement("#page-help-content");
const manualContent = requireElement("#manual-content");
const dashboardEmpty = requireElement("#dashboard-empty");
const dashboardPopulated = requireElement("#dashboard-populated");
const statChannels = requireElement("#stat-channels");
const statChannelsChips = requireElement("#stat-channels-chips");
const statChannelsBars = requireElement("#stat-channels-bars");
const statVerdicts = requireElement("#stat-verdicts");
const statVerdictsChips = requireElement("#stat-verdicts-chips");
const statTodos = requireElement("#stat-todos");
const statTodosChips = requireElement("#stat-todos-chips");
const dashboardRecent = requireElement("#dashboard-recent");
const nextAction = requireElement("#next-action");
const workflowSteps = requireElements(".workflow-step");
const editionBanner = requireElement("#edition-banner");
const demoModeBanner = requireElement("#demo-mode-banner");
const missingKeyGuide = requireElement("#missing-key-guide");
const quickFailureActions = requireElement("#quick-failure-actions");
const keyModal = requireElement("#key-modal");
const keyModalForm = requireElement("#key-modal-form");
const keyModalInput = requireElement("#key-modal-input");
const keyModalCancel = requireElement("#key-modal-cancel");
const confirmAction = createConfirmDialog({
  modal: requireElement("#confirm-modal"),
  titleElement: requireElement("#confirm-modal-title"),
  messageElement: requireElement("#confirm-modal-message"),
  confirmButton: requireElement("#confirm-modal-ok"),
  cancelButton: requireElement("#confirm-modal-cancel"),
});
const keyPrompt = createKeyModal({
  modal: keyModal,
  form: keyModalForm,
  input: keyModalInput,
  cancelButton: keyModalCancel,
});
const quickFailurePanel = createQuickFailurePanel({
  container: quickFailureActions,
  getDefaultProfileId: () => quickProfileSelect.value,
  updateProfileKey,
  retryQuickTest: () => quickTestForm.requestSubmit(),
  openProfiles: () => showPage("profiles"),
  openStandardEval: (profileId) => {
    if (profileId) standardProfileSelect.value = profileId;
    showPage("standard-eval");
  },
  openReports: () => showPage("reports"),
  openStabilitySmoke: (profileId) => {
    if (profileId) stabilityProfileSelect.value = profileId;
    stabilityTemplate.value = "smoke";
    applyStabilityTemplate();
    showPage("stability-test");
  },
});
const profileController = createProfileController({
  state,
  profileForm,
  profileTemplate,
  demoModeBanner,
  renderProfileConfigCheck,
  loadProfiles,
  loadRequests,
  quickProfileSelect,
  quickTestResult,
  quickFailurePanel,
  showPage,
  confirmAction,
});

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    showPage(button.dataset.page);
  });
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-go-page]");
  if (!button) return;
  showPage(button.dataset.goPage);
});

requireElement("#toggle-page-help").addEventListener("click", () => {
  pageHelpContent.classList.toggle("hidden");
});
requireElement("#load-demo-data").addEventListener("click", enableDemoMode);
requireElement("#exit-demo-mode").addEventListener("click", disableDemoMode);
requireElement("#reload-profiles").addEventListener("click", loadProfiles);
requireElement("#reload-requests").addEventListener("click", async () => {
  await loadResultsBundle();
});
requireElement("#copy-stability-report").addEventListener("click", () => copyReportText("stability"));
requireElement("#copy-scenario-report").addEventListener("click", () => copyReportText("scenario"));
requireElement("#copy-handoff-template").addEventListener("click", copyHandoffTemplate);
requireElement("#refresh-handoff-template").addEventListener("click", renderDeliveryViews);
requireElement("#reload-manual").addEventListener("click", loadManual);
requireElement("#export-profiles").addEventListener("click", exportProfiles);
requireElement("#export-support-bundle").addEventListener("click", exportSupportBundle);
requireElement("#save-profile-only").addEventListener("click", saveProfileOnly);
requireElement("#import-profiles-button").addEventListener("click", () => {
  if (assertNotDemo("导入配置")) return;
  requireElement("#import-profiles-file").click();
});
requireElement("#import-profiles-file").addEventListener("change", profileController.importProfiles);
requireElement("#cancel-stability-task").addEventListener("click", () => cancelRemoteTask(state, "stability"));
requireElement("#cancel-batch-task").addEventListener("click", () => cancelRemoteTask(state, "batch"));
requireElement("#cancel-admission-batch-task").addEventListener("click", () => cancelRemoteTask(state, "admissionBatch"));
requireElement("#cancel-scenario-task").addEventListener("click", () => cancelRemoteTask(state, "scenario"));
requireElement("#cancel-standard-task").addEventListener("click", () => cancelRemoteTask(state, "standard"));
stabilityTemplate.addEventListener("change", applyStabilityTemplate);
batchTemplate.addEventListener("change", applyBatchTemplate);
quickPromptPreset.addEventListener("change", applyQuickPromptPreset);
standardPromptPreset.addEventListener("change", applyStandardPromptPreset);
stabilityPromptPreset.addEventListener("change", applyStabilityPromptPreset);
batchPromptPreset.addEventListener("change", applyBatchPromptPreset);
scenarioTemplate.addEventListener("change", applyScenarioTemplate);
profileTemplate.addEventListener("change", applyProfileTemplate);
clientLogForm.addEventListener("submit", analyzeClientLogs);
clientEvidenceSubmit.addEventListener("click", generateSupplierEvidence);
clientLogFile.addEventListener("change", importClientLogFile);
clientLogDirectoryImport.addEventListener("click", importClientLogDirectory);
clientReplayExtract.addEventListener("click", extractReplayRequestFromLogs);
clientReplayForm.addEventListener("submit", replayClientRequest);
clientReplayBatch.addEventListener("click", replayClientRequestsFromLogs);
// input 事件每敲一个字符就触发，updateEstimates/renderProfileConfigCheck 会重建
// 面板 innerHTML（闪烁、低端机输入延迟）。去抖 200ms，只在停止输入后渲染一次。
function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
const updateEstimatesDebounced = debounce(updateEstimates, 200);
const renderProfileConfigCheckDebounced = debounce(renderProfileConfigCheck, 200);
stabilityTestForm.addEventListener("input", updateEstimatesDebounced);
batchTestForm.addEventListener("input", updateEstimatesDebounced);
scenarioTestForm.addEventListener("input", updateEstimatesDebounced);
admissionTestForm.addEventListener("input", updateEstimatesDebounced);
admissionBatchForm.addEventListener("input", updateEstimatesDebounced);
profileForm.addEventListener("input", renderProfileConfigCheckDebounced);
admissionProfileSelect.addEventListener("change", updateEstimates);
admissionBatchProfileSelect.addEventListener("change", updateEstimates);
stabilityProfileSelect.addEventListener("change", updateEstimates);
batchProfileSelect.addEventListener("change", updateEstimates);
scenarioProfileSelect.addEventListener("change", updateEstimates);
scenarioCaseSelect.addEventListener("change", updateEstimates);
hydrateProjectInfoForm();
hydratePromptPresetSelects();
renderProfileConfigCheck();

projectInfoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.projectInfo = Object.fromEntries(new FormData(projectInfoForm).entries());
  saveProjectInfo(state.projectInfo);
  renderDeliveryViews();
  toast("本次测试信息已保存。");
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await profileController.saveAndTestProfile();
});

async function saveProfileOnly() {
  try {
    await profileController.saveProfileFromForm({ resetAfterSave: true });
    toast("API 配置已保存。");
  } catch (error) {
    toast(error.message, true);
  }
}

createQuickTestController({
  form: quickTestForm,
  resultElement: quickTestResult,
  quickFailurePanel,
  afterRequest: loadRequests,
});

function formatQuickVerify(result) {
  const verdict = result.verdict || {};
  const lines = [`判定：${verdict.title || "-"}`];
  for (const reason of verdict.reasons || []) lines.push(`  · ${reason}`);
  lines.push("");
  const identity = result.identityCheck;
  const identityText = identity
    ? identity.status === "aligned"
      ? `一致（${identity.reportedFamily}）`
      : identity.status === "conflict"
        ? `冲突（标称 ${identity.expectedFamily} / 自述 ${identity.reportedFamily}）`
        : identity.status
    : "未测";
  const fp = result.fingerprintSummary;
  lines.push(`真伪 / 标称：${identityText}；指纹探针 ${fp ? `${fp.passedCount}/${fp.totalCount}` : "-"}`);
  const abs = result.absoluteTokenAudit;
  const honesty = result.fingerprintTracking?.tokenHonesty;
  let tokenLine = "横向基线不足 / 无官方分词器，仅粗筛";
  if (abs?.applicable) tokenLine = abs.verdict;
  else if (honesty && honesty.status !== "insufficient_baseline") tokenLine = honesty.verdict;
  lines.push(`token 诚实度：${tokenLine}`);
  const ac = result.actualConsumption;
  if (ac) {
    const cost = ac.estimatedCost != null ? `约 $${ac.estimatedCost}` : "未配单价，仅统计 token";
    lines.push(`本次真实消耗：输入 ${ac.inputTokens ?? "-"} + 输出 ${ac.outputTokens ?? "-"} = ${ac.totalTokens ?? "-"} token（${cost}）`);
  }
  if (result.reportPath) lines.push(`报告：${result.reportPath}`);
  lines.push("");
  lines.push("注：黑盒概率判断，结论为「疑似 / 需上游解释」，不等于铁证。");
  return lines.join("\n");
}

function renderTrendChart(series) {
  const pts = (series || []).filter((p) => p.successRate !== null);
  if (pts.length < 1) return "暂无历史数据。";
  const W = 640;
  const H = 200;
  const pad = { l: 42, r: 16, t: 16, b: 24 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const n = pts.length;
  const px = (i) => pad.l + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const py = (sr) => pad.t + innerH * (1 - sr);
  const grid = [0, 0.5, 1]
    .map(
      (v) =>
        `<line x1="${pad.l}" y1="${py(v).toFixed(1)}" x2="${W - pad.r}" y2="${py(v).toFixed(1)}" stroke="#25334a"/>` +
        `<text x="${pad.l - 6}" y="${(py(v) + 4).toFixed(1)}" fill="#91a0b7" font-size="11" text-anchor="end">${v * 100}%</text>`,
    )
    .join("");
  const line = `<polyline points="${pts.map((p, i) => `${px(i).toFixed(1)},${py(p.successRate).toFixed(1)}`).join(" ")}" fill="none" stroke="#f6b56b" stroke-width="2"/>`;
  const dots = pts
    .map((p, i) => {
      const color = p.successRate >= 0.95 ? "#7bd88f" : p.successRate >= 0.8 ? "#f6b56b" : "#ff8a8a";
      const tip = `${String(p.at || "").replace("T", " ").slice(0, 19)} · ${Math.round(p.successRate * 100)}% · P95 ${p.p95Ms ?? "-"}ms${p.grade ? " · " + p.grade : ""}`;
      return `<circle cx="${px(i).toFixed(1)}" cy="${py(p.successRate).toFixed(1)}" r="3.5" fill="${color}"><title>${escapeHtml(tip)}</title></circle>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="成功率趋势">${grid}${line}${dots}</svg>`;
}

async function updateTrendView(profileId) {
  if (!profileId) return;
  trendChart.innerHTML = "加载中...";
  trendTable.textContent = "加载中...";
  trendAlerts.textContent = "加载中...";
  trendRegression.classList.add("hidden");
  try {
    const data = await api(`/api/trend?profileId=${encodeURIComponent(profileId)}`);
    const series = data.series || [];
    trendChart.innerHTML = renderTrendChart(series);
    const reg = data.regression;
    if (reg && reg.status === "regressed") {
      trendRegression.classList.remove("hidden");
      trendRegression.innerHTML = `<strong>⚠️ 疑似退化（${reg.severity}）</strong><br>${(reg.changes || []).map((c) => escapeHtml(c.detail)).join("<br>")}`;
    } else if (reg && reg.status === "stable") {
      trendRegression.classList.remove("hidden");
      trendRegression.textContent = "✅ 与基线一致，未见退化";
    }
    trendTable.textContent = series.length
      ? series
          .slice()
          .reverse()
          .map(
            (p) =>
              `${String(p.at || "").replace("T", " ").slice(0, 19)} | ${p.type} | 成功率 ${p.successRate != null ? Math.round(p.successRate * 100) + "%" : "-"} | P95 ${p.p95Ms ?? "-"}ms${p.grade ? " | " + p.grade : ""}${p.cost != null ? " | $" + p.cost : ""}`,
          )
          .join("\n")
      : "暂无历史。";
    const alerts = data.alerts || [];
    trendAlerts.textContent = alerts.length
      ? alerts.map((a) => `${String(a.created_at || "").replace("T", " ").slice(0, 19)} | ${a.severity} | ${a.summary}`).join("\n")
      : "暂无告警。";
  } catch (error) {
    trendChart.textContent = `加载失败：${error.message}`;
  }
}

trendProfileSelect.addEventListener("change", () => updateTrendView(trendProfileSelect.value));
document.querySelector('.nav-button[data-page="trend"]')?.addEventListener("click", () => updateTrendView(trendProfileSelect.value));

quickVerifySubmit.addEventListener("click", async () => {
  const profileId = quickVerifyProfileSelect.value;
  if (!profileId) {
    quickVerifyResult.textContent = "请先选择被测 API。";
    return;
  }
  quickVerifySubmit.disabled = true;
  quickVerifyResult.textContent = "快检中，请稍候...";
  try {
    const result = await api("/api/tests/quick-verify", {
      method: "POST",
      body: JSON.stringify({ profileId }),
    });
    quickVerifyResult.textContent = formatQuickVerify(result);
    await loadRequests();
  } catch (error) {
    quickVerifyResult.textContent = `快检失败：${error.message}`;
  } finally {
    quickVerifySubmit.disabled = false;
  }
});

createStandardEvalController({
  form: standardEvalForm,
  submitButton: standardEvalSubmit,
  plainResultElement: standardPlainResult,
  resultElement: standardEvalResult,
  nextActionsElement: standardNextActions,
  progressElement: standardEvalProgress,
  taskProgressElement: standardTaskProgress,
  state,
  estimateCost: estimateStandardCost,
  confirmRun: (title, estimate) => confirmAction(confirmExecution(title, estimate)),
  refreshResults: () => loadResultsBundle(),
  showPage,
  quickProfileSelect,
  stabilityProfileSelect,
  stabilityTemplate,
  applyStabilityTemplate,
  scenarioTemplate,
  applyScenarioTemplate,
  scenarioProfileSelect,
  updateEstimates,
});

admissionTestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(admissionTestForm).entries());
  payload.modelName = findProfileModelName(payload.profileId);
  const estimate = estimateAdmissionCost(payload);
  payload.predicted = estimate; // 跑前预测随 payload 记录，供报告对比
  const confirmed = await confirmAction(confirmExecution("模型准入评测", estimate));
  if (!confirmed) {
    return;
  }

  admissionSubmit.disabled = true;
  admissionSubmit.textContent = "准入评测中...";
  admissionResult.innerHTML = `<p class="muted">正在执行准入评测。请不要关闭窗口。</p>`;
  try {
    const result = await api("/api/tests/admission", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    admissionResult.innerHTML = renderAdmissionResult(result);
    await loadResultsBundle();
    toast("准入评测完成。");
  } catch (error) {
    admissionResult.innerHTML = `<p class="fail">准入评测失败：${escapeHtml(error.message)}</p>`;
    toast(error.message, true);
  } finally {
    admissionSubmit.disabled = false;
    admissionSubmit.textContent = "开始准入评测";
  }
});

createTaskFormController({
  form: admissionBatchForm,
  submitButton: admissionBatchSubmit,
  resultElement: admissionBatchResult,
  progressElement: admissionBatchProgress,
  state,
  slot: "admissionBatch",
  taskType: "batch-admission",
  confirmRun: (payload) => confirmAction(confirmExecution("批量准入对比", estimateAdmissionBatchCost(payload))),
  predict: (payload) => estimateAdmissionBatchCost(payload),
  preparePayload: (payload) => {
    const profileIds = requireSelectedValues(admissionBatchProfileSelect, "请至少选择一个被测 API。");
    return profileIds ? { ...payload, profileIds } : null;
  },
  beforeStart: (payload) => {
    admissionBatchResult.textContent = `正在对 ${payload.profileIds.length} 个 API 执行准入评测。请不要关闭窗口。`;
  },
  onSuccess: async (result) => {
    const copyableSummary = getCopyableReportText(result, formatBatchAdmissionResult(result));
    admissionBatchResult.textContent = copyableSummary;
    await loadResultsBundle();
    toast("批量准入对比完成。");
  },
  failurePrefix: "批量准入对比失败",
  idleButtonText: "开始批量准入对比",
});

createTaskFormController({
  form: stabilityTestForm,
  submitButton: stabilitySubmit,
  resultElement: stabilitySummary,
  progressElement: stabilityProgress,
  state,
  slot: "stability",
  taskType: "stability",
  confirmRun: (payload) => confirmAction(confirmExecution("稳定性测试", estimateStabilityCost(payload))),
  predict: (payload) => estimateStabilityCost(payload),
  preparePayload: (payload) => payload,
  beforeStart: (payload) => {
    stabilitySummary.innerHTML = `<p class="muted">正在进行 ${payload.rounds} 轮测试。请不要关闭窗口。</p>`;
    stabilityReport.textContent = "测试完成后会自动生成报告。";
    state.latestReportCopies.stability = "";
  },
  onSuccess: async (result) => {
    const copyableSummary = getCopyableReportText(result, formatStabilityResult(result));
    state.latestReportCopies.stability = copyableSummary;
    renderStabilitySummary(result);
    stabilityReport.textContent = copyableSummary;
    await loadResultsBundle();
    toast("稳定性测试完成。");
  },
  failurePrefix: "稳定性测试失败",
  idleButtonText: "开始稳定性测试",
});

createTaskFormController({
  form: batchTestForm,
  submitButton: batchSubmit,
  resultElement: batchTestResult,
  progressElement: batchProgress,
  state,
  slot: "batch",
  taskType: "batch-stability",
  confirmRun: (payload) => confirmAction(confirmExecution("批量并发测试", estimateBatchCost(payload))),
  predict: (payload) => estimateBatchCost(payload),
  preparePayload: (payload) => {
    const profileIds = requireSelectedValues(batchProfileSelect, "请至少选择一个被测 API。");
    return profileIds ? { ...payload, profileIds } : null;
  },
  beforeStart: (payload) => {
    batchTestResult.textContent = `正在测试 ${payload.profileIds.length} 个 API。测试期间可以等待，不要关闭窗口。`;
  },
  onSuccess: async (result) => {
    const copyableSummary = getCopyableReportText(result, formatBatchResult(result));
    batchTestResult.textContent = copyableSummary;
    await loadResultsBundle();
    toast("批量测试完成。");
  },
  failurePrefix: "批量测试失败",
  idleButtonText: "开始批量测试",
});

createTaskFormController({
  form: scenarioTestForm,
  submitButton: scenarioSubmit,
  resultElement: scenarioTestResult,
  progressElement: scenarioProgress,
  state,
  slot: "scenario",
  taskType: "scenario",
  confirmRun: (payload) => confirmAction(confirmExecution("复杂场景测试", estimateScenarioCost(payload, state.scenarios))),
  predict: (payload) => estimateScenarioCost(payload, state.scenarios),
  preparePayload: (payload) => {
    const profileIds = requireSelectedValues(scenarioProfileSelect, "请至少选择一个被测 API。");
    if (!profileIds) return null;
    const scenarioIds = requireSelectedValues(scenarioCaseSelect, "请至少选择一个测试场景。");
    return scenarioIds ? { ...payload, profileIds, scenarioIds } : null;
  },
  beforeStart: (payload) => {
    scenarioTestResult.textContent = `正在测试 ${payload.profileIds.length} 个 API、${payload.scenarioIds.length} 个场景。复杂场景耗时较长，请等待。`;
    state.latestReportCopies.scenario = "";
  },
  onSuccess: async (result) => {
    const copyableSummary = getCopyableReportText(result, formatScenarioResult(result));
    state.latestReportCopies.scenario = copyableSummary;
    scenarioTestResult.textContent = copyableSummary;
    await loadResultsBundle();
    toast("场景测试完成。");
  },
  failurePrefix: "场景测试失败",
  idleButtonText: "开始场景测试",
});

async function analyzeClientLogs(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(clientLogForm).entries());
  if (!String(payload.logText || "").trim()) {
    toast("请先粘贴需要分析的客户端日志。", true);
    return;
  }
  clientLogSubmit.disabled = true;
  clientLogSubmit.textContent = "正在生成报告...";
  clientLogResult.textContent = "正在解析日志并生成报告。";
  try {
    const result = await api("/api/client-logs/analyze", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    clientLogResult.textContent = formatClientLogAnalysisResult(result);
    await loadTestRuns();
    renderDeliveryViews();
    toast("客户端日志分析报告已生成。");
  } catch (error) {
    clientLogResult.textContent = `客户端日志分析失败：${error.message}`;
    toast(error.message, true);
  } finally {
    clientLogSubmit.disabled = false;
    clientLogSubmit.textContent = "生成客户端日志分析报告";
  }
}

async function generateSupplierEvidence() {
  const payload = Object.fromEntries(new FormData(clientLogForm).entries());
  if (!String(payload.logText || "").trim()) {
    toast("请先粘贴需要整理的客户端日志。", true);
    return;
  }
  clientEvidenceSubmit.disabled = true;
  clientEvidenceSubmit.textContent = "正在生成证据包...";
  clientLogResult.textContent = "正在整理给上游排查使用的脱敏证据包。";
  try {
    const result = await api("/api/client-logs/supplier-evidence", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    clientLogResult.textContent = formatSupplierEvidenceResult(result);
    await loadTestRuns();
    renderDeliveryViews();
    toast("上游排查证据包已生成。");
  } catch (error) {
    clientLogResult.textContent = `生成上游排查证据包失败：${error.message}`;
    toast(error.message, true);
  } finally {
    clientEvidenceSubmit.disabled = false;
    clientEvidenceSubmit.textContent = "生成上游排查证据包";
  }
}

async function importClientLogFile() {
  const file = clientLogFile.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    clientLogForm.elements.sourceName.value ||= file.name;
    clientLogForm.elements.logText.value = text;
    clientLogResult.textContent = `已导入 ${file.name}，大小 ${Math.round(file.size / 1024)} KB。确认内容后点击“生成客户端日志分析报告”。`;
  } catch (error) {
    clientLogResult.textContent = `读取日志文件失败：${error.message}`;
    toast("读取日志文件失败。", true);
  }
}

async function importClientLogDirectory() {
  const directoryPath = String(clientLogForm.elements.directoryPath.value || "").trim();
  if (!directoryPath) {
    toast("请先填写本机日志目录路径。", true);
    return;
  }
  clientLogDirectoryImport.disabled = true;
  clientLogDirectoryImport.textContent = "正在读取目录...";
  clientLogResult.textContent = "正在读取本机日志目录。";
  try {
    const result = await api("/api/client-logs/import-directory", {
      method: "POST",
      body: JSON.stringify({
        directoryPath,
        maxFiles: 30,
      }),
    });
    clientLogForm.elements.sourceName.value ||= result.sourceName || "客户端日志目录";
    clientLogForm.elements.logText.value = result.logText || "";
    clientLogResult.textContent = [
      `已读取目录：${result.directoryPath || directoryPath}`,
      `文件数量：${result.fileCount}`,
      `读取大小：${Math.round((result.totalBytes || 0) / 1024)} KB`,
      result.truncated ? "提示：部分文件或内容已按安全上限截断。" : "提示：目录内容已读取完成。",
      "确认日志内容后，可以生成分析报告或上游排查证据包。",
    ].join("\n");
    toast("日志目录读取完成。");
  } catch (error) {
    clientLogResult.textContent = `读取日志目录失败：${error.message}`;
    toast(error.message, true);
  } finally {
    clientLogDirectoryImport.disabled = false;
    clientLogDirectoryImport.textContent = "从本机目录读取日志";
  }
}

async function extractReplayRequestFromLogs() {
  const logText = String(clientLogForm.elements.logText.value || "").trim();
  if (!logText) {
    toast("请先粘贴或导入客户端日志。", true);
    return;
  }
  clientReplayExtract.disabled = true;
  clientReplayExtract.textContent = "正在提取...";
  try {
    const result = await api("/api/client-logs/replay-candidates", {
      method: "POST",
      body: JSON.stringify({
        sourceName: clientLogForm.elements.sourceName.value,
        logText,
      }),
    });
    const candidate = result.candidates?.[0];
    if (!candidate) {
      clientReplayResult.textContent = "没有找到可回放请求。请确认日志里包含 request.body 或 body 字段。";
      toast("没有找到可回放请求。", true);
      return;
    }
    clientReplayForm.elements.requestJson.value = candidate.requestJson;
    clientReplayForm.elements.sourceName.value ||= `${candidate.client || "客户端"} ${candidate.model || ""} 请求回放`.trim();
    clientReplayResult.textContent = [
      "已提取第一条可回放请求。",
      `Request ID：${candidate.requestId || "-"}`,
      `客户端：${candidate.client || "-"}`,
      `模型：${candidate.model || "-"}`,
      `路径：${candidate.path || "-"}`,
      `候选数量：${result.count}`,
      "请确认请求内容和成本后，再点击“回放这条请求”。",
    ].join("\n");
    toast("已提取可回放请求。");
  } catch (error) {
    clientReplayResult.textContent = `提取可回放请求失败：${error.message}`;
    toast(error.message, true);
  } finally {
    clientReplayExtract.disabled = false;
    clientReplayExtract.textContent = "从上方日志提取第一条可回放请求";
  }
}

async function replayClientRequest(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(clientReplayForm).entries());
  if (!payload.profileId) {
    toast("请先选择回放使用的 API。", true);
    return;
  }
  if (!String(payload.requestJson || "").trim()) {
    toast("请先粘贴单条请求 JSON。", true);
    return;
  }
  const confirmed = await confirmAction({
    title: "确认回放真实客户端请求",
    message: "这会真实调用所选 API，并消耗对应额度。请确认请求内容已经脱敏，且成本可接受。",
    confirmLabel: "确认回放",
    cancelLabel: "取消",
  });
  if (!confirmed) return;

  clientReplaySubmit.disabled = true;
  clientReplaySubmit.textContent = "正在回放...";
  clientReplayResult.textContent = "正在请求 API 并生成回放报告。";
  try {
    const result = await api("/api/client-logs/replay", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    clientReplayResult.textContent = formatClientLogAnalysisResult(result);
    await loadTestRuns();
    renderDeliveryViews();
    toast("真实客户端请求回放完成。");
  } catch (error) {
    clientReplayResult.textContent = `请求回放失败：${error.message}`;
    toast(error.message, true);
  } finally {
    clientReplaySubmit.disabled = false;
    clientReplaySubmit.textContent = "回放这条请求";
  }
}

async function replayClientRequestsFromLogs() {
  const payload = Object.fromEntries(new FormData(clientReplayForm).entries());
  const logText = String(clientLogForm.elements.logText.value || "").trim();
  if (!payload.profileId) {
    toast("请先选择回放使用的 API。", true);
    return;
  }
  if (!logText) {
    toast("请先在上方粘贴、导入或读取客户端日志。", true);
    return;
  }
  const maxReplayCount = Math.min(10, Math.max(1, Number.parseInt(String(payload.maxReplayCount || "3"), 10) || 3));
  const confirmed = await confirmAction({
    title: "确认批量回放真实客户端请求",
    message: `这会从上方日志中提取候选请求，并最多真实回放 ${maxReplayCount} 条，会消耗对应额度。建议只用于复现 524、504、Content block not found 等关键问题。`,
    confirmLabel: "确认批量回放",
    cancelLabel: "取消",
  });
  if (!confirmed) return;

  clientReplayBatch.disabled = true;
  clientReplayBatch.textContent = "正在批量回放...";
  clientReplayResult.textContent = "正在提取候选请求并按上限批量回放。";
  try {
    const result = await api("/api/client-logs/replay-batch", {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        sourceName: payload.sourceName || clientLogForm.elements.sourceName.value || "批量真实客户端请求回放",
        logText,
        maxReplayCount,
      }),
    });
    clientReplayResult.textContent = [
      formatClientLogAnalysisResult(result),
      "",
      `候选请求数：${result.replayCandidateCount ?? "-"}`,
      `实际回放数：${result.replayedCount ?? "-"}`,
      `回放上限：${result.replayLimit ?? maxReplayCount}`,
    ].join("\n");
    await loadTestRuns();
    renderDeliveryViews();
    toast("批量真实客户端请求回放完成。");
  } catch (error) {
    clientReplayResult.textContent = `批量请求回放失败：${error.message}`;
    toast(error.message, true);
  } finally {
    clientReplayBatch.disabled = false;
    clientReplayBatch.textContent = "批量回放上方日志候选请求";
  }
}

// 进入主界面前先确保已登录（未登录显示登录闸门并阻塞）
const authUser = await ensureAuthenticated();
applyRoleVisibility(authUser);
wireUnauthorizedRedirect();

try {
  await Promise.all([loadHealth(), loadProfiles(), loadScenarios(), loadRequests(), loadTestRuns(), loadTaskEvents()]);
  renderPageHelp("dashboard");
} catch (error) {
  // 首屏任一加载失败（后端慢启动/异常）会让顶层 await 抛出、整页白屏。
  // 给非技术用户一个可读的兜底，而不是空白。
  renderStartupError(error);
}

function renderStartupError(error) {
  const main = document.querySelector(".main");
  if (!main) return;
  const box = document.createElement("section");
  box.className = "panel startup-error";
  const title = document.createElement("strong");
  title.textContent = "连接本地服务失败";
  const tip = document.createElement("p");
  tip.textContent = "请完全退出本工具后重新打开一次。如果反复出现，把这条提示发给负责人。";
  const detail = document.createElement("p");
  detail.className = "muted";
  detail.textContent = error?.message ? String(error.message) : String(error);
  box.append(title, tip, detail);
  main.prepend(box);
}

function showPage(page) {
  navButtons.forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  pages.forEach((item) => item.classList.toggle("active", item.id === page));
  renderPageHelp(page);
  if (page === "manual" && !state.manualLoaded) {
    loadManual();
  }
}

async function loadProfiles() {
  if (state.demoMode) {
    renderProfiles();
    renderProfileOptions();
    renderDashboard();
    updateEstimates();
    return;
  }
  state.profiles = await api("/api/profiles");
  renderProfiles();
  renderProfileOptions();
  renderDashboard();
  updateEstimates();
}

async function loadScenarios() {
  state.scenarios = await api("/api/scenarios");
  renderScenarioOptions();
  applyScenarioTemplate();
  updateEstimates();
}

async function loadHealth() {
  state.health = await api("/api/health");
  renderEditionBanner();
}

function renderEditionBanner() {
  const safetyEnabled = Boolean(state.health?.safetyScenariosEnabled);
  editionBanner.classList.toggle("hidden", !safetyEnabled);
  editionBanner.innerHTML = safetyEnabled
    ? `<strong>内部风控版</strong>已启用内容安全合规测试。请只由负责人或受训测试人员使用。`
    : "";
}

function loadManual() {
  const guide = [
    "## 使用说明",
    "",
    "本平台用于评测接入的上游渠道模型，推荐流程：",
    "",
    "1. **API 配置**：填渠道的 Base URL、Key、协议、模型（Key 加密保存，不回显）。",
    "2. **一键快检**（快速测试页）：少量探针快速看渠道真伪、token 是否虚报、本次真实消耗。",
    "3. **准入评测**：给渠道打 A–F 分级，判断是否值得进一步测试。",
    "4. **稳定性测试**：多轮 + 统计置信区间，评估可用性；多渠道可批量横向对比。",
    "5. **稳定性趋势**：同一渠道历次测试的成功率曲线 + 掉级回归告警。",
    "6. **报告中心 / 测试交付**：查看与导出报告。",
    "",
    "每个页面右上角都有「怎么用」帮助；更完整的部署与配置说明见项目 README。",
  ].join("\n");
  manualContent.innerHTML = renderMarkdown(guide);
  state.manualLoaded = true;
}

async function loadRequests() {
  if (state.demoMode) {
    renderRequests();
    renderDashboard();
    renderDeliveryViews();
    return;
  }
  state.requests = await api("/api/requests/recent");
  renderRequests();
  renderDashboard();
  renderDeliveryViews();
}

async function loadTestRuns() {
  if (state.demoMode) {
    renderTestRuns();
    renderDashboard();
    renderProfiles();
    renderDeliveryViews();
    return;
  }
  state.testRuns = await api("/api/test-runs/recent");
  renderTestRuns();
  renderDashboard();
  renderProfiles();
  renderDeliveryViews();
}

async function loadTaskEvents() {
  if (state.demoMode) {
    renderTaskEvents();
    renderDeliveryViews();
    return;
  }
  state.taskEvents = await api("/api/tasks/recent");
  renderTaskEvents();
  renderDeliveryViews();
}

// 结果三件套一起拉、只渲染一次。原来 Promise.all([loadRequests,loadTestRuns,
// loadTaskEvents]) 会触发 renderDeliveryViews ×3 / renderDashboard ×2，整页
// innerHTML 重建多次（抖动、丢滚动位置、打断正在复制的 <pre>）。
async function loadResultsBundle() {
  if (!state.demoMode) {
    const [requests, testRuns, taskEvents] = await Promise.all([
      api("/api/requests/recent"),
      api("/api/test-runs/recent"),
      api("/api/tasks/recent"),
    ]);
    state.requests = requests;
    state.testRuns = testRuns;
    state.taskEvents = taskEvents;
  }
  renderResultsViews();
}

function renderResultsViews() {
  renderRequests();
  renderTestRuns();
  renderTaskEvents();
  renderProfiles();
  renderDashboard();
  renderDeliveryViews();
}

function renderPageHelp(page) {
  renderPageHelpPanel(pageHelpContent, page);
}

function enableDemoMode() {
  const demoData = buildDemoData();
  state.demoMode = true;
  state.profiles = demoData.profiles.map((item) => ({ ...item }));
  state.requests = demoData.requests.map((item) => ({ ...item }));
  state.testRuns = demoData.testRuns.map((item) => ({ ...item }));
  state.taskEvents = demoData.taskEvents.map((item) => ({ ...item }));
  demoModeBanner.classList.remove("hidden");
  renderProfiles();
  renderProfileOptions();
  renderRequests();
  renderTestRuns();
  renderTaskEvents();
  renderDashboard();
  renderDeliveryViews();
  showPage("reports");
  toast("已进入演示模式，不会发起真实请求。");
}

async function disableDemoMode() {
  state.demoMode = false;
  demoModeBanner.classList.add("hidden");
  await Promise.all([loadProfiles(), loadRequests(), loadTestRuns(), loadTaskEvents()]);
  showPage("dashboard");
  toast("已退出演示模式，恢复本机真实数据。");
}

// 演示模式下统一拦截所有写操作（删除/导出/导入/改 Key 等）。
// demo 数据 id 是假的，放行会打到后端，假 id 碰撞真实配置时可能误删，违背“不写本机”承诺。
// 被拦截返回 true（调用方据此 return）。
function assertNotDemo(actionLabel = "这个操作") {
  if (state.demoMode) {
    toast(`演示模式不能${actionLabel}。请退出演示模式后再操作。`, true);
    return true;
  }
  return false;
}

function renderDashboard() {
  const hasProfiles = state.profiles.length > 0;
  dashboardEmpty.classList.toggle("hidden", hasProfiles);
  dashboardPopulated.classList.toggle("hidden", !hasProfiles);
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
  const targets = state.profiles.filter((p) => p.role === "target");
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
  statChannels.innerHTML = `${targets.length} <em>个渠道</em>`;
  // 健康占比条：按 正常/观察/异常/未测 的数量做 flex 比例
  statChannelsBars.innerHTML = targets.length === 0
    ? `<i style="flex:1;background:var(--line)"></i>`
    : [
        good ? `<i style="flex:${good};background:var(--good)"></i>` : "",
        warn ? `<i style="flex:${warn};background:var(--accent)"></i>` : "",
        bad ? `<i style="flex:${bad};background:var(--bad)"></i>` : "",
        idle ? `<i style="flex:${idle};background:var(--muted)"></i>` : "",
      ].filter(Boolean).join("");
  statChannelsChips.innerHTML = targets.length === 0
    ? `<span class="chip muted-chip"><i style="background:var(--muted)"></i>暂无被测渠道</span>`
    : [
        good ? `<span class="chip good"><i></i>${good} 正常</span>` : "",
        warn ? `<span class="chip warn"><i></i>${warn} 需观察</span>` : "",
        bad ? `<span class="chip bad"><i></i>${bad} 异常</span>` : "",
        idle ? `<span class="chip idle muted-chip"><i></i>${idle} 未测</span>` : "",
      ].filter(Boolean).join("");

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
  statVerdicts.innerHTML = `${runs.length} <em>份报告</em>`;
  statVerdictsChips.innerHTML = runs.length === 0
    ? `<span class="chip muted-chip"><i style="background:var(--muted)"></i>还没有报告</span>`
    : `<span class="chip good"><i></i>推荐 ${pass}</span><span class="chip warn"><i></i>观察 ${watchN}</span><span class="chip bad"><i></i>不推荐 ${fail}</span>`;

  // 待办：疑似计费（PALACE tokenAuditFindings 含 high/medium）+ 待复测（最近为观察的渠道）
  let billing = 0;
  for (const run of runs) {
    const findings = run.tokenAuditFindings || [];
    if (findings.some((f) => f && (f.level === "high" || f.level === "medium"))) billing += 1;
  }
  const todoCount = warn + billing;
  statTodos.innerHTML = `${todoCount} <em>项</em>`;
  statTodosChips.innerHTML = todoCount === 0
    ? `<span class="chip muted-chip"><i style="background:var(--muted)"></i>暂无待办</span>`
    : [
        warn ? `<span class="chip blue"><i></i>${warn} 待复测</span>` : "",
        billing ? `<span class="chip bad"><i></i>${billing} 疑似计费异常</span>` : "",
      ].filter(Boolean).join("");
}

function renderDashboardRecent() {
  const runs = (state.testRuns || []).slice(0, 5);
  if (runs.length === 0) {
    dashboardRecent.innerHTML = `<p class="muted" style="padding:10px 12px">还没有测试报告。完成一次准入或标准评测后，这里会显示最近结论。</p>`;
    return;
  }
  dashboardRecent.innerHTML = runs.map((run) => {
    const v = dashVerdict(run);
    const pill = v
      ? `<span class="verdict-pill ${v.cls}">${v.label}</span>`
      : `<span class="verdict-pill idle">—</span>`;
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
  }).join("");
}

function renderWorkflowGuide() {
  const status = buildWorkflowStatus(state);
  const next = getNextWorkflowStep(status);

  nextAction.innerHTML = renderNextActionHtml(next);
  nextAction.querySelector("[data-go-page]").addEventListener("click", () => showPage(next.page));

  workflowSteps.forEach((step) => {
    const key = step.dataset.step;
    step.classList.toggle("done", Boolean(status[key]));
    step.classList.toggle("current", key === next.step);
  });
}

// 每个渠道的最近一次测试结论（profileId → {cls,label}），供配置页健康行用。
// 与首页"渠道健康"卡同源（state.testRuns 按 profile 取最近 verdict）。
function latestVerdictsByProfile() {
  const map = {};
  for (const run of state.testRuns || []) {
    const id = run.profileId;
    if (!id || map[id]) continue;
    const v = dashVerdict(run);
    if (v) map[id] = v;
  }
  return map;
}

function renderProfiles() {
  renderMissingKeyGuide();
  renderProfileList({
    profiles: state.profiles,
    list: profileList,
    verdicts: latestVerdictsByProfile(),
    onFocusForm: () => {
      profileForm.scrollIntoView({ behavior: "smooth", block: "start" });
      profileForm.elements.name.focus();
    },
    onDeleteProfile: async (profileId) => {
      if (assertNotDemo("删除配置")) return;
      const confirmed = await confirmAction({
        title: "删除这个 API 配置？",
        message: "删除后，这个配置不会再出现在测试列表里。",
        detail: "如果只是 Key 失效，建议优先更新 Key，不一定要删除配置。",
        confirmLabel: "确认删除",
        cancelLabel: "保留配置",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      await api(`/api/profiles/${encodeURIComponent(profileId)}`, {
        method: "DELETE",
      });
      await loadProfiles();
    },
    onUpdateKey: updateProfileKey,
    onEditProfile: fillProfileFormForEdit,
  });
}

// 把已有渠道载入表单做编辑（带 id → 保存时后端按 id 更新，不是新建）。
// Key 留空表示保留原 Key（脱敏数据本就没有明文 Key）。
function fillProfileFormForEdit(profileId) {
  if (assertNotDemo("编辑配置")) return;
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) return;
  const f = profileForm.elements;
  const set = (name, val) => {
    if (f[name] !== undefined && f[name] !== null) f[name].value = val ?? "";
  };
  set("id", profile.id);
  set("name", profile.name);
  set("provider", profile.provider);
  set("baseUrl", profile.baseUrl);
  set("defaultModel", profile.defaultModel);
  set("protocol", profile.protocol);
  set("role", profile.role);
  set("channelCode", profile.channelCode);
  set("maxTokens", profile.maxTokens);
  set("timeoutMs", profile.timeoutMs);
  set("inputPricePerMTokens", profile.inputPricePerMTokens);
  set("outputPricePerMTokens", profile.outputPricePerMTokens);
  set("inputSellPricePerMTokens", profile.inputSellPricePerMTokens);
  set("outputSellPricePerMTokens", profile.outputSellPricePerMTokens);
  set("notes", profile.notes);
  if (f.apiKey) f.apiKey.value = ""; // 留空 = 不修改 Key
  const advanced = profileForm.querySelector("details.advanced-settings");
  if (advanced) advanced.open = true; // 展开高级设置，方便改角色/单价
  renderProfileConfigCheck();
  profileForm.scrollIntoView({ behavior: "smooth", block: "start" });
  if (f.name) f.name.focus();
  toast(`正在编辑「${profile.name}」。改完点“保存”。Key 留空表示不修改。`);
}

function renderMissingKeyGuide() {
  renderMissingKeyPanel({
    profiles: state.profiles,
    container: missingKeyGuide,
    onFillKey: updateProfileKey,
  });
}

async function updateProfileKey(profileId) {
  if (assertNotDemo("保存 Key")) return;
  const apiKey = await keyPrompt.requestApiKey();
  if (!apiKey) {
    return;
  }
  await api(`/api/profiles/${encodeURIComponent(profileId)}/key`, {
    method: "POST",
    body: JSON.stringify({ apiKey }),
  });
  await loadProfiles();
  toast("Key 已更新。建议马上跑一次快速测试。");
}

function renderProfileOptions() {
  renderProfileSelectOptions({
    profiles: state.profiles,
    selects: [
      standardProfileSelect,
      admissionProfileSelect,
      admissionBatchProfileSelect,
      quickProfileSelect,
      quickVerifyProfileSelect,
      trendProfileSelect,
      stabilityProfileSelect,
      batchProfileSelect,
      scenarioProfileSelect,
      clientReplayProfileSelect,
    ],
  });
}

function renderScenarioOptions() {
  syncScenarioTemplateAvailability();
  if (state.scenarios.length === 0) {
    scenarioCaseSelect.innerHTML = `<option value="">暂无测试场景</option>`;
    return;
  }

  scenarioCaseSelect.innerHTML = state.scenarios
    .map(
      (scenario) =>
        `<option value="${scenario.id}" selected>${escapeHtml(scenario.name)} / ${escapeHtml(scenario.difficulty)}</option>`,
    )
    .join("");
}

function syncScenarioTemplateAvailability() {
  const hasSafetyScenarios = state.scenarios.some((scenario) => scenario.category === "safety");
  const safetyOption = scenarioTemplate.querySelector('option[value="scenario-safety"]');
  if (!safetyOption) return;
  safetyOption.hidden = !hasSafetyScenarios;
  safetyOption.disabled = !hasSafetyScenarios;
  if (!hasSafetyScenarios && scenarioTemplate.value === "scenario-safety") {
    scenarioTemplate.value = "scenario-basic";
  }
}

function renderRequests() {
  renderRequestList({ requests: state.requests, container: requestList });
}

function renderTestRuns() {
  renderTestRunList({ runs: state.testRuns, container: testRunList });
  renderDeliveryViews();
}

function renderTaskEvents() {
  renderTaskEventList({ tasks: state.taskEvents, container: taskEventList });
}

function renderDeliveryViews() {
  renderDeliveryPanels({
    state,
    plainConclusion,
    projectInfoSummary,
    reportInsights,
    rankingList,
    modelComparisonList,
    handoffSummary,
    handoffTemplate,
  });
}

function renderStabilitySummary(result) {
  renderStabilitySummaryPanel(stabilitySummary, result);
}

function renderProfileConfigCheck(validation = null) {
  renderProfileConfigCheckPanel({
    form: profileForm,
    container: profileCheckResult,
    validation,
  });
}

async function copyReportText(kind) {
  const text = state.latestReportCopies[kind] || "";
  if (!text) {
    toast("当前没有可复制的报告。", true);
    return;
  }

  await copyText(text);
  toast("摘要和报告路径已复制。");
}

function getCopyableReportText(result, fallbackText) {
  const markdown = String(result?.reportMarkdown || "");
  if (markdown && !markdown.includes("报告内容已写入本地报告文件")) {
    return markdown;
  }
  return fallbackText;
}

async function copyHandoffTemplate() {
  const text = handoffTemplate?.textContent || "";
  if (!text.trim() || text.includes("等待生成")) {
    toast("当前没有可复制的交付模板。", true);
    return;
  }
  await copyText(text);
  toast("交付模板已复制。");
}

function applyStabilityTemplate() {
  applyStabilityTemplateToForm({
    form: stabilityTestForm,
    template: stabilityTemplate,
    updateEstimates,
  });
}

function applyBatchTemplate() {
  applyBatchTemplateToForm({
    form: batchTestForm,
    template: batchTemplate,
    updateEstimates,
  });
}

function applyQuickPromptPreset() {
  applyPromptPresetToForm({
    kind: "quick",
    form: quickTestForm,
    select: quickPromptPreset,
    hint: quickPromptHint,
  });
}

function applyStandardPromptPreset() {
  applyPromptPresetToForm({
    kind: "standard",
    form: standardEvalForm,
    select: standardPromptPreset,
    hint: standardPromptHint,
    updateEstimates,
  });
}

function applyStabilityPromptPreset() {
  applyPromptPresetToForm({
    kind: "stability",
    form: stabilityTestForm,
    select: stabilityPromptPreset,
    hint: stabilityPromptHint,
    updateEstimates,
  });
}

function applyBatchPromptPreset() {
  applyPromptPresetToForm({
    kind: "batch",
    form: batchTestForm,
    select: batchPromptPreset,
    hint: batchPromptHint,
    updateEstimates,
  });
}

function applyScenarioTemplate() {
  applyScenarioTemplateToForm({
    form: scenarioTestForm,
    template: scenarioTemplate,
    scenarios: state.scenarios,
    scenarioSelect: scenarioCaseSelect,
    hint: scenarioTemplateHint,
    updateEstimates,
  });
}

function applyProfileTemplate() {
  applyProfileTemplateToForm({
    form: profileForm,
    templateSelect: profileTemplate,
    onApplied: (template) => {
      renderProfileConfigCheck();
      toast(`已应用配置模板：${template.label}`);
    },
  });
}

function hydrateProjectInfoForm() {
  hydrateProjectInfoFormFields(projectInfoForm, state.projectInfo);
  renderDeliveryViews();
}

function hydratePromptPresetSelects() {
  quickPromptPreset.innerHTML = renderPromptPresetOptions("quick", "connectivity");
  standardPromptPreset.innerHTML = renderPromptPresetOptions("standard", "default");
  stabilityPromptPreset.innerHTML = renderPromptPresetOptions("stability", "basic");
  batchPromptPreset.innerHTML = renderPromptPresetOptions("batch", "fair-basic");
  applyQuickPromptPreset();
  applyStandardPromptPreset();
  applyStabilityPromptPreset();
  applyBatchPromptPreset();
}

function updateEstimates() {
  admissionEstimate.textContent = formatEstimateForAdmission();
  admissionBatchEstimate.textContent = formatEstimateForAdmissionBatch();
  updateEstimateLabels({
    stabilityForm: stabilityTestForm,
    stabilityEstimate,
    batchForm: batchTestForm,
    batchProfileSelect,
    batchEstimate,
    scenarioForm: scenarioTestForm,
    scenarioProfileSelect,
    scenarioCaseSelect,
    scenarioEstimate,
    scenarios: state.scenarios,
  });
}

function formatEstimateForAdmission() {
  const payload = Object.fromEntries(new FormData(admissionTestForm).entries());
  payload.modelName = findProfileModelName(payload.profileId);
  return confirmExecution("估算", estimateAdmissionCost(payload)).message;
}

function formatEstimateForAdmissionBatch() {
  const payload = Object.fromEntries(new FormData(admissionBatchForm).entries());
  payload.profileIds = Array.from(admissionBatchProfileSelect.selectedOptions).map((option) => option.value);
  payload.modelNames = payload.profileIds.map(findProfileModelName);
  return confirmExecution("估算", estimateAdmissionBatchCost(payload)).message;
}

function findProfileModelName(profileId) {
  return state.profiles.find((profile) => profile.id === profileId)?.defaultModel || "";
}

async function exportProfiles() {
  if (assertNotDemo("导出配置")) return;
  const data = await api("/api/profiles/export");
  downloadText(`evaluator-profiles-${Date.now()}.json`, JSON.stringify(data, null, 2));
  toast("配置已导出，导出文件不包含 API Key。");
}

async function exportSupportBundle() {
  try {
    const data = await api("/api/support-bundle");
    downloadText(`evaluator-support-${Date.now()}.json`, JSON.stringify(data, null, 2));
    toast("问题包已导出。可以把这个文件发给负责人，里面不包含 API Key。");
  } catch (error) {
    toast(`问题包导出失败：${error.message}`, true);
  }
}
