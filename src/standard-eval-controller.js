import { escapeHtml, toast } from "./client-utils.js";
import { cancelRemoteTask, runRemoteTask } from "./api-client.js";
import {
  buildErrorAdviceText,
  buildStandardActionPlan,
  buildStandardNextStepAdvice,
  buildStandardOperatorSummary,
} from "./operator-guidance.js";
import { getPromptPreset } from "./prompt-presets.js";

// 标准评测新流程（2026-08 改造：改回后台异步任务）：
//   ① 选择渠道后可多选模型，每个模型顺序（不并发）跑 快速测试 -> 稳定性（3 组预设文案各 3 遍，
//      共 9 轮）-> 标准准入。
//   ② 勾选"这是 Claude 渠道"时，额外对 4 个固定新档位模型各跑一次快速准入——这些模型很可能还没在
//      "模型管理"里登记，故用 channelId+model 的临时目标（不落库）。
//
// 【为什么改回 /api/tasks】v0.7.3 曾把三步改成前端顺序 await 三个同步接口。那样做有三个问题：
//   ① 关页面 / 刷新 / 断线 = 结果全丢，但请求已发出、额度已扣；
//   ② 同步端点【不占】task-manager 的全局并发槽，多人同时点会直接压满宿主与目标渠道；
//   ③ 9 轮稳定性 + 11~12 次准入塞在一个 HTTP 请求里，任何代理超时都会让前端报失败而后端仍在跑、
//      仍在计费——这正是 runRemoteTask 容忍 5 次轮询失败所要防的双花，而同步路径享受不到。
// 现在前端只提交"测哪些模型"，执行顺序、跳过策略、达标判定全部由服务端
// （server/admission-suite.mjs + server/admission-policy.mjs）决定，前端按轮询到的
// task.steps 重绘「模型 × 步骤」网格。
const STANDARD_STABILITY_PRESET_IDS = ["basic", "structured-json", "coding"];
const STANDARD_STABILITY_REPEATS_PER_GROUP = 3;
const STANDARD_STABILITY_TOTAL_ROUNDS = STANDARD_STABILITY_PRESET_IDS.length * STANDARD_STABILITY_REPEATS_PER_GROUP;
const CLAUDE_TIER_PROBE_MODELS = ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"];

