import { downloadText, escapeHtml, toast } from "./client-utils.js";
import { renderAdmissionResult } from "./admission-view.js";
import { installClientErrorReporter } from "./client-error-reporter.js";
import { copyText } from "./clipboard.js";
import { api, cancelRemoteTask } from "./api-client.js";
import { applyRoleVisibility, ensureAuthenticated, wireUnauthorizedRedirect } from "./auth-gate.js";
import { createConfirmDialog } from "./confirm-dialog.js";
import { createDeveloper } from "./developer.js";
import { createAutoTestConfig } from "./auto-test-config.js";
import { createModelCompare } from "./model-compare.js";
import {
  confirmExecution,
  estimateAdmissionBatchCost,
  estimateAdmissionCost,
  estimateStandardCost,
  estimateBatchCost,
  estimateScenarioCost,
  estimateStabilityCost,
  estimateLoadTestCost,
} from "./cost-estimates.js";
import { renderDeliveryPanels } from "./delivery-panel.js";
import {
  formatBatchResult,
  formatBatchAdmissionResult,
  formatClientLogAnalysisResult,
  formatSupplierEvidenceResult,
} from "./formatters.js";
import { renderRequestList, renderTaskEventList, renderTestRunList } from "./history-view.js";
import { renderTrendChart } from "../shared/trend-chart.mjs";
import { buildWorkflowStatus, getNextWorkflowStep, renderNextActionHtml } from "./workflow-guide.js";
import { requireElement, requireElements } from "./dom-utils.js";
import { installAppearance } from "./appearance.js";
import { createManual } from "./manual.js";
import { createDashboard } from "./dashboard.js";
import { createSettings } from "./settings.js";
import { createTrend } from "./trend.js";
import { createClientReplay } from "./client-replay.js";
import { createLoadTest } from "./load-test.js";
import { createHighRiskBanner } from "./high-risk-banner.js";
import { createReportBrowser } from "./report-browser.js";
import { createKeyModal } from "./key-modal.js";
import { renderRunTargetSelectOptions } from "./profile-view.js";
import { resolveRunnableTargets } from "./runnable-targets.js";
import { createCascadeTargetPicker } from "./target-picker.js";
import { createBatchTargetPicker } from "./batch-target-picker.js";
import { createScenarioCasePicker } from "./scenario-case-picker.js";
import { applyPromptPresetToForm, renderPromptPresetOptions } from "./prompt-presets.js";
import { createChannelAdmin } from "./channel-admin.js";
import { createQuickFailurePanel } from "./quick-failure-panel.js";
import { createStandardEvalController } from "./standard-eval-controller.js";
import { renderStabilitySummary as renderStabilitySummaryPanel } from "./stability-view.js";
import { renderScenarioSummary as renderScenarioSummaryPanel } from "./scenario-view.js";
import { updateEstimateLabels } from "./test-estimates.js";
import { createTaskFormController, requireSelectedValues } from "./test-form-controller.js";
import {
  applyBatchTemplate as applyBatchTemplateToForm,
  applyStabilityTemplate as applyStabilityTemplateToForm,
} from "./test-templates.js";
import { hydrateProjectInfoForm as hydrateProjectInfoFormFields, loadProjectInfo, saveProjectInfo } from "./project-info.js";

installClientErrorReporter();

const state = {
  profiles: [],
  channels: [],
  modelTargets: [],
  requests: [],
  testRuns: [],
  taskEvents: [],
  highRiskAlerts: [], // 高危报告提示：未读高危报告清单（来自 /api/high-risk-alerts）
  scenarios: [],
  manualLoaded: false,
  activeTasks: {},
  projectInfo: loadProjectInfo(),
};

// 渠道/模型/Profile 数据变化注册表：模块可自注册 refresh(data) 回调。
const _onProfileData = [];
function onProfileData(fn) {
  _onProfileData.push(fn);
}

