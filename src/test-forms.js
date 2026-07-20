// src/test-forms.js
// 表单控制器汇总：准入（单+批量）、稳定性、批量并发、复杂场景。
// 采用零外部耦合模式——所有依赖通过 deps 注入，DOM 元素通过 els 传入。
export function createTestForms({ state, els, deps }) {
  const {
    api,
    toast,
    escapeHtml,
    createTaskFormController,
    requireSelectedValues,
    confirmAction,
    confirmExecution,
    estimateAdmissionCost,
    estimateAdmissionBatchCost,
    estimateStabilityCost,
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
  } = deps;

  // ── 准入（单 API）── 独立 submit handler，不走 createTaskFormController ──
  let admissionRunning = false;
  els.admissionTestForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (admissionRunning) return; // 防双击/确认框 await 期间重复提交（重复=重复扣额度）
    const payload = Object.fromEntries(new FormData(els.admissionTestForm).entries());
    payload.modelName = findProfileModelName(payload.profileId);
    const estimate = estimateAdmissionCost(payload);
    payload.predicted = estimate; // 跑前预测随 payload 记录，供报告对比
    admissionRunning = true;
    const confirmed = await confirmAction(confirmExecution("模型准入评测", estimate));
    if (!confirmed) {
      admissionRunning = false;
      return;
    }

    els.admissionSubmit.disabled = true;
    els.admissionSubmit.textContent = "准入评测中...";
    els.admissionResult.innerHTML = `<p class="muted">正在执行准入评测。请不要关闭窗口。</p>`;
    try {
      const result = await api("/api/tests/admission", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      els.admissionResult.innerHTML = renderAdmissionResult(result);
      await loadResultsBundle();
      toast("准入评测完成。");
    } catch (error) {
      els.admissionResult.innerHTML = `<p class="fail">准入评测失败：${escapeHtml(error.message)}</p>`;
      toast(error.message, true);
    } finally {
      admissionRunning = false;
      els.admissionSubmit.disabled = false;
      els.admissionSubmit.textContent = "开始准入评测";
    }
  });

  // ── 批量准入对比 ──
  createTaskFormController({
    form: els.admissionBatchForm,
    submitButton: els.admissionBatchSubmit,
    resultElement: els.admissionBatchResult,
    progressElement: els.admissionBatchProgress,
    state,
    slot: "admissionBatch",
    taskType: "batch-admission",
    confirmRun: (payload) => confirmAction(confirmExecution("批量准入对比", estimateAdmissionBatchCost(payload))),
    predict: (payload) => estimateAdmissionBatchCost(payload),
    preparePayload: (payload) => {
      const profileIds = requireSelectedValues(els.admissionBatchProfileSelect, "请至少选择一个被测 API。");
      return profileIds ? { ...payload, profileIds } : null;
    },
    beforeStart: (payload) => {
      els.admissionBatchResult.textContent = `正在对 ${payload.profileIds.length} 个 API 执行准入评测。请不要关闭窗口。`;
    },
    onSuccess: async (result) => {
      const copyableSummary = getCopyableReportText(result, formatBatchAdmissionResult(result));
      els.admissionBatchResult.textContent = copyableSummary;
      await loadResultsBundle();
      toast("批量准入对比完成。");
    },
    failurePrefix: "批量准入对比失败",
    idleButtonText: "开始批量准入对比",
  });

  // ── 稳定性测试 ──
  createTaskFormController({
    form: els.stabilityTestForm,
    submitButton: els.stabilitySubmit,
    resultElement: els.stabilitySummary,
    progressElement: els.stabilityProgress,
    state,
    slot: "stability",
    taskType: "stability",
    confirmRun: (payload) => confirmAction(confirmExecution("稳定性测试", estimateStabilityCost(payload))),
    predict: (payload) => estimateStabilityCost(payload),
    preparePayload: (payload) => payload,
    beforeStart: (payload) => {
      els.stabilitySummary.innerHTML = `<p class="muted">正在进行 ${payload.rounds} 轮测试。请不要关闭窗口。</p>`;
    },
    onSuccess: async (result) => {
      renderStabilitySummary(result);
      await loadResultsBundle();
      toast("稳定性测试完成。");
    },
    failurePrefix: "稳定性测试失败",
    idleButtonText: "开始稳定性测试",
  });

  // ── 批量并发测试 ──
  createTaskFormController({
    form: els.batchTestForm,
    submitButton: els.batchSubmit,
    resultElement: els.batchTestResult,
    progressElement: els.batchProgress,
    state,
    slot: "batch",
    taskType: "batch-stability",
    confirmRun: (payload) => confirmAction(confirmExecution("批量并发测试", estimateBatchCost(payload))),
    predict: (payload) => estimateBatchCost(payload),
    preparePayload: (payload) => {
      const profileIds = requireSelectedValues(els.batchProfileSelect, "请至少选择一个被测 API。");
      return profileIds ? { ...payload, profileIds } : null;
    },
    beforeStart: (payload) => {
      els.batchTestResult.textContent = `正在测试 ${payload.profileIds.length} 个 API。测试期间可以等待，不要关闭窗口。`;
    },
    onSuccess: async (result) => {
      const copyableSummary = getCopyableReportText(result, formatBatchResult(result));
      els.batchTestResult.textContent = copyableSummary;
      await loadResultsBundle();
      toast("批量测试完成。");
    },
    failurePrefix: "批量测试失败",
    idleButtonText: "开始批量测试",
  });

  // ── 复杂场景测试 ──
  createTaskFormController({
    form: els.scenarioTestForm,
    submitButton: els.scenarioSubmit,
    resultElement: els.scenarioSummary,
    progressElement: els.scenarioProgress,
    state,
    slot: "scenario",
    taskType: "scenario",
    confirmRun: (payload) => confirmAction(confirmExecution("复杂场景测试", estimateScenarioCost(payload, state.scenarios))),
    predict: (payload) => estimateScenarioCost(payload, state.scenarios),
    preparePayload: (payload) => {
      const profileIds = requireSelectedValues(els.scenarioProfileSelect, "请至少选择一个被测 API。");
      if (!profileIds) return null;
      const scenarioIds = requireSelectedValues(els.scenarioCaseSelect, "请至少选择一个测试场景。");
      return scenarioIds ? { ...payload, profileIds, scenarioIds } : null;
    },
    beforeStart: (payload) => {
      els.scenarioSummary.innerHTML = `<p class="muted">正在测试 ${payload.profileIds.length} 个 API、${payload.scenarioIds.length} 个场景。复杂场景耗时较长，请等待。</p>`;
    },
    onSuccess: async (result) => {
      renderScenarioSummary(result);
      await loadResultsBundle();
      toast("场景测试完成。");
    },
    failurePrefix: "场景测试失败",
    idleButtonText: "开始场景测试",
  });

  // ── 辅助函数 ──
  function renderStabilitySummary(result) {
    renderStabilitySummaryPanel(els.stabilitySummary, result);
  }

  function renderScenarioSummary(result) {
    renderScenarioSummaryPanel(els.scenarioSummary, result);
  }

  function getCopyableReportText(result, fallbackText) {
    const markdown = String(result?.reportMarkdown || "");
    if (markdown && !markdown.includes("报告内容已写入本地报告文件")) {
      return markdown;
    }
    return fallbackText;
  }

  function findProfileModelName(profileId) {
    return state.profiles.find((profile) => profile.id === profileId)?.defaultModel || "";
  }

  function formatEstimateForAdmission() {
    const payload = Object.fromEntries(new FormData(els.admissionTestForm).entries());
    payload.modelName = findProfileModelName(payload.profileId);
    return confirmExecution("估算", estimateAdmissionCost(payload)).message;
  }

  function formatEstimateForAdmissionBatch() {
    const payload = Object.fromEntries(new FormData(els.admissionBatchForm).entries());
    payload.profileIds = Array.from(els.admissionBatchProfileSelect.selectedOptions).map((option) => option.value);
    payload.modelNames = payload.profileIds.map(findProfileModelName);
    return confirmExecution("估算", estimateAdmissionBatchCost(payload)).message;
  }

  // ── 中央估值刷新（跨所有表单）──
  function updateEstimates() {
    els.admissionEstimate.textContent = formatEstimateForAdmission();
    els.admissionBatchEstimate.textContent = formatEstimateForAdmissionBatch();
    updateEstimateLabels({
      stabilityForm: els.stabilityTestForm,
      stabilityEstimate: els.stabilityEstimate,
      batchForm: els.batchTestForm,
      batchProfileSelect: els.batchProfileSelect,
      batchEstimate: els.batchEstimate,
      scenarioForm: els.scenarioTestForm,
      scenarioProfileSelect: els.scenarioProfileSelect,
      scenarioCaseSelect: els.scenarioCaseSelect,
      scenarioEstimate: els.scenarioEstimate,
      scenarios: state.scenarios,
    });
  }

  const updateEstimatesDebounced = debounce(updateEstimates, 200);

  // ── 估值刷新事件监听 ──
  els.stabilityTestForm.addEventListener("input", updateEstimatesDebounced);
  els.batchTestForm.addEventListener("input", updateEstimatesDebounced);
  els.scenarioTestForm.addEventListener("input", updateEstimatesDebounced);
  els.admissionTestForm.addEventListener("input", updateEstimatesDebounced);
  els.admissionBatchForm.addEventListener("input", updateEstimatesDebounced);
  els.admissionProfileSelect.addEventListener("change", updateEstimates);
  els.admissionBatchProfileSelect.addEventListener("change", updateEstimates);
  els.stabilityProfileSelect.addEventListener("change", updateEstimates);
  els.batchProfileSelect.addEventListener("change", updateEstimates);
  els.scenarioProfileSelect.addEventListener("change", updateEstimates);
  els.scenarioCaseSelect.addEventListener("change", updateEstimates);

  return { updateEstimates };
}
