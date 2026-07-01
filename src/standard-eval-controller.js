import { average, escapeHtml, toast } from "./client-utils.js";
import { api, runRemoteTask } from "./api-client.js";
import {
  buildErrorAdviceText,
  buildStandardActionPlan,
  buildStandardNextStepAdvice,
  buildStandardOperatorSummary,
} from "./operator-guidance.js";

export function createStandardEvalController({
  form,
  submitButton,
  plainResultElement,
  resultElement,
  nextActionsElement,
  progressElement,
  taskProgressElement,
  state,
  estimateCost,
  confirmRun,
  refreshResults,
  showPage,
  quickProfileSelect,
  stabilityProfileSelect,
  stabilityTemplate,
  applyStabilityTemplate,
  scenarioProfileSelect,
  updateEstimates,
}) {
  let running = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (running) return; // 防双击/确认框 await 期间重复提交（最贵流程，重复=重复扣额度）
    const payload = Object.fromEntries(new FormData(form).entries());
    const scenarioIds = pickStandardScenarioIds(state.scenarios);
    state.latestStandardProfileId = payload.profileId || "";
    if (!payload.profileId) {
      toast("请先选择一个被测 API。", true);
      return;
    }
    running = true;
    if (!(await confirmRun("标准评测", estimateCost(payload, scenarioIds.length)))) {
      running = false;
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "标准评测运行中...";
    resetStandardSteps(progressElement);
    renderStandardPlainPending(
      plainResultElement,
      "正在评测",
      "工具会先确认 API 能不能通，再检查稳定性和基础场景表现。请等待评测完成。",
      "watch",
    );
    resultElement.textContent = "标准评测开始。请不要关闭窗口。";
    clearStandardNextActions(nextActionsElement);

    try {
      const result = await runStandardEvaluation({
        payload,
        scenarioIds,
        state,
        progressElement,
        taskProgressElement,
      });
      const standardResultText = formatStandardResult(result);
      renderStandardPlainResult({ ...result, plainResultElement });
      resultElement.textContent = standardResultText;
      renderStandardNextActions({
        ...result,
        profileId: payload.profileId,
        nextActionsElement,
        runAction: (action, profileId) =>
          runStandardNextAction({
            action,
            profileId,
            showPage,
            quickProfileSelect,
            stabilityProfileSelect,
            stabilityTemplate,
            applyStabilityTemplate,
            scenarioProfileSelect,
            updateEstimates,
          }),
      });
      await refreshResults();
      toast("标准评测完成。");
    } catch (error) {
      renderStandardPlainPending(
        plainResultElement,
        "暂时不能交付使用",
        `标准评测没有跑完。优先检查 API 地址、Key、模型名称和网络环境。错误摘要：${error.message}`,
        "fail",
      );
      resultElement.textContent = `标准评测失败：${error.message}\n\n${buildErrorAdviceText(error)}`;
      renderStandardNextActions({
        quick: { success: false, normalizedError: error.normalizedError || error.message },
        stability: null,
        scenario: null,
        profileId: payload.profileId,
        nextActionsElement,
        runAction: (action, profileId) =>
          runStandardNextAction({
            action,
            profileId,
            showPage,
            quickProfileSelect,
            stabilityProfileSelect,
            stabilityTemplate,
            applyStabilityTemplate,
            scenarioProfileSelect,
            updateEstimates,
          }),
      });
      const runningStep = progressElement.querySelector(".flow-step.running");
      if (runningStep) {
        setStandardStep(progressElement, runningStep.dataset.standardStep, "failed", error.message);
      }
    } finally {
      running = false;
      submitButton.disabled = false;
      submitButton.textContent = "开始标准评测";
    }
  });
}

function renderStandardPlainPending(plainResultElement, title, detail, level) {
  plainResultElement.className = `plain-result-card ${level}-card`;
  plainResultElement.innerHTML = `
    <span>人话结论</span>
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(detail)}</p>
  `;
}

function renderStandardPlainResult({ quick, stability, scenario, plainResultElement }) {
  const summary = buildStandardOperatorSummary({ quick, stability, scenario });
  renderStandardPlainPending(plainResultElement, summary.title, summary.detail, summary.level);
}

async function runStandardEvaluation({ payload, scenarioIds, state, progressElement, taskProgressElement }) {
  setStandardStep(progressElement, "quick", "running", "正在确认 API 是否能正常请求。");
  const quick = await api("/api/tests/quick", {
    method: "POST",
    body: JSON.stringify({ profileId: payload.profileId, prompt: payload.prompt }),
  });
  setStandardStep(progressElement, "quick", quick.success ? "done" : "failed", quick.success ? "快速测试成功。" : quick.normalizedError || "快速测试失败。");
  if (!quick.success) {
    const error = new Error(`快速测试失败：${quick.normalizedError || quick.message || "请检查配置。"}`);
    error.normalizedError = quick.normalizedError;
    throw error;
  }

  setStandardStep(progressElement, "stability", "running", `正在执行 ${payload.rounds} 轮稳定性测试。`);
  const stability = await runRemoteTask(
    state,
    "standard",
    "stability",
    {
      profileId: payload.profileId,
      rounds: payload.rounds,
      concurrency: "1",
      prompt: [
        "请用中文完成一次稳定性测试回答：",
        "1. 用一句话说明你已正常响应。",
        "2. 用两条要点说明评估 AI API 稳定性应该关注哪些指标。",
        "3. 最后一行固定输出：测试完成。",
      ].join("\n"),
      useAiReportAnalysis: payload.useAiReportAnalysis || "",
    },
    taskProgressElement,
  );
  setStandardStep(progressElement, "stability", "done", `稳定性测试完成：成功率 ${stability.successRateText || "-"}，慢请求参考 ${stability.p95TotalMs ?? "-"} ms。`);

  let scenario = null;
  if (scenarioIds.length > 0) {
    setStandardStep(progressElement, "scenario", "running", `正在执行 ${scenarioIds.length} 个轻量场景。`);
    scenario = await runRemoteTask(
      state,
      "standard",
      "scenario",
      {
        profileIds: [payload.profileId],
        scenarioIds,
        repeats: "1",
        maxParallelProfiles: "1",
        requestConcurrency: "1",
        useAiReportAnalysis: payload.useAiReportAnalysis || "",
      },
      taskProgressElement,
    );
    const score = Math.round(average(scenario.results?.map((item) => item.avgQualityScore).filter((value) => Number.isFinite(value)) || []) || 0);
    setStandardStep(progressElement, "scenario", "done", `场景测试完成：平均质量分 ${score || "-"}。`);
  } else {
    setStandardStep(progressElement, "scenario", "skipped", "暂无可用场景，已跳过。");
  }

  return { quick, stability, scenario };
}