const pages = requireElements(".page");
const navButtons = requireElements(".nav-button");
let currentPage = "dashboard";
const projectInfoForm = requireElement("#project-info-form");
const projectInfoSummary = requireElement("#project-info-summary");
const channelForm = requireElement("#channel-form");
const channelList = requireElement("#channel-list");
const modelTargetForm = requireElement("#model-target-form");
const modelTargetList = requireElement("#model-target-list");
const modelTargetChannelSelect = requireElement("#model-target-channel");
const modelTagFilter = requireElement("#model-tag-filter");
const channelAdmin = createChannelAdmin({
  state,
  els: { channelForm, channelList, modelTargetForm, modelTargetList, modelTargetChannelSelect, modelTagFilter },
  onChange: () => renderProfileOptions(),
});
channelForm.addEventListener("submit", channelAdmin.saveChannel);
modelTargetForm.addEventListener("submit", channelAdmin.saveModelTarget);

// 「开发者界面」（仅超管）：场景测试源数据增删改 + 自定义能力标签。标签保存后刷新模型表单勾选项。
const developer = createDeveloper({
  state,
  onTagsSaved: () => channelAdmin.renderTagOptions(),
  // 删除标签前的危险确认框（与模型管理删除同款）。confirmAction 在后文声明，删除点击在初始化之后，闭包取值时已就绪。
  confirm: (opts) => confirmAction(opts),
});
// 「自动测试配置」（仅超管）：定时自动测试作业的增删改查。confirmAction 在后文声明，闭包取值时已就绪。
const autoTestConfig = createAutoTestConfig({ state, confirm: (opts) => confirmAction(opts) });
// 「模型比对」（登录即可用）：依据两个模型各自最近的报告做统计对比，产出对比报告。
const modelCompare = createModelCompare({ state });
// 注册到 _onProfileData（必须在顶层 await 之前）。
_onProfileData.push((data) => autoTestConfig.refreshTargets(data));
_onProfileData.push((data) => modelCompare.refreshTargets(data));
requireElement("#reload-channels").addEventListener("click", () => channelAdmin.loadChannels());
requireElement("#import-from-newapi").addEventListener("click", () => channelAdmin.importFromNewapi());
requireElement("#model-tag-filter").addEventListener("change", (event) => channelAdmin.setTagFilter(event.target.value));
const quickVerifyProfileSelect = requireElement("#quickverify-profile-select");
const quickVerifySubmit = requireElement("#quickverify-submit");
const quickVerifyResult = requireElement("#quickverify-result");
const trendProfileSelect = requireElement("#trend-profile-select");
const trendXModeSelect = requireElement("#trend-xmode");
const trendWindowSelect = requireElement("#trend-window");
const trendWindowField = requireElement("#trend-window-field");
const trendChart = requireElement("#trend-chart");
const trendRegression = requireElement("#trend-regression");
const trendTable = requireElement("#trend-table");
const trendAlerts = requireElement("#trend-alerts");
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
const loadTestForm = requireElement("#load-test-form");
const loadTestProfileSelect = requireElement("#load-test-profile-select");
const loadTestSubmit = requireElement("#load-test-submit");
const loadTestSummary = requireElement("#load-test-summary");
const loadTestEstimate = requireElement("#load-test-estimate");
const loadTestModeSelect = requireElement("#load-test-mode");
const loadTestLoadLabel = requireElement("#load-test-load-label");
const loadTestMaxInFlightField = requireElement("#load-test-maxinflight-field");
const loadTestBurstField = requireElement("#load-test-burst-field");
const loadTestIntervalField = requireElement("#load-test-interval-field");
const batchTestForm = requireElement("#batch-test-form");
const batchProfileSelect = requireElement("#batch-profile-select");
const batchSubmit = requireElement("#batch-submit");
const batchTestResult = requireElement("#batch-test-result");
const scenarioTestForm = requireElement("#scenario-test-form");
const scenarioProfileSelect = requireElement("#scenario-profile-select");
const scenarioCaseSelect = requireElement("#scenario-case-select");
const scenarioSubmit = requireElement("#scenario-submit");
const scenarioSummary = requireElement("#scenario-summary");
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