// 标准评测固定用 3 组预设文案（基础稳定性 + 结构化输出 + 编程场景），各测
// STANDARD_STABILITY_REPEATS_PER_GROUP 遍，共 STANDARD_STABILITY_TOTAL_ROUNDS 轮。
// 文案随 payload 一起提交给后端：预设文本在 src/prompt-presets.js，而后端【不得】import src/
// （生产镜像不打包 src/，见 tests/no-backend-src-import.test.mjs）。这与「稳定性测试」页调
// /api/tests/stability 的既有契约一致，不是新增的信任边界。
function buildStandardStabilityGroups() {
  return STANDARD_STABILITY_PRESET_IDS.map((presetId) => {
    const preset = getPromptPreset("stability", presetId);
    return { presetId, prompt: preset.prompt, repeats: STANDARD_STABILITY_REPEATS_PER_GROUP };
  });
}

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
  applyStabilityGroupPreset,
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
      "工具会依次对每个选中模型跑快速测试、稳定性和标准准入。评测在后台运行，可以随时来这个页面查看进度。",
      "watch",
    );
    resultElement.textContent = "标准评测已提交到后台任务队列。";
    clearStandardNextActions(nextActionsElement);

    // 网格【不再】由前端预排：步骤计划归服务端所有（server/admission-suite.mjs 的 buildSuitePlan），
    // 前端预排一份只会在两边口径漂移时显示一份假计划。首次轮询（≤900ms）就会画出真计划。
    renderStandardStepsPlaceholder(progressElement);

    try {
      const result = await runRemoteTask(
        state,
        "standardEval",
        "admission-suite",
        {
          profileIds,
          modelNames,
          groups: buildStandardStabilityGroups(),
          claudeChannelId: isClaudeChannel ? channelId : "",
          tierProbeModels: isClaudeChannel ? CLAUDE_TIER_PROBE_MODELS : [],
          useAiReportAnalysis,
        },
        taskProgressElement,
        { onProgress: (task) => renderStandardStepsFromTask(progressElement, task) },
      );

      const perModelResults = result?.models || [];
      // 「人话结论」直接用服务端 aggregateSuite 的整体结论——它覆盖【全部】必选模型。
      // 旧代码用 perModelResults.find(...) 取第一个模型的结论冒充整体结论，2 个模型只要
      // 第一个过就整体显示通过（ADM-006）。判定口径只保留服务端一处，前端不再自己算。
      renderStandardConclusion(plainResultElement, result);
      resultElement.textContent = formatStandardResult(result);
      const primary = perModelResults.find((item) => !item.isTierProbe) || perModelResults[0];
      renderStandardNextActions({
        ...adaptModelResult(primary),
        profileId: primary?.profileId,
        nextActionsElement,
        runAction: (action, profileId) =>
          runStandardNextAction({
            action,
            profileId,
            showPage,
            quickProfileSelect,
            stabilityProfileSelect,
            applyStabilityGroupPreset,
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
            applyStabilityGroupPreset,
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

export function cancelStandardEval(state) {
  return cancelRemoteTask(state, "standardEval");
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

// 把服务端 models[] 里的一条整成「下一步建议」那套函数期望的形状。
// 注意任务快照里的 quick 已经被 stripHeavy 去掉了 cases[]（每 900ms 轮询一次，不能塞原始响应体），
// 所以 normalizeQuickVerifyResult 会走 successRate 兜底分支——这正是它保留兜底的原因。
function adaptModelResult(model) {
  if (!model) return { quick: null, stability: null, admission: null };
  return {
    quick: model.quick ? normalizeQuickVerifyResult(model.quick) : { success: false, normalizedError: model.error || "快速测试未完成。" },
    stability: model.stability || null,
    admission: model.admission || null,
  };
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

// 四态结论（server/admission-policy.mjs 的 CONCLUSION）→ 人话卡片。
// 这里【只做展示映射】，不重新判定：判定口径全在服务端一处，前端再算一遍必然漂移。
// indeterminate 单列一档：它表示"我们没测成"（平台/网络问题），与"测了没过"是两回事，
// 混成失败会让用户去改一个本来没问题的渠道配置。
const CONCLUSION_CARDS = {
  accepted: { level: "pass", title: "全部被测模型通过标准准入" },
  accepted_with_conditions: { level: "watch", title: "有条件通过，需人工复核后再开放" },
  rejected: { level: "fail", title: "未通过标准准入，暂不建议开放" },
  indeterminate: { level: "watch", title: "结论不确定：本次没有测完" },
};

function renderStandardConclusion(plainResultElement, result) {
  const card = CONCLUSION_CARDS[result?.conclusion] || CONCLUSION_CARDS.indeterminate;
  const reasons = Array.isArray(result?.conclusionReasons) ? result.conclusionReasons.filter(Boolean) : [];
  const detail = reasons.length ? reasons.join(" ") : "详见下方分模型明细与报告中心。";
  renderStandardPlainPending(plainResultElement, card.title, detail, card.level);
}

// 任务刚创建时还没有 steps 快照（可能正在排队）。先占位，等第一次轮询拿到服务端计划再画真网格。
function renderStandardStepsPlaceholder(progressElement) {
  progressElement.innerHTML = `<p class="muted">任务已提交，正在等待执行计划…</p>`;
}

// 每次轮询都按 task.steps 重绘网格。服务端是计划与状态的唯一权威：刷新页面、换台机器打开，
// 看到的进度都一样——这正是改回异步任务要拿到的东西。
function renderStandardStepsFromTask(progressElement, task) {
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  if (!steps.length) return; // 保留占位符，别把已经画好的网格擦成空白
  const groups = [];
  const byKey = new Map();
  for (const step of steps) {
    let group = byKey.get(step.groupKey);
    if (!group) {
      group = { key: step.groupKey, label: step.groupLabel, steps: [] };
      byKey.set(step.groupKey, group);
      groups.push(group);
    }
    group.steps.push(step);
  }
  progressElement.innerHTML = groups
    .map(
      (group) => `
      <article class="flow-model-group" data-standard-group="${escapeHtml(group.key)}">
        <h4>${escapeHtml(group.label)}</h4>
        <div class="standard-flow">
          ${group.steps
            .map(
              (step) => `
              <article class="flow-step ${stepStatusClass(step)}" data-standard-step="${escapeHtml(step.stepName)}">
                <span></span>
                <strong>${escapeHtml(step.stepLabel)}</strong>
                <small>${escapeHtml(step.summary || "等待开始。")}</small>
              </article>`,
            )
            .join("")}
        </div>
      </article>`,
    )
    .join("");
}

// executionStatus（跑没跑完）与 verdict（达没达标）是两个正交字段，样式必须同时看两者：
// 只看 executionStatus 会把"跑完了但没通过"画成绿勾（v0.7.3 的原始 bug）；
// 只看 verdict 会把"平台自己出错"和"渠道不达标"画成同一种失败，误导用户去改配置。
function stepStatusClass(step) {
  if (step.executionStatus === "running") return "running";
  if (step.executionStatus === "skipped") return "skipped";
  if (step.executionStatus === "failed" || step.executionStatus === "cancelled") return "failed";
  if (step.executionStatus !== "completed") return "";
  if (step.verdict === "not_passed") return "failed";
  if (step.verdict === "warning" || step.verdict === "indeterminate") return "warn";
  return "done";
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
  applyStabilityGroupPreset,
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
    applyStabilityGroupPreset({ basic: action === "stability-candidate" ? 30 : 3 });
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

// result 是服务端 admission-suite 的返回：{conclusion, conclusionReasons, steps[], models[], reports[]}。
// models[].quick/stability/admission 都经过 stripHeavy（去掉了 cases/records/reportMarkdown），
// 这里只用汇总字段，不要指望能拿到逐条明细——那些在报告里。
function formatStandardResult(result) {
  const perModelResults = result?.models || [];
  const card = CONCLUSION_CARDS[result?.conclusion] || CONCLUSION_CARDS.indeterminate;
  const lines = [
    "# 标准评测结果",
    "",
    `- 整体结论：${card.title}（${result?.conclusion || "indeterminate"}）`,
    `- 判定口径版本：${result?.policyVersion || "-"}`,
    ...(result?.conclusionReasons?.length ? result.conclusionReasons.map((reason) => `- ${reason}`) : []),
    "",
  ];
  for (const item of perModelResults) {
    if (item.isTierProbe) {
      lines.push(`## Claude 新档位快速准入：${item.model}`, "");
      if (item.error) {
        lines.push(`- 结果：失败（${item.error}）`, "");
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
    const { profileName, stability, admission, error } = item;
    const quick = item.quick ? normalizeQuickVerifyResult(item.quick) : null;
    lines.push(`## ${profileName}`, "", `- 本模型结论：${item.conclusion || "-"}`, ...(item.reasons || []).map((r) => `- ${r}`), "");
    lines.push("### 快速测试", "");
    if (!quick) {
      lines.push(`- 结果：失败（${error || "-"}）`, "");
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
      lines.push(
        `### 稳定性测试（3 组 × 3 轮 = ${STANDARD_STABILITY_TOTAL_ROUNDS} 轮）`,
        "",
        `- 已跳过（${error || "快速测试未通过"}）`,
        "",
      );
      continue;
    }
    lines.push(
      `### 稳定性测试（3 组 × 3 轮 = ${STANDARD_STABILITY_TOTAL_ROUNDS} 轮）`,
      "",
      `- 成功率：${stability.successRateText || "-"}`,
      `- 平均耗时：${stability.avgTotalMs || "-"} ms`,
      `- 慢请求参考：${stability.p95TotalMs ?? "-"} ms`,
      `- 结论：${stability.recommendation?.title || "-"}`,
      `- 报告：${stability.reportPath || "-"}`,
      "",
    );
    if (!admission) {
      lines.push("### 标准准入", "", `- 已跳过或失败（${error || "-"}）`, "");
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
