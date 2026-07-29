import { escapeHtml, toast } from "./client-utils.js";
import { api } from "./api-client.js";
import {
  buildErrorAdviceText,
  buildStandardActionPlan,
  buildStandardNextStepAdvice,
  buildStandardOperatorSummary,
} from "./operator-guidance.js";

// 标准评测新流程（2026-07 改造）：
//   ① 选择渠道后可多选模型，每个模型顺序（不并发）跑 快速测试(/api/tests/quick-verify，与「高级
//      测试 · 快速测试」页同一个接口) -> 10 轮稳定性 -> 标准准入（取代原场景测试）。
//   ② 勾选“这是 Claude 渠道”时，额外对 4 个固定新档位模型（claude-opus-4-6/4-7/4-8、claude-sonnet-4-6）
//      各跑一次快速准入——这些模型很可能还没在“模型管理”里登记，故用 channelId+model 的临时目标（不落库）。
// 不再走 /api/tasks 异步任务：三步都是同步接口，前端顺序 await 即可，进度按「模型 × 步骤」分组展示。
const STABILITY_ROUNDS = "10";
const CLAUDE_TIER_PROBE_MODELS = ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"];

export function createStandardEvalController({
  form,
  submitButton,
  plainResultElement,
  resultElement,
  nextActionsElement,
  progressElement,
  state,
  estimateCost,
  confirmRun,
  refreshResults,
  showPage,
  quickProfileSelect,
  stabilityProfileSelect,
  stabilityTemplate,
  applyStabilityTemplate,
  admissionChannelSelect,
  admissionProfileSelect,
  admissionPackageLevelSelect,
  updateEstimates,
  standardPicker,
}) {
  let running = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (running) return; // 防双击/确认框 await 期间重复提交（最贵流程，重复=重复扣额度）
    const profileIds = standardPicker.getSelectedIds();
    const channelId = standardPicker.getAnchorValue();
    const isClaudeChannel = form.elements["isClaudeChannel"].checked;
    const useAiReportAnalysis = form.elements.useAiReportAnalysis?.checked ? "1" : "";
    if (!profileIds.length) {
      toast("请先选择渠道下至少一个被测模型。", true);
      return;
    }
    const modelNames = profileIds.map((id) => findModelNameByTargetId(state, id));
    running = true;
    const estimate = estimateCost({ modelNames, isClaudeChannel: isClaudeChannel ? "1" : "", useAiReportAnalysis });
    if (!(await confirmRun("标准评测", estimate))) {
      running = false;
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "标准评测运行中...";
    renderStandardPlainPending(
      plainResultElement,
      "正在评测",
      "工具会依次对每个选中模型跑快速测试、稳定性和标准准入。请等待评测完成，不要关闭窗口。",
      "watch",
    );
    resultElement.textContent = "标准评测开始。请不要关闭窗口。";
    clearStandardNextActions(nextActionsElement);

    const modelTargets = profileIds.map((id, index) => ({ profileId: id, modelName: modelNames[index] }));
    const steps = buildStepPlan(modelTargets, { isClaudeChannel, claudeChannelId: channelId });
    renderStandardSteps(progressElement, steps);

    // runStandardEvaluation 内部逐组 try/catch，单个模型失败不会向外抛——多选模型时一个渠道/Key
    // 有问题不该拖累其它模型继续测。这里的 catch 只兜真正意外的异常（如渲染逻辑本身出错）。
    try {
      const perModelResults = await runStandardEvaluation({ steps, progressElement, useAiReportAnalysis });
      const primary = perModelResults.find((item) => !item.isTierProbe) || perModelResults[0];
      const standardResultText = formatStandardResult(perModelResults);
      renderStandardPlainResult({ ...primary, plainResultElement });
      resultElement.textContent = standardResultText;
      renderStandardNextActions({
        ...primary,
        profileId: primary?.profileId,
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
            admissionChannelSelect,
            admissionProfileSelect,
            admissionPackageLevelSelect,
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
        admission: null,
        profileId: profileIds[0],
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
            admissionChannelSelect,
            admissionProfileSelect,
            admissionPackageLevelSelect,
            updateEstimates,
          }),
      });
    } finally {
      running = false;
      submitButton.disabled = false;
      submitButton.textContent = "开始标准评测";
    }
  });
}

