import { downloadText, escapeHtml, toast } from "./client-utils.js";
import { renderAdmissionResult } from "./admission-view.js";
import { installClientErrorReporter } from "./client-error-reporter.js";
import { copyText } from "./clipboard.js";
import { api, cancelRemoteTask } from "./api-client.js";
import { applyRoleVisibility, ensureAuthenticated, wireUnauthorizedRedirect } from "./auth-gate.js";
import { createConfirmDialog } from "./confirm-dialog.js";
import { createDeveloper } from "./developer.js";
import { createAutoTestConfig } from "./auto-test-config.js";
import { createAlertRules } from "./alert-rules.js";
import { createNotifyConfig } from "./notify-config.js";
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
import { renderRequestList, renderTestRunList } from "./history-view.js";
import { renderTrendChart } from "../shared/trend-chart.mjs";
import { buildWorkflowStatus, getNextWorkflowStep, renderNextActionHtml } from "./workflow-guide.js";
import { requireElement, requireElements } from "./dom-utils.js";
import { installAppearance } from "./appearance.js";
import { createManual } from "./manual.js";
import { createDashboard } from "./dashboard.js";
import { createSettings } from "./settings.js";
import { createTestForms } from "./test-forms.js";
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
import { createTaskCenter } from "./task-center.js";
import { createScenarioCasePicker } from "./scenario-case-picker.js";
import { applyPromptPresetToForm, readStabilityGroups, renderPromptPresetOptions, renderStabilityGroupPicker } from "./prompt-presets.js";
import { createChannelAdmin } from "./channel-admin.js";
import { createQuickFailurePanel } from "./quick-failure-panel.js";
import { createStandardEvalController } from "./standard-eval-controller.js";
import { renderStabilitySummary as renderStabilitySummaryPanel } from "./stability-view.js";
import { renderScenarioSummary as renderScenarioSummaryPanel } from "./scenario-view.js";
import { updateEstimateLabels } from "./test-estimates.js";
import { createTaskFormController, requireSelectedValues } from "./test-form-controller.js";
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
const notifyConfig = createNotifyConfig({ state });
// 「模型比对」（登录即可用）：依据两个模型各自最近的报告做统计对比，产出对比报告。
// confirmAction 在后文声明，闭包取值时已就绪（同 autoTestConfig/alertRules 的写法）。
const modelCompare = createModelCompare({ state, confirm: (opts) => confirmAction(opts) });
// 「报警规则」（登录即可用，任意管理员）：自定义阈值报警规则的增删改查。
const alertRules = createAlertRules({ state, confirm: (opts) => confirmAction(opts) });
// 「任务中心」（登录即可用）：所有长任务的状态与逐步骤明细。取代报告中心里原先那个
// 只有一行聚合状态的「最近任务状态」折叠区。confirmAction / showPage 均在后文声明，
// 闭包取值时已就绪（同上面几个模块的写法）。
const taskCenter = createTaskCenter({
  state,
  confirm: (opts) => confirmAction(opts),
  // 「再测一次」只回填表单并跳页，不直接开跑——任务是花钱的，最后一下留给用户。
  // admission-suite 由标准评测页发起（不是准入评测页），故跳 standard-eval。
  // 锚点是单值的，跨渠道的一组只能填中一个渠道，selectMany 如实返回填中的 id。
  onRetest: ({ profileIds }) => {
    showPage("standard-eval");
    return standardPicker.selectMany(profileIds);
  },
});
// 注册到 _onProfileData（必须在顶层 await 之前）。
_onProfileData.push((data) => autoTestConfig.refreshTargets(data));
_onProfileData.push((data) => modelCompare.refreshTargets(data));
_onProfileData.push((data) => alertRules.refreshTargets(data));
requireElement("#reload-channels").addEventListener("click", () => channelAdmin.loadChannels());
// #import-from-newapi 的接线在 settings 创建之后（需要 settings.isDirty()），见下方。
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
const standardEvalSubmit = requireElement("#standard-eval-submit");
const standardPlainResult = requireElement("#standard-plain-result");
const standardEvalResult = requireElement("#standard-eval-result");
const standardNextActions = requireElement("#standard-next-actions");
const standardEvalProgress = requireElement("#standard-eval-progress");
const standardEvalTaskProgress = requireElement("#standard-eval-task-progress");
const admissionTestForm = requireElement("#admission-test-form");
const admissionProfileSelect = requireElement("#admission-profile-select");
const admissionSubmit = requireElement("#admission-submit");
const admissionEstimate = requireElement("#admission-estimate");
const admissionResult = requireElement("#admission-result");
const admissionProgress = requireElement("#admission-progress");
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
const quickVerifyCascade = createCascadeTargetPicker(requireElement("#quickverify-channel-select"), quickVerifyProfileSelect);
const stabilityCascade = createCascadeTargetPicker(requireElement("#stability-channel-select"), stabilityProfileSelect);
// 注册到 _onProfileData（必须在顶层 await 之前，确保首次 loadProfiles 能刷到）。
_onProfileData.push((data) => admissionCascade.refresh(data));
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
// 标准评测:固定「一渠道·多模型」维度(不给用户切成「一模型·多渠道」),选中的模型顺序执行标准评测。
const standardPicker = createBatchTargetPicker(requireElement("#standard-picker"), {
  hiddenSelect: standardProfileSelect,
  fixedDim: "A",
});
// 注册到 _onProfileData（必须在顶层 await 之前）。
_onProfileData.push((data) => admissionBatchPicker.refresh(data));
_onProfileData.push((data) => batchPicker.refresh(data));
_onProfileData.push((data) => scenarioPicker.refresh(data));
_onProfileData.push((data) => standardPicker.refresh(data));
// 「选择测试场景」复用 .batch-picker 勾选样式,真值写回隐藏的 scenarioCaseSelect。
const scenarioCasePicker = createScenarioCasePicker(requireElement("#scenario-case-picker"), scenarioCaseSelect);