function renderStandardNextActions({ quick, stability, scenario, profileId, nextActionsElement, runAction }) {
  const summary = buildStandardOperatorSummary({ quick, stability, scenario });
  const actions = buildStandardActionPlan({ quick, stability, scenario });
  nextActionsElement.className = `next-step-panel ${summary.level}-card`;
  nextActionsElement.innerHTML = `
    <div>
      <span>人话结论</span>
      <strong>${escapeHtml(summary.title)}</strong>
      <p>${escapeHtml(summary.detail)}</p>
    </div>
    <div class="action-row">
      ${actions
        .map(
          (action) =>
            `<button class="${action.kind === "primary" ? "primary" : "secondary"}" type="button" data-next-action="${action.action}">${escapeHtml(action.label)}</button>`,
        )
        .join("")}
    </div>
  `;
  nextActionsElement.querySelectorAll("[data-next-action]").forEach((button) => {
    button.addEventListener("click", () => runAction(button.dataset.nextAction, profileId));
  });
}

function runStandardNextAction({
  action,
  profileId,
  showPage,
  quickProfileSelect,
  stabilityProfileSelect,
  stabilityTemplate,
  applyStabilityTemplate,
  scenarioProfileSelect,
  updateEstimates,
}) {
  if (action === "profile-config") {
    showPage("profiles");
    return;
  }
  if (action === "quick-retry") {
    if (profileId) quickProfileSelect.value = profileId;
    showPage("quick-test");
    return;
  }
  if (action === "stability-basic" || action === "stability-smoke") {
    if (profileId) stabilityProfileSelect.value = profileId;
    stabilityTemplate.value = action === "stability-basic" ? "basic" : "smoke";
    applyStabilityTemplate();
    showPage("stability-test");
    return;
  }
  if (action === "scenario-basic") {
    // 场景测试已改为两维度批量选择器,无法稳定预选单个目标;跳过去后由用户在该页选目标。
    showPage("scenario-test");
    return;
  }
  showPage(action === "handoff" ? "handoff" : "reports");
}

function pickStandardScenarioIds(scenarios) {
  const preferred = scenarios.filter((scenario) => ["connectivity", "speed", "structured", "writing"].includes(scenario.category));
  const source = preferred.length >= 2 ? preferred : scenarios;
  return source.slice(0, 2).map((scenario) => scenario.id);
}

function resetStandardSteps(progressElement) {
  progressElement.querySelectorAll(".flow-step").forEach((step) => {
    step.classList.remove("running", "done", "failed", "skipped");
    step.querySelector("small").textContent = "等待开始。";
  });
}

function setStandardStep(progressElement, stepName, status, message) {
  const step = progressElement.querySelector(`[data-standard-step="${stepName}"]`);
  if (!step) return;
  step.classList.remove("running", "done", "failed", "skipped");
  step.classList.add(status);
  step.querySelector("small").textContent = message;
}

function clearStandardNextActions(nextActionsElement) {
  nextActionsElement.classList.add("hidden");
  nextActionsElement.innerHTML = "";
}

function formatStandardResult({ quick, stability, scenario }) {
  const scenarioScores = scenario?.results?.map((item) => item.avgQualityScore).filter((value) => Number.isFinite(value)) || [];
  const nextSteps = buildStandardNextStepAdvice({ quick, stability, scenario });
  return [
    "# 标准评测结果",
    "",
    "## 快速测试",
    "",
    `- 结果：${quick.success ? "成功" : "失败"}`,
    `- 请求状态：${quick.statusCode ?? "-"}`,
    `- 总耗时：${quick.totalMs ?? "-"} ms`,
    `- 摘要：${quick.responseSummary || quick.normalizedError || "-"}`,
    "",
    "## 稳定性测试",
    "",
    `- 成功率：${stability.successRateText || "-"}`,
    `- 平均耗时：${stability.avgTotalMs || "-"} ms`,
    `- 慢请求参考：${stability.p95TotalMs ?? "-"} ms`,
    `- 结论：${stability.recommendation?.title || "-"}`,
    `- 报告：${stability.reportPath || "-"}`,
    "",
    "## 复杂场景",
    "",
    scenario
      ? [
          `- 被测场景：${scenario.scenarioCount ?? "-"} 个`,
          `- 平均质量分：${Math.round(average(scenarioScores) || 0) || "-"}`,
          `- 报告：${scenario.reportPath || "-"}`,
        ].join("\n")
      : "- 未执行场景测试。",
    "",
    "## 下一步建议",
    "",
    ...nextSteps.map((step) => `- ${step}`),
  ].join("\n");
}