// 步骤计划：每个选中模型一组 {quick, stability, admission}；勾选 claude 时再各追加一个
// 「Claude 新档位快速准入」步骤（isTierProbe=true，target 为 {channelId, model} 临时目标）。
function buildStepPlan(modelTargets, { isClaudeChannel, claudeChannelId }) {
  const groups = modelTargets.map((target) => ({
    key: target.profileId,
    label: target.modelName || target.profileId,
    profileId: target.profileId,
    isTierProbe: false,
    steps: [
      { name: "quick", label: "快速测试" },
      { name: "stability", label: "稳定性测试（10 轮）" },
      { name: "admission", label: "标准准入" },
    ],
  }));
  if (isClaudeChannel && claudeChannelId) {
    for (const model of CLAUDE_TIER_PROBE_MODELS) {
      groups.push({
        key: `tier:${model}`,
        label: `${model}（新档位探测）`,
        isTierProbe: true,
        channelId: claudeChannelId,
        model,
        steps: [{ name: "admission-quick", label: "快速准入" }],
      });
    }
  }
  return groups;
}

// /api/tests/quick-verify（高级测试里的“快速测试”页调的同一个接口）返回的是一整套快检汇总
// （successRate/verdict/cases[]...），没有旧版 /api/tests/quick 那种单请求形状的 {success,
// statusCode,totalMs,responseSummary}。这里把它规整成后续代码（进度提示、报告文案、
// buildStandardOperatorSummary 等）期望的单请求形状，success 判定取「连通探针本身成功」——
// 标称冲突/指纹异常等属于“需要观察”而非“连不通”，不应该拦住后面的稳定性/准入测试。
export function normalizeQuickVerifyResult(result) {
  const connectivity = result?.cases?.find((c) => c.id === "connectivity");
  const success = Boolean(connectivity ? connectivity.passed : result?.successRate > 0);
  return {
    success,
    statusCode: connectivity?.statusCode ?? null,
    totalMs: connectivity?.totalMs ?? result?.avgTotalMs ?? null,
    responseSummary: success ? result?.verdict?.title || "连通成功" : null,
    normalizedError: success ? null : connectivity?.issue || result?.verdict?.reasons?.[0] || "快速测试失败。",
    raw: result,
  };
}

// 顺序跑完每一组（模型 / Claude 档位探测）。一个模型内部三步是串行的严格前置关系
// （快速测试没过就不跑稳定性/准入——继续跑只会白烧 token）；但一个模型的失败不应该
// 挡住其它模型继续测——多选模型时，个别模型 Key 有问题不该拖累整批，所以组间用
// try/catch 各自捕获错误，绝不把单组异常向外抛出中断整个循环。
async function runStandardEvaluation({ steps, progressElement, useAiReportAnalysis }) {
  const results = [];
  for (const group of steps) {
    if (group.isTierProbe) {
      results.push(await runTierProbeGroup(group, progressElement));
      continue;
    }
    results.push(await runModelGroup(group, progressElement, useAiReportAnalysis));
  }
  return results;
}

async function runTierProbeGroup(group, progressElement) {
  setStandardStep(progressElement, group.key, "admission-quick", "running", "正在执行快速准入探测。");
  try {
    const admission = await api("/api/tests/admission", {
      method: "POST",
      body: JSON.stringify({ channelId: group.channelId, model: group.model, packageLevel: "quick" }),
    });
    setStandardStep(
      progressElement,
      group.key,
      "admission-quick",
      "done",
      `快速准入完成：${admission.grade ? `等级 ${admission.grade}` : "已出结果"}，成功率 ${admission.successRateText || "-"}。`,
    );
    return { isTierProbe: true, model: group.model, admission };
  } catch (error) {
    setStandardStep(progressElement, group.key, "admission-quick", "failed", error.message || "快速准入探测失败。");
    return { isTierProbe: true, model: group.model, admission: null, error };
  }
}