// 单选「被测 API」级联选择器(渠道 → 模型),6 个运行页各一个。
// 模型下拉沿用原 *-profile-select(仍 name="profileId"),所以表单提交与后端不变。
const admissionCascade = createCascadeTargetPicker(requireElement("#admission-channel-select"), admissionProfileSelect);
const standardCascade = createCascadeTargetPicker(requireElement("#standard-channel-select"), standardProfileSelect);
const quickVerifyCascade = createCascadeTargetPicker(requireElement("#quickverify-channel-select"), quickVerifyProfileSelect);
const stabilityCascade = createCascadeTargetPicker(requireElement("#stability-channel-select"), stabilityProfileSelect);
// 注册到 _onProfileData（必须在顶层 await 之前，确保首次 loadProfiles 能刷到）。
_onProfileData.push((data) => admissionCascade.refresh(data));
_onProfileData.push((data) => standardCascade.refresh(data));
_onProfileData.push((data) => quickVerifyCascade.refresh(data));
_onProfileData.push((data) => stabilityCascade.refresh(data));
const loadTestChannelSelect = requireElement("#load-test-channel-select");
const trendChannelSelect = requireElement("#trend-channel-select");

// 程序化跳转回填代理:控制器里 `xxxProfileSelect.value = id` 时,写入走级联(同步渠道+模型下拉),
// 读取仍取模型选中值。传给会做跳转回填的控制器(profile / standard-eval)。
const quickVerifyProfileTarget = {
  get value() {
    return quickVerifyProfileSelect.value;
  },
  set value(v) {
    quickVerifyCascade.setValue(v);
  },
};
const stabilityProfileTarget = {
  get value() {
    return stabilityProfileSelect.value;
  },
  set value(v) {
    stabilityCascade.setValue(v);
  },
};

// 批量两维度选择器(渠道体检 A / 渠道选优 B),3 个批量页各一个。选中项同步到隐藏的
// *-profile-select(name=profileIds),所以 updateEstimates / 提交 / 监听器 读法不变。
const admissionBatchPicker = createBatchTargetPicker(requireElement("#admission-batch-picker"), {
  hiddenSelect: admissionBatchProfileSelect,
});
const batchPicker = createBatchTargetPicker(requireElement("#batch-picker"), { hiddenSelect: batchProfileSelect });
const scenarioPicker = createBatchTargetPicker(requireElement("#scenario-picker"), { hiddenSelect: scenarioProfileSelect });
// 注册到 _onProfileData（必须在顶层 await 之前）。
_onProfileData.push((data) => admissionBatchPicker.refresh(data));
_onProfileData.push((data) => batchPicker.refresh(data));
_onProfileData.push((data) => scenarioPicker.refresh(data));
// 「选择测试场景」复用 .batch-picker 勾选样式,真值写回隐藏的 scenarioCaseSelect。
const scenarioCasePicker = createScenarioCasePicker(requireElement("#scenario-case-picker"), scenarioCaseSelect);

const taskEventList = requireElement("#task-event-list");
const stabilityTemplate = requireElement("#stability-template");
const batchTemplate = requireElement("#batch-template");
const stabilityPromptPreset = requireElement("#stability-prompt-preset");
const stabilityPromptHint = requireElement("#stability-prompt-hint");
const batchPromptPreset = requireElement("#batch-prompt-preset");
const batchPromptHint = requireElement("#batch-prompt-hint");
const stabilityEstimate = requireElement("#stability-estimate");
const batchEstimate = requireElement("#batch-estimate");
const scenarioEstimate = requireElement("#scenario-estimate");
const stabilityProgress = requireElement("#stability-progress");
const loadTestProgress = requireElement("#load-test-progress");
const batchProgress = requireElement("#batch-progress");
const scenarioProgress = requireElement("#scenario-progress");
const reportInsights = requireElement("#report-insights");
const rankingList = requireElement("#ranking-list");
const modelComparisonList = requireElement("#model-comparison-list");
const handoffSummary = requireElement("#handoff-summary");
const handoffTemplate = requireElement("#handoff-template");
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
  closeButton: requireElement("#confirm-modal-close"),
});
const keyPrompt = createKeyModal({
  modal: keyModal,
  form: keyModalForm,
  input: keyModalInput,
  cancelButton: keyModalCancel,
});
const quickFailurePanel = createQuickFailurePanel({
  container: quickFailureActions,
  getDefaultProfileId: () => quickVerifyProfileSelect.value,
  updateProfileKey,
  retryQuickTest: () => quickVerifySubmit.click(),
  openProfiles: () => showPage("channels"),
  openStandardEval: (profileId) => {
    if (profileId) standardCascade.setValue(profileId);
    showPage("standard-eval");
  },
  openReports: () => showPage("reports"),
  openStabilitySmoke: (profileId) => {
    if (profileId) stabilityCascade.setValue(profileId);
    stabilityTemplate.value = "smoke";
    applyStabilityTemplate();
    showPage("stability-test");
  },
});

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    showPage(button.dataset.page);
  });
});