const stabilityGroupPicker = requireElement("#stability-group-picker");
const stabilityRequestTotal = requireElement("#stability-request-total");
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

// 「从 new-api 上游渠道导入测试分组」模态框：收三项凭据 → 调 channelAdmin.importTestTokens。
// 凭据不保存（后端也不存），关框即清空输入，避免个人令牌留在 DOM 里。
const tokenImportModal = requireElement("#token-import-modal");
const tokenImportForm = requireElement("#token-import-form");
const tokenImportBase = requireElement("#token-import-base");
const tokenImportToken = requireElement("#token-import-token");
const tokenImportUserid = requireElement("#token-import-userid");
const tokenImportSubmit = requireElement("#token-import-submit");
function closeTokenImportModal() {
  tokenImportModal.classList.add("hidden");
  tokenImportToken.value = ""; // 只清令牌：网址/用户ID 留着，重试时不用重填
}
requireElement("#import-test-tokens").addEventListener("click", () => {
  tokenImportModal.classList.remove("hidden");
  tokenImportBase.focus();
});
requireElement("#token-import-cancel").addEventListener("click", closeTokenImportModal);
// 刻意【不】做「点遮罩即关」：本框要手填三项凭据（个人令牌还得去 new-api 后台翻），
// 误点空白就全部作废、令牌还会被 closeTokenImportModal 清空，代价远大于少一种关闭方式。
// 关闭途径保留取消按钮与 Esc（Esc 有按键意图、不会误触）。key-modal/confirm-modal 仍保留
// 点遮罩关闭——那两个是即答即走的小框，填的内容丢了也不心疼，不必强求一致。
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !tokenImportModal.classList.contains("hidden")) closeTokenImportModal();
});
tokenImportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const creds = {
    baseUrl: tokenImportBase.value.trim(),
    token: tokenImportToken.value.trim(),
    userId: tokenImportUserid.value.trim(),
  };
  if (!creds.baseUrl || !creds.token || !creds.userId) {
    toast("三项都必填：new-api 网址、个人令牌、用户ID。", true);
    return;
  }
  // 导入要串多个上游请求（列令牌→取明文→查定价），耗时可观：禁用按钮防重复提交。
  tokenImportSubmit.disabled = true;
  tokenImportSubmit.textContent = "导入中…";
  try {
    await channelAdmin.importTestTokens(creds);
    closeTokenImportModal();
  } catch (error) {
    toast(`导入失败：${error.message}`, true);
  } finally {
    tokenImportSubmit.disabled = false;
    tokenImportSubmit.textContent = "开始导入";
  }
});
const quickFailurePanel = createQuickFailurePanel({
  container: quickFailureActions,
  getDefaultProfileId: () => quickVerifyProfileSelect.value,
  updateProfileKey,
  retryQuickTest: () => quickVerifySubmit.click(),
  openProfiles: () => showPage("channels"),
  openStandardEval: (profileId) => {
    if (profileId) standardPicker.selectSingle(profileId);
    showPage("standard-eval");
  },
  openReports: () => showPage("reports"),
  openStabilitySmoke: (profileId) => {
    if (profileId) stabilityCascade.setValue(profileId);
    applyStabilityGroupPreset({ basic: 3 });
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
// 批量下载与删除按钮的可见性依赖 canConfig，须等认证完成后经 setCanConfig 推入（见下方顶层 await 之后）。
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

// 「从 new-api 一键导入」按钮在设置页的 new-api 网关配置正下方（原在渠道管理页顶栏）。
// 放在这里而非上方其它接线处：需要 settings.isDirty() —— 后端导入读的是已保存的 settings，
// 用户改了网关字段没保存就点导入，会拿旧配置去导，先提醒一次。
requireElement("#import-from-newapi").addEventListener("click", () => {
  if (settings.isDirty()) {
    toast("上面的设置还没保存，导入会使用已保存的旧配置。请先点「保存设置」。", true);
    return;
  }
  return channelAdmin.importFromNewapi();
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
  reportBrowser.refresh(); // 同时刷新报告文件列表
});
requireElement("#copy-handoff-template").addEventListener("click", copyHandoffTemplate);
requireElement("#refresh-handoff-template").addEventListener("click", renderDeliveryViews);
requireElement("#export-support-bundle").addEventListener("click", exportSupportBundle);
requireElement("#check-disk-usage").addEventListener("click", checkDiskUsage);

requireElement("#cancel-stability-task").addEventListener("click", () => cancelRemoteTask(state, "stability"));
requireElement("#cancel-load-test-task").addEventListener("click", () => cancelRemoteTask(state, "loadTest"));
requireElement("#cancel-batch-task").addEventListener("click", () => cancelRemoteTask(state, "batch"));
requireElement("#cancel-admission-batch-task").addEventListener("click", () => cancelRemoteTask(state, "admissionBatch"));
requireElement("#cancel-admission-task").addEventListener("click", () => cancelRemoteTask(state, "admission"));
requireElement("#cancel-scenario-task").addEventListener("click", () => cancelRemoteTask(state, "scenario"));
requireElement("#cancel-standard-eval-task").addEventListener("click", () => cancelRemoteTask(state, "standardEval"));
requireElement("#cancel-mc-gap-fill-task").addEventListener("click", () => modelCompare.cancelGapFill());
stabilityGroupPicker.addEventListener("input", () => updateStabilityRequestTotal());
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

const testForms = createTestForms({
  state,
  els: {
    admissionTestForm: admissionTestForm,
    admissionProfileSelect: admissionProfileSelect,
    admissionSubmit: admissionSubmit,
    admissionEstimate: admissionEstimate,
    admissionResult: admissionResult,
    admissionProgress: admissionProgress,
    admissionBatchForm: admissionBatchForm,
    admissionBatchProfileSelect: admissionBatchProfileSelect,
    admissionBatchSubmit: admissionBatchSubmit,
    admissionBatchEstimate: admissionBatchEstimate,
    admissionBatchProgress: admissionBatchProgress,
    admissionBatchResult: admissionBatchResult,
    stabilityTestForm: stabilityTestForm,
    stabilityProfileSelect: stabilityProfileSelect,
    stabilitySubmit: stabilitySubmit,
    stabilitySummary: stabilitySummary,
    stabilityEstimate: stabilityEstimate,
    stabilityProgress: stabilityProgress,
    batchTestForm: batchTestForm,
    batchProfileSelect: batchProfileSelect,
    batchSubmit: batchSubmit,
    batchTestResult: batchTestResult,
    batchEstimate: batchEstimate,
    batchProgress: batchProgress,
    scenarioTestForm: scenarioTestForm,
    scenarioProfileSelect: scenarioProfileSelect,
    scenarioCaseSelect: scenarioCaseSelect,
    scenarioSubmit: scenarioSubmit,
    scenarioSummary: scenarioSummary,
    scenarioEstimate: scenarioEstimate,
    scenarioProgress: scenarioProgress,
  },
  deps: {
    toast,
    createTaskFormController,
    requireSelectedValues,
    confirmAction,
    confirmExecution,
    estimateAdmissionCost,
    estimateAdmissionBatchCost,
    estimateStabilityCost,
    readStabilityGroups,
    estimateBatchCost,
    estimateScenarioCost,
    renderAdmissionResult,
    renderStabilitySummaryPanel,
    renderScenarioSummaryPanel,
    formatBatchResult,
    formatBatchAdmissionResult,
    updateEstimateLabels,
    loadResultsBundle,
    debounce,
  },
});

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
  taskProgressElement: standardEvalTaskProgress,
  state,
  estimateCost: estimateStandardCost,
  confirmRun: (title, estimate) => confirmAction(confirmExecution(title, estimate)),
  refreshResults: () => loadResultsBundle(),
  showPage,
  quickProfileSelect: quickVerifyProfileTarget,
  stabilityProfileSelect: stabilityProfileTarget,
  applyStabilityGroupPreset,
  admissionChannelSelect: admissionCascade,
  admissionProfileSelect,
  admissionPackageLevelSelect: requireElement("#admission-package-level"),
  updateEstimates: testForms.updateEstimates,
  standardPicker,
});

// 进入主界面前先确保已登录（未登录显示登录闸门并阻塞）
const authUser = await ensureAuthenticated();
reportBrowser.setCanConfig(authUser?.canConfig); // 报告受限操作的可见性依据（服务端另有强制鉴权）
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
  if (page === "alert-rules") {
    alertRules.load();
  }
  if (page === "notify-config") {
    notifyConfig.load();
  }
  if (page === "model-compare") {
    modelCompare.load();
  }
  // 每次进入都重新拉：任务状态是会自己变的，缓存住只会给用户看过期进度。
  if (page === "task-center") {
    taskCenter.load();
  }
}