async function runModelGroup(group, progressElement, useAiReportAnalysis) {
  const { profileId, label, key } = group;
  setStandardStep(progressElement, key, "quick", "running", "正在确认 API 是否能正常请求。");
  let quickVerify;
  try {
    quickVerify = await api("/api/tests/quick-verify", { method: "POST", body: JSON.stringify({ profileId }) });
  } catch (error) {
    setStandardStep(progressElement, key, "quick", "failed", error.message || "快速测试失败。");
    setStandardStep(progressElement, key, "stability", "skipped", "已跳过：快速测试未完成。");
    setStandardStep(progressElement, key, "admission", "skipped", "已跳过：快速测试未完成。");
    const quick = { success: false, normalizedError: error.normalizedError || error.message };
    return { isTierProbe: false, profileId, profileName: label, quick, stability: null, admission: null, error };
  }
  const quick = normalizeQuickVerifyResult(quickVerify);
  setStandardStep(
    progressElement,
    key,
    "quick",
    quick.success ? "done" : "failed",
    quick.success ? "快速测试成功。" : quick.normalizedError || "快速测试失败。",
  );
  if (!quick.success) {
    setStandardStep(progressElement, key, "stability", "skipped", "已跳过：快速测试未通过。");
    setStandardStep(progressElement, key, "admission", "skipped", "已跳过：快速测试未通过。");
    return { isTierProbe: false, profileId, profileName: label, quick, stability: null, admission: null };
  }

  setStandardStep(progressElement, key, "stability", "running", "正在执行 10 轮稳定性测试。");
  let stability;
  try {
    stability = await api("/api/tests/stability", {
      method: "POST",
      body: JSON.stringify({
        profileId,
        rounds: STABILITY_ROUNDS,
        concurrency: "1",
        prompt: [
          "请用中文完成一次稳定性测试回答：",
          "1. 用一句话说明你已正常响应。",
          "2. 用两条要点说明评估 AI API 稳定性应该关注哪些指标。",
          "3. 最后一行固定输出：测试完成。",
        ].join("\n"),
        useAiReportAnalysis,
      }),
    });
  } catch (error) {
    setStandardStep(progressElement, key, "stability", "failed", error.message || "稳定性测试失败。");
    setStandardStep(progressElement, key, "admission", "skipped", "已跳过：稳定性测试未完成。");
    return { isTierProbe: false, profileId, profileName: label, quick, stability: null, admission: null, error };
  }
  setStandardStep(
    progressElement,
    key,
    "stability",
    "done",
    `稳定性测试完成：成功率 ${stability.successRateText || "-"}，慢请求参考 ${stability.p95TotalMs ?? "-"} ms。`,
  );

  setStandardStep(progressElement, key, "admission", "running", "正在执行标准准入评测。");
  let admission;
  try {
    admission = await api("/api/tests/admission", {
      method: "POST",
      body: JSON.stringify({ profileId, packageLevel: "standard", useAiReportAnalysis }),
    });
  } catch (error) {
    setStandardStep(progressElement, key, "admission", "failed", error.message || "标准准入评测失败。");
    return { isTierProbe: false, profileId, profileName: label, quick, stability, admission: null, error };
  }
  setStandardStep(
    progressElement,
    key,
    "admission",
    "done",
    `标准准入完成：等级 ${admission.grade || "-"}，综合分 ${admission.score ?? "-"}。`,
  );

  return { isTierProbe: false, profileId, profileName: label, quick, stability, admission };
}

function findModelNameByTargetId(state, targetId) {
  return state.modelTargets?.find((t) => t.id === targetId)?.model || state.profiles?.find((p) => p.id === targetId)?.defaultModel || "";
}

function renderStandardPlainPending(plainResultElement, title, detail, level) {
  plainResultElement.className = `plain-result-card ${level}-card`;
  plainResultElement.innerHTML = `
    <span>人话结论</span>
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(detail)}</p>
  `;
}

function renderStandardPlainResult({ quick, stability, admission, plainResultElement }) {
  const summary = buildStandardOperatorSummary({ quick, stability, admission });
  renderStandardPlainPending(plainResultElement, summary.title, summary.detail, summary.level);
}

function renderStandardSteps(progressElement, groups) {
  progressElement.innerHTML = groups
    .map(
      (group) => `
      <article class="flow-model-group" data-standard-group="${escapeHtml(group.key)}">
        <h4>${escapeHtml(group.label)}</h4>
        <div class="standard-flow">
          ${group.steps
            .map(
              (step) => `
              <article class="flow-step" data-standard-step="${escapeHtml(step.name)}">
                <span></span>
                <strong>${escapeHtml(step.label)}</strong>
                <small>等待开始。</small>
              </article>`,
            )
            .join("")}
        </div>
      </article>`,
    )
    .join("");
}