// 本机显示偏好（侧边栏折叠 + 更好的光影）：见 src/appearance.js。
// 启动即应用，无需 showPage 派发——它们是全局外观，不属于任何一页。
installAppearance();

// 操作手册页（渲染 + 目录 + scrollspy）：见 src/manual.js。懒加载由下方 showPage 派发。
const manual = createManual({ state });

// 高危报告横幅（顶部红底提示）：见 src/high-risk-banner.js。
// 三个刷新时机由 app.js 触发：启动后、设置开关变化、测试完成后；另有 60s 低频轮询（见文件末）。
const highRiskBanner = createHighRiskBanner({ state });

// 「查看报告」<details> 面板（列表 / 筛选 / 分页 / 删除）：见 src/report-browser.js。
// 它自己接管 toggle 展开事件，故不进 showPage 的懒加载派发。
// 删除按钮的可见性依赖 canConfig，须等认证完成后经 setCanConfig 推入（见下方顶层 await 之后）。
const reportBrowser = createReportBrowser({ state });

// 仪表盘（渠道健康 / 结论分布 / 待办 / 最近报告 / 工作流引导）：见 src/dashboard.js。
const dashboard = createDashboard({
  state,
  els: {
    dashboardEmpty,
    dashboardPopulated,
    statChannels,
    statChannelsChips,
    statChannelsBars,
    statVerdicts,
    statVerdictsChips,
    statTodos,
    statTodosChips,
    dashboardRecent,
    nextAction,
    workflowSteps,
  },
  deps: { escapeHtml, resolveRunnableTargets, buildWorkflowStatus, getNextWorkflowStep, renderNextActionHtml, showPage },
});

// 设置页所需 DOM 元素（requireElement 留在 app.js，通过 els 传入工厂）。
// 对应的选择器被 selector-contract 测试所追踪——删了这里就会漏掉。
const settingsForm = requireElement("#settings-form");
const setAiSpecified = requireElement("#set-ai-specified");
const setAiChannel = requireElement("#set-ai-channel");
const setAiModel = requireElement("#set-ai-model");
const setLivebench = requireElement("#set-livebench");
const setSafety = requireElement("#set-safety");
const setHle = requireElement("#set-hle");
const setHardcoreLogic = requireElement("#set-hardcore-logic");
const setCodingHard = requireElement("#set-coding-hard");
const setAutoTag = requireElement("#set-auto-tag");
const setNewapiBase = requireElement("#set-newapi-base");
const setNewapiToken = requireElement("#set-newapi-token");
const setNewapiUserid = requireElement("#set-newapi-userid");
const setTestCycleDays = requireElement("#set-test-cycle-days");
const setHighRiskAlert = requireElement("#set-high-risk-alert");

// 设置页（AI 总结 / 题库开关 / new-api 网关 / 高危提示等）：见 src/settings.js。
const settings = createSettings({
  state,
  els: {
    settingsForm,
    setAiSpecified,
    setAiChannel,
    setAiModel,
    setLivebench,
    setSafety,
    setHle,
    setHardcoreLogic,
    setCodingHard,
    setAutoTag,
    setNewapiBase,
    setNewapiToken,
    setNewapiUserid,
    setTestCycleDays,
    setHighRiskAlert,
  },
  deps: { api, toast, createCascadeTargetPicker, channelAdmin, highRiskBanner, loadScenarios, onProfileData },
});

// 趋势图页（逐轮质量/延迟趋势 + 退化检测 + 历史告警）：见 src/trend.js。
// 模块自管事件监听器（nav 按钮点击 / 选择器切换），app.js 无需持有其返回值。
createTrend({
  state,
  els: {
    trendChannelSelect,
    trendProfileSelect,
    trendXModeSelect,
    trendWindowSelect,
    trendWindowField,
    trendChart,
    trendRegression,
    trendTable,
    trendAlerts,
  },
  onProfileData,
  deps: { api, escapeHtml, renderTrendChart, createCascadeTargetPicker },
});