async function loadProfiles() {
  state.profiles = await api("/api/profiles");
  renderProfileOptions();
  dashboard.render();
  testForms.updateEstimates();
}

async function loadScenarios() {
  state.scenarios = await api("/api/scenarios");
  renderScenarioOptions();
  channelAdmin.renderTagOptions(); // 场景库就绪后渲染「配置模型」的标签勾选项。
  testForms.updateEstimates();
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

// state.taskEvents 仍然要拉：交付视图靠它识别「因程序关闭而中断」的任务。
// 但不再单独渲染成一张表——任务状态现在归「任务中心」页（它自己按需拉取）。
async function loadTaskEvents() {
  state.taskEvents = await api("/api/tasks/recent");
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
  // scenario.id 由场景库（server/scenarios/）定义，不是用户输入——同字段名安全级别，故不转义
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

// 分组选择器：把每个数量框重置为指定值（未列出的预设归零），用于「冒烟」「候选复测」等
// 快捷入口（原来靠"测试模板"下拉，现在改成直接设置各组数量）。
function applyStabilityGroupPreset(repeatsByPresetId) {
  stabilityGroupPicker.querySelectorAll(".stability-group-repeats").forEach((input) => {
    input.value = String(repeatsByPresetId[input.dataset.presetId] ?? 0);
  });
  updateStabilityRequestTotal();
  testForms.updateEstimates();
}

function updateStabilityRequestTotal() {
  const groups = readStabilityGroups(stabilityTestForm);
  const totalRequests = groups.reduce((sum, group) => sum + group.repeats, 0);
  stabilityRequestTotal.textContent = `共 ${totalRequests} 次请求（${groups.length} 组）`;
}

function applyBatchPromptPreset() {
  applyPromptPresetToForm({
    kind: "batch",
    form: batchTestForm,
    select: batchPromptPreset,
    hint: batchPromptHint,
    updateEstimates: testForms.updateEstimates,
  });
}

function hydrateProjectInfoForm() {
  hydrateProjectInfoFormFields(projectInfoForm, state.projectInfo);
  renderDeliveryViews();
}

function hydratePromptPresetSelects() {
  stabilityGroupPicker.innerHTML = renderStabilityGroupPicker();
  updateStabilityRequestTotal();
  batchPromptPreset.innerHTML = renderPromptPresetOptions("batch", "fair-basic");
  applyBatchPromptPreset();
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

// 磁盘空间（评测数据所在分区剩余量，非目录用量）。
async function checkDiskUsage() {
  try {
    const { freeBytes, totalBytes, usedPercent } = await api("/api/reports/disk");
    const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);
    toast(`磁盘剩余 ${gb(freeBytes)} GB / 共 ${gb(totalBytes)} GB（已用 ${usedPercent}%）`);
  } catch (error) {
    toast(`磁盘空间查询失败：${error.message}`, true);
  }
}