function setStandardStep(progressElement, groupKey, stepName, status, message) {
  const group = progressElement.querySelector(`[data-standard-group="${cssEscape(groupKey)}"]`);
  const step = group?.querySelector(`[data-standard-step="${stepName}"]`);
  if (!step) return;
  step.classList.remove("running", "done", "failed", "skipped");
  step.classList.add(status);
  step.querySelector("small").textContent = message;
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function clearStandardNextActions(nextActionsElement) {
  nextActionsElement.classList.add("hidden");
  nextActionsElement.innerHTML = "";
}

function renderStandardNextActions({ quick, stability, admission, profileId, nextActionsElement, runAction }) {
  const summary = buildStandardOperatorSummary({ quick, stability, admission });
  const actions = buildStandardActionPlan({ quick, stability, admission });
  nextActionsElement.classList.remove("hidden");
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
  admissionChannelSelect,
  admissionProfileSelect,
  admissionPackageLevelSelect,
  updateEstimates,
}) {
  if (action === "profile-config") {
    showPage("channels");
    return;
  }
  if (action === "quick-retry") {
    if (profileId) quickProfileSelect.value = profileId;
    showPage("quick-test");
    return;
  }
  if (action === "stability-candidate" || action === "stability-smoke") {
    if (profileId) stabilityProfileSelect.value = profileId;
    stabilityTemplate.value = action === "stability-candidate" ? "candidate" : "smoke";
    applyStabilityTemplate();
    showPage("stability-test");
    return;
  }
  if (action === "admission-deep") {
    if (profileId) admissionChannelSelect.setValue(profileId);
    admissionPackageLevelSelect.value = "deep";
    updateEstimates?.();
    showPage("admission-test");
    return;
  }
  showPage(action === "handoff" ? "handoff" : "reports");
}

function formatStandardResult(perModelResults) {
  const lines = ["# 标准评测结果", ""];
  for (const item of perModelResults) {
    if (item.isTierProbe) {
      lines.push(`## Claude 新档位快速准入：${item.model}`, "");
      if (item.error) {
        lines.push(`- 结果：失败（${item.error.message || "-"}）`, "");
        continue;
      }
      lines.push(
        `- 等级：${item.admission?.grade || "-"}`,
        `- 成功率：${item.admission?.successRateText || "-"}`,
        `- 报告：${item.admission?.reportPath || "-"}`,
        "",
      );
      continue;
    }
    const { profileName, quick, stability, admission, error } = item;
    lines.push(`## ${profileName}`, "", "### 快速测试", "");
    if (!quick) {
      lines.push(`- 结果：失败（${error?.message || "-"}）`, "");
      continue;
    }
    lines.push(
      `- 结果：${quick.success ? "成功" : "失败"}`,
      `- 请求状态：${quick.statusCode ?? "-"}`,
      `- 总耗时：${quick.totalMs ?? "-"} ms`,
      `- 摘要：${quick.responseSummary || quick.normalizedError || "-"}`,
      "",
    );
    if (!stability) {
      lines.push("### 稳定性测试（10 轮）", "", `- 已跳过（${error?.message || "快速测试未通过"}）`, "");
      continue;
    }
    lines.push(
      "### 稳定性测试（10 轮）",
      "",
      `- 成功率：${stability.successRateText || "-"}`,
      `- 平均耗时：${stability.avgTotalMs || "-"} ms`,
      `- 慢请求参考：${stability.p95TotalMs ?? "-"} ms`,
      `- 结论：${stability.recommendation?.title || "-"}`,
      `- 报告：${stability.reportPath || "-"}`,
      "",
    );
    if (!admission) {
      lines.push("### 标准准入", "", `- 已跳过或失败（${error?.message || "-"}）`, "");
      continue;
    }
    lines.push(
      "### 标准准入",
      "",
      `- 等级：${admission.grade || "-"}`,
      `- 综合分：${admission.score ?? "-"}`,
      `- 报告：${admission.reportPath || "-"}`,
      "",
    );
    const nextSteps = buildStandardNextStepAdvice({ quick, stability, admission });
    lines.push("### 下一步建议", "", ...nextSteps.map((step) => `- ${step}`), "");
  }
  return lines.join("\n");
}