// 客户端回放页（日志分析 / 导入 / 回放）：见 src/client-replay.js。
// 模块自管事件监听器，app.js 无需持有其返回值。
createClientReplay({
  state,
  els: {
    clientLogForm,
    clientLogSubmit,
    clientEvidenceSubmit,
    clientLogDirectoryImport,
    clientLogResult,
    clientLogFile,
    clientReplayForm,
    clientReplayProfileSelect,
    clientReplaySubmit,
    clientReplayResult,
    clientReplayExtract,
    clientReplayBatch,
  },
  onProfileData,
  deps: {
    api,
    toast,
    confirmAction,
    loadTestRuns,
    renderDeliveryViews,
    formatClientLogAnalysisResult,
    formatSupplierEvidenceResult,
    renderRunTargetSelectOptions,
  },
});

// 压力测试页（闭环/开环 + 负载扫描）：见 src/load-test.js。
// 模块自管事件监听器 + createTaskFormController，app.js 无需持有其返回值。
createLoadTest({
  state,
  els: {
    loadTestForm,
    loadTestProfileSelect,
    loadTestSubmit,
    loadTestSummary,
    loadTestProgress,
    loadTestEstimate,
    loadTestModeSelect,
    loadTestLoadLabel,
    loadTestMaxInFlightField,
    loadTestBurstField,
    loadTestIntervalField,
    loadTestChannelSelect,
  },
  onProfileData,
  deps: {
    api,
    toast,
    escapeHtml,
    confirmAction,
    createTaskFormController,
    estimateLoadTestCost,
    confirmExecution,
    loadResultsBundle,
    createCascadeTargetPicker,
  },
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-go-page]");
  if (!button) return;
  showPage(button.dataset.goPage);
});

requireElement("#reload-requests").addEventListener("click", async () => {
  await loadResultsBundle();
});
requireElement("#copy-handoff-template").addEventListener("click", copyHandoffTemplate);
requireElement("#refresh-handoff-template").addEventListener("click", renderDeliveryViews);
requireElement("#export-support-bundle").addEventListener("click", exportSupportBundle);

requireElement("#cancel-stability-task").addEventListener("click", () => cancelRemoteTask(state, "stability"));
requireElement("#cancel-load-test-task").addEventListener("click", () => cancelRemoteTask(state, "loadTest"));
requireElement("#cancel-batch-task").addEventListener("click", () => cancelRemoteTask(state, "batch"));
requireElement("#cancel-admission-batch-task").addEventListener("click", () => cancelRemoteTask(state, "admissionBatch"));
requireElement("#cancel-scenario-task").addEventListener("click", () => cancelRemoteTask(state, "scenario"));
requireElement("#cancel-standard-task").addEventListener("click", () => cancelRemoteTask(state, "standard"));
stabilityTemplate.addEventListener("change", applyStabilityTemplate);
batchTemplate.addEventListener("change", applyBatchTemplate);
standardPromptPreset.addEventListener("change", applyStandardPromptPreset);
stabilityPromptPreset.addEventListener("change", applyStabilityPromptPreset);
batchPromptPreset.addEventListener("change", applyBatchPromptPreset);
// input 事件每敲一个字符就触发，updateEstimates 会重建面板 innerHTML（闪烁、低端机
// 输入延迟）。去抖 200ms，只在停止输入后渲染一次。
function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
const updateEstimatesDebounced = debounce(updateEstimates, 200);
stabilityTestForm.addEventListener("input", updateEstimatesDebounced);
batchTestForm.addEventListener("input", updateEstimatesDebounced);
scenarioTestForm.addEventListener("input", updateEstimatesDebounced);
admissionTestForm.addEventListener("input", updateEstimatesDebounced);
admissionBatchForm.addEventListener("input", updateEstimatesDebounced);
admissionProfileSelect.addEventListener("change", updateEstimates);
admissionBatchProfileSelect.addEventListener("change", updateEstimates);
stabilityProfileSelect.addEventListener("change", updateEstimates);
batchProfileSelect.addEventListener("change", updateEstimates);
scenarioProfileSelect.addEventListener("change", updateEstimates);
scenarioCaseSelect.addEventListener("change", updateEstimates);
hydrateProjectInfoForm();
hydratePromptPresetSelects();

projectInfoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.projectInfo = Object.fromEntries(new FormData(projectInfoForm).entries());
  saveProjectInfo(state.projectInfo);
  renderDeliveryViews();
  toast("本次测试信息已保存。");
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

quickVerifySubmit.addEventListener("click", async () => {
  const profileId = quickVerifyProfileSelect.value;
  if (!profileId) {
    quickVerifyResult.textContent = "请先选择被测 API。";
    return;
  }
  quickVerifySubmit.disabled = true;
  quickVerifyResult.textContent = "快检中，请稍候...";
  quickFailurePanel.clear();
  try {
    const result = await api("/api/tests/quick-verify", {
      method: "POST",
      body: JSON.stringify({ profileId }),
    });
    quickVerifyResult.textContent = formatQuickVerify(result);
    await loadRequests();
  } catch (error) {
    quickVerifyResult.textContent = `快检失败：${error.message}`;
    quickFailurePanel.render(error, profileId);
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
  quickProfileSelect: quickVerifyProfileTarget,
  stabilityProfileSelect: stabilityProfileTarget,
  stabilityTemplate,
  applyStabilityTemplate,
  scenarioProfileSelect,
  updateEstimates,
});

let admissionRunning = false;
admissionTestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (admissionRunning) return; // 防双击/确认框 await 期间重复提交（重复=重复扣额度）
  const payload = Object.fromEntries(new FormData(admissionTestForm).entries());
  payload.modelName = findProfileModelName(payload.profileId);
  const estimate = estimateAdmissionCost(payload);
  payload.predicted = estimate; // 跑前预测随 payload 记录，供报告对比
  admissionRunning = true;
  const confirmed = await confirmAction(confirmExecution("模型准入评测", estimate));
  if (!confirmed) {
    admissionRunning = false;
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
    admissionRunning = false;
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
  },
  onSuccess: async (result) => {
    renderStabilitySummary(result);
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
  resultElement: scenarioSummary,
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
    scenarioSummary.innerHTML = `<p class="muted">正在测试 ${payload.profileIds.length} 个 API、${payload.scenarioIds.length} 个场景。复杂场景耗时较长，请等待。</p>`;
  },
  onSuccess: async (result) => {
    renderScenarioSummary(result);
    await loadResultsBundle();
    toast("场景测试完成。");
  },
  failurePrefix: "场景测试失败",
  idleButtonText: "开始场景测试",
});

// 进入主界面前先确保已登录（未登录显示登录闸门并阻塞）
const authUser = await ensureAuthenticated();
reportBrowser.setCanConfig(authUser?.canConfig); // 报告删除按钮的可见性依据（服务端另有强制鉴权）
applyRoleVisibility(authUser);
wireUnauthorizedRedirect();

try {
  await Promise.all([
    loadProfiles(),
    loadScenarios(),
    loadRequests(),
    loadTestRuns(),
    loadTaskEvents(),
    settings.preload(),
    channelAdmin.loadChannels(),
    channelAdmin.loadModelTargets(),
  ]);
  await highRiskBanner.load(); // 启动时按开关拉一次高危报告横幅（此时 state.settings 已就绪）
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
  // 离开设置页且有未保存改动 → 提示。settings.load 会在重新进入时重置 dirty（丢弃未保存改动）。
  if (currentPage === "settings" && page !== "settings" && settings.isDirty()) {
    toast("设置未保存。", true);
    settings.markClean();
  }
  currentPage = page;
  navButtons.forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  pages.forEach((item) => item.classList.toggle("active", item.id === page));
  // 切换页面后新页面从顶部开始，不保留上一页的滚动进度。
  document.querySelector(".main")?.scrollTo(0, 0);
  if (page === "manual" && !state.manualLoaded) {
    manual.load();
  }
  if (page === "settings") {
    settings.load();
  }
  // 「测试场景维护」页（原开发者页）：与全站统一风格，保留侧边栏，进入时加载数据。
  if (page === "developer") {
    developer.load();
  }
  if (page === "auto-test-config") {
    autoTestConfig.load();
  }
  if (page === "model-compare") {
    modelCompare.load();
  }
}

async function loadProfiles() {
  state.profiles = await api("/api/profiles");
  renderProfileOptions();
  dashboard.render();
  updateEstimates();
}

async function loadScenarios() {
  state.scenarios = await api("/api/scenarios");
  renderScenarioOptions();
  channelAdmin.renderTagOptions(); // 场景库就绪后渲染「配置模型」的标签勾选项。
  updateEstimates();
}

async function loadRequests() {
  state.requests = await api("/api/requests/recent");
  renderRequests();
  dashboard.render();
  renderDeliveryViews();
}

async function loadTestRuns() {
  state.testRuns = await api("/api/test-runs/recent");
  renderTestRuns();
  dashboard.render();
  renderDeliveryViews();
}

async function loadTaskEvents() {
  state.taskEvents = await api("/api/tasks/recent");
  renderTaskEvents();
  renderDeliveryViews();
}

// 结果三件套一起拉、只渲染一次。原来 Promise.all([loadRequests,loadTestRuns,
// loadTaskEvents]) 会触发 renderDeliveryViews ×3 / renderDashboard ×2，整页
// innerHTML 重建多次（抖动、丢滚动位置、打断正在复制的 <pre>）。
async function loadResultsBundle() {
  const [requests, testRuns, taskEvents] = await Promise.all([
    api("/api/requests/recent"),
    api("/api/test-runs/recent"),
    api("/api/tasks/recent"),
  ]);
  state.requests = requests;
  state.testRuns = testRuns;
  state.taskEvents = taskEvents;
  renderResultsViews();
}

function renderResultsViews() {
  renderRequests();
  renderTestRuns();
  renderTaskEvents();
  dashboard.render();
  renderDeliveryViews();
  void highRiskBanner.load(); // 测试完成等触发刷新时，顺带刷新高危报告横幅
}

// 低频轮询：覆盖自动测试后台产生（用户停留在页面时也能冒出来）。内部按开关短路。
setInterval(() => void highRiskBanner.load(), 60_000);

async function updateProfileKey(profileId) {
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
  const data = { modelTargets: state.modelTargets, channels: state.channels, profiles: state.profiles };
  for (const fn of _onProfileData) fn(data);
}

function renderScenarioOptions() {
  if (state.scenarios.length === 0) {
    scenarioCaseSelect.innerHTML = `<option value="">暂无测试场景</option>`;
    scenarioCasePicker.refresh();
    return;
  }

  // 默认只勾选「连通性：基础响应」这一个场景；缺失时回落到第一个场景，避免默认零选。
  const defaultScenarioId = state.scenarios.some((scenario) => scenario.id === "connectivity-basic")
    ? "connectivity-basic"
    : state.scenarios[0].id;
  scenarioCaseSelect.innerHTML = state.scenarios
    .map(
      (scenario) =>
        `<option value="${scenario.id}" data-name="${escapeHtml(scenario.name)}" data-difficulty="${escapeHtml(scenario.difficulty)}" data-tag="${escapeHtml(scenario.tag || "")}" data-group="${escapeHtml(scenario.group || "")}"${scenario.id === defaultScenarioId ? " selected" : ""}>${escapeHtml(scenario.name)} / ${escapeHtml(scenario.difficulty)}</option>`,
    )
    .join("");
  scenarioCasePicker.refresh();
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

function renderScenarioSummary(result) {
  renderScenarioSummaryPanel(scenarioSummary, result);
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
  try {
    await copyText(text);
    toast("交付模板已复制。");
  } catch (error) {
    toast(`复制失败：${error.message}`, true);
  }
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

function hydrateProjectInfoForm() {
  hydrateProjectInfoFormFields(projectInfoForm, state.projectInfo);
  renderDeliveryViews();
}

function hydratePromptPresetSelects() {
  standardPromptPreset.innerHTML = renderPromptPresetOptions("standard", "default");
  stabilityPromptPreset.innerHTML = renderPromptPresetOptions("stability", "basic");
  batchPromptPreset.innerHTML = renderPromptPresetOptions("batch", "fair-basic");
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

async function exportSupportBundle() {
  try {
    const data = await api("/api/support-bundle");
    downloadText(`evaluator-support-${Date.now()}.json`, JSON.stringify(data, null, 2));
    toast("问题包已导出。可以把这个文件发给负责人，里面不包含 API Key。");
  } catch (error) {
    toast(`问题包导出失败：${error.message}`, true);
  }
}
