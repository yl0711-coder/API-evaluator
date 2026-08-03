// server/admission-suite.mjs
// 一键准入复合任务的服务端编排器（PRD 6、方案 §7）。
//
// 【为什么要有这个模块】v0.7.3 的标准评测是【前端】顺序 await 三个同步接口
// （/api/tests/quick-verify → /api/tests/stability → /api/tests/admission）。这带来三个问题，
// 前两个 PRD 已述，第三个是实测才看得出的：
//   ① 关页面 / 刷新 / 断线 = 整批结果丢失，但请求已经发出去、额度已经扣了；
//   ② 「执行完成」和「达标」混在一起，前端拿 HTTP 200 就画绿勾；
//   ③ 【绕过了全局并发闸】——task-manager 的槽位只管 /api/tasks 那条路，同步端点不占槽、不排队，
//      多人同时点标准评测会直接压满宿主与目标渠道；且 9 轮稳定性 + 11~12 次准入塞在一个 HTTP
//      请求里，中间任何代理超时都会让前端报失败而后端仍在跑、仍在计费，诱发用户重跑 = 双花。
// 改成后台复合任务后，这三点一起解决：占一个槽、可取消、可轮询、前端不再承担编排。
//
// 【为什么直接调 runner 而不发 HTTP】auto-test-scheduler.mjs 已经是这个做法（它在服务端直接调
// runQuickVerify / runStabilityTest / runAdmissionTest 跑无人值守测试）。绕回自己的 HTTP 端点
// 只会多一层序列化、多一处鉴权分叉，还会让取消信号（taskContext）传不进去。
//
// 【判定与执行分离】本模块只负责"按顺序跑、把结果存下来、该停就停"，达没达标一律问
// admission-policy.mjs。执行状态（executionStatus）与业务裁决（verdict）是两个正交字段，
// 任何异常都不得把 failed 写成 passed。
import { assertTaskNotCancelled, updateTaskProgress } from "./task-manager.mjs";
import { buildSuitePlan, countSuiteUnits } from "./admission-suite-plan.mjs";
import {
  ADMISSION_POLICY_VERSION,
  CONCLUSION,
  VERDICT,
  aggregateModel,
  aggregateSuite,
  evaluateQuick,
  evaluateStability,
} from "./admission-policy.mjs";

// 计划在 admission-suite-plan.mjs（零依赖，为断开与 task-manager 的 import 环）。
// 这里转出去，调用方（含测试）只认 admission-suite.mjs 一个入口。
export { buildSuitePlan, countSuiteUnits };

// 步骤执行状态（与 verdict 正交，见方案 §4.1）。
export const EXECUTION_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
  CANCELLED: "cancelled",
};

// 稳定性冒烟的默认分组：3 组预设文案 × 3 遍 = 9 轮，与 STABILITY_SMOKE_TOTAL_ROUNDS 对齐。
// 文案本身由前端在 payload.groups 里带上——预设文本在 src/prompt-presets.js，而后端【不得】
// import src/（生产镜像不打包 src/，引用会启动崩溃，见 tests/no-backend-src-import.test.mjs）。
// 这与现有 /api/tests/stability 的契约一致（groups 一直是客户端传的），不是新增的信任边界。
// 前端没传时用下面的兜底文案，保证服务端单独也能跑（自动化测试、将来的定时准入）。
const FALLBACK_STABILITY_GROUPS = [
  { presetId: "basic", prompt: "请用一句中文说明你已正常响应，最后一行固定输出：测试完成。", repeats: 3 },
  { presetId: "structured-json", prompt: "请只输出 JSON，不要输出 Markdown。字段包含 summary、riskLevel。", repeats: 3 },
  { presetId: "coding", prompt: "请说明 fetch 未 await 会导致什么问题，并给出修复思路。", repeats: 3 },
];

/**
 * 编排器工厂。runner 全部注入，便于用假 runner 做集成测试
 * （证明"硬门槛未通过后不再有 runner 调用"这类断言，不需要真发请求）。
 */
export function createAdmissionSuiteRunner({ runQuickVerify, runStabilityTest, runAdmissionTest }) {
  return async function runAdmissionSuite(payload = {}, taskContext = {}) {
    const plan = buildSuitePlan(payload);
    if (!plan.length) {
      throw new Error("请至少选择一个被测模型。");
    }

    const totalUnits = plan.reduce((sum, group) => sum + group.steps.length, 0);
    // 步骤快照挂在 task 上，前端轮询 /api/tasks/:id 时按它重绘「模型 × 步骤」进度网格。
    const steps = [];
    for (const group of plan) {
      for (const step of group.steps) {
        steps.push({
          groupKey: group.key,
          groupLabel: group.label,
          stepName: step.name,
          stepLabel: step.label,
          isTierProbe: group.isTierProbe,
          executionStatus: EXECUTION_STATUS.PENDING,
          verdict: null,
          summary: "等待执行。",
        });
      }
    }
    if (taskContext.task) taskContext.task.steps = steps;

    let completed = 0;
    const find = (groupKey, stepName) => steps.find((item) => item.groupKey === groupKey && item.stepName === stepName);
    function mark(groupKey, stepName, patch) {
      const step = find(groupKey, stepName);
      if (step) Object.assign(step, patch);
    }
    function advance(groupKey, message) {
      completed += 1;
      updateTaskProgress(taskContext, completed, totalUnits, message || `已完成 ${completed}/${totalUnits} 个步骤。`);
    }
    // 未执行的步骤统一标 skipped 并记原因——PRD 12.1 要求"已跳过项目及跳过原因"可见，
    // 而且必须与"跑了但没过"区分：跳过不是失败，是我们主动没花这笔钱。
    function skipRest(group, fromIndex, reason) {
      for (let i = fromIndex; i < group.steps.length; i += 1) {
        mark(group.key, group.steps[i].name, {
          executionStatus: EXECUTION_STATUS.SKIPPED,
          verdict: VERDICT.NOT_APPLICABLE,
          summary: `已跳过：${reason}`,
        });
        advance(group.key);
      }
    }

    const modelResults = [];
    for (const group of plan) {
      assertTaskNotCancelled(taskContext);
      if (group.isTierProbe) {
        modelResults.push(await runTierProbe(group));
        continue;
      }
      modelResults.push(await runModel(group));
    }

    // 整体结论必须覆盖【全部必选模型】（PRD 8.2）。档位探测是观察项，optional:true，不参与。
    const suite = aggregateSuite(
      modelResults.map((item) => ({
        model: item.model || item.profileName || item.profileId,
        profileId: item.profileId,
        conclusion: item.conclusion,
        optional: item.isTierProbe === true,
      })),
    );

    return {
      type: "admission-suite",
      policyVersion: ADMISSION_POLICY_VERSION,
      conclusion: suite.conclusion,
      conclusionReasons: suite.reasons,
      steps,
      models: modelResults,
      // 逐篇报告清单：任务完成时供桌面端逐篇打开、前端浮层按 id 弹出。
      reports: modelResults.flatMap((item) => item.reports || []),
    };

    // ── 单模型：快速 → 稳定性 → 标准准入，严格串行，前一步未通过即停止后续请求 ──
    async function runModel(group) {
      const { key, label, profileId } = group;
      const stepDecisions = [];
      const result = {
        isTierProbe: false,
        profileId,
        profileName: label,
        quick: null,
        stability: null,
        admission: null,
        reports: [],
      };

      // ① 快速测试
      assertTaskNotCancelled(taskContext);
      mark(key, "quick", { executionStatus: EXECUTION_STATUS.RUNNING, summary: "正在确认 API 是否能正常请求。" });
      let quick;
      try {
        quick = await runQuickVerify({ profileId }, taskContext);
      } catch (error) {
        // 平台/网络异常 → failed + indeterminate，绝不写成 not_passed：我们没测成，
        // 不等于渠道不行。后续步骤跳过，避免在配置明显有问题时继续烧额度。
        mark(key, "quick", {
          executionStatus: EXECUTION_STATUS.FAILED,
          verdict: VERDICT.INDETERMINATE,
          summary: `执行失败：${error?.message || "快速测试未能完成"}`,
        });
        advance(key);
        skipRest(group, 1, "快速测试未完成。");
        result.error = String(error?.message || error);
        result.conclusion = CONCLUSION.INDETERMINATE;
        return result;
      }
      result.quick = stripHeavy(quick);
      const quickDecision = evaluateQuick(quick);
      stepDecisions.push(quickDecision);
      mark(key, "quick", {
        executionStatus: EXECUTION_STATUS.COMPLETED,
        verdict: quickDecision.verdict,
        summary: quickDecision.summary,
      });
      advance(key, "快速测试完成。");
      if (quickDecision.verdict === VERDICT.NOT_PASSED) {
        skipRest(group, 1, "快速测试未通过，停止后续请求。");
        result.conclusion = aggregateModel(stepDecisions).conclusion;
        result.reasons = aggregateModel(stepDecisions).reasons;
        return result;
      }

      // ② 稳定性冒烟（9 轮）
      assertTaskNotCancelled(taskContext);
      mark(key, "stability", { executionStatus: EXECUTION_STATUS.RUNNING, summary: "正在执行稳定性测试（9 轮）。" });
      let stability;
      try {
        stability = await runStabilityTest(
          {
            profileId,
            concurrency: "1",
            groups: normalizeStabilityGroups(payload.groups),
            useAiReportAnalysis: payload.useAiReportAnalysis || "",
          },
          taskContext,
        );
      } catch (error) {
        mark(key, "stability", {
          executionStatus: EXECUTION_STATUS.FAILED,
          verdict: VERDICT.INDETERMINATE,
          summary: `执行失败：${error?.message || "稳定性测试未能完成"}`,
        });
        advance(key);
        skipRest(group, 2, "稳定性测试未完成。");
        result.error = String(error?.message || error);
        result.conclusion = CONCLUSION.INDETERMINATE;
        return result;
      }
      result.stability = stripHeavy(stability);
      collectReport(result, stability, label);
      const stabilityDecision = evaluateStability(toStabilityInput(stability));
      stepDecisions.push(stabilityDecision);
      mark(key, "stability", {
        executionStatus: EXECUTION_STATUS.COMPLETED,
        verdict: stabilityDecision.verdict,
        summary: stabilityDecision.summary,
      });
      advance(key, "稳定性测试完成。");
      if (stabilityDecision.verdict === VERDICT.NOT_PASSED || stabilityDecision.verdict === VERDICT.INDETERMINATE) {
        skipRest(group, 2, "稳定性未达标，停止后续请求。");
        const agg = aggregateModel(stepDecisions);
        result.conclusion = agg.conclusion;
        result.reasons = agg.reasons;
        return result;
      }

      // ③ 标准准入
      assertTaskNotCancelled(taskContext);
      mark(key, "admission", { executionStatus: EXECUTION_STATUS.RUNNING, summary: "正在执行标准准入评测。" });
      let admission;
      try {
        admission = await runAdmissionTest(
          { profileId, packageLevel: "standard", useAiReportAnalysis: payload.useAiReportAnalysis || "" },
          taskContext,
        );
      } catch (error) {
        mark(key, "admission", {
          executionStatus: EXECUTION_STATUS.FAILED,
          verdict: VERDICT.INDETERMINATE,
          summary: `执行失败：${error?.message || "标准准入未能完成"}`,
        });
        advance(key);
        result.error = String(error?.message || error);
        result.conclusion = CONCLUSION.INDETERMINATE;
        return result;
      }
      result.admission = stripHeavy(admission);
      collectReport(result, admission, label);
      // 准入的 verdict 由 buildAdmissionSummary 在算分时就地产出（阶段 1 已接好），
      // 这里直接用，不重复评一遍——重复评容易在两处口径之间产生分歧。
      const admissionDecision = admission?.verdict || {
        verdict: VERDICT.INDETERMINATE,
        summary: "准入结果缺少判定字段。",
      };
      stepDecisions.push(admissionDecision);
      mark(key, "admission", {
        executionStatus: EXECUTION_STATUS.COMPLETED,
        verdict: admissionDecision.verdict,
        summary: admissionDecision.summary,
      });
      advance(key, "标准准入完成。");

      const agg = aggregateModel(stepDecisions);
      result.conclusion = agg.conclusion;
      result.reasons = agg.reasons;
      return result;
    }

    // ── Claude 新档位探测：非阻断观察项，失败只标"观察项执行失败"，不改主结论（PRD 7.7）──
    async function runTierProbe(group) {
      mark(group.key, "admission-quick", { executionStatus: EXECUTION_STATUS.RUNNING, summary: "正在执行快速准入探测。" });
      try {
        const admission = await runAdmissionTest({ channelId: group.channelId, model: group.model, packageLevel: "quick" }, taskContext);
        mark(group.key, "admission-quick", {
          executionStatus: EXECUTION_STATUS.COMPLETED,
          verdict: admission?.verdict?.verdict || null,
          summary: `观察项：快速准入完成，等级 ${admission?.grade || "-"}，成功率 ${admission?.successRateText || "-"}。`,
        });
        advance(group.key, "档位探测完成。");
        const result = { isTierProbe: true, model: group.model, admission: stripHeavy(admission), reports: [] };
        collectReport(result, admission, group.model);
        return result;
      } catch (error) {
        mark(group.key, "admission-quick", {
          executionStatus: EXECUTION_STATUS.FAILED,
          verdict: VERDICT.INDETERMINATE,
          summary: `观察项执行失败：${error?.message || "档位探测未能完成"}`,
        });
        advance(group.key);
        return { isTierProbe: true, model: group.model, admission: null, error: String(error?.message || error), reports: [] };
      }
    }
  };
}

// evaluateStability 要的是 requestCount，而 buildStabilitySummary 给的是 successCount/failureCount。
// 用 rounds 会在"某轮根本没发出去"时虚高分母，所以按实际记录数相加。
function toStabilityInput(summary) {
  if (!summary) return null;
  const successCount = Number(summary.successCount) || 0;
  const failureCount = Number(summary.failureCount) || 0;
  return {
    requestCount: successCount + failureCount,
    successRate: summary.successRate,
    p95TotalMs: summary.p95TotalMs,
    errorCounts: summary.errorCounts,
    firstAttemptSuccessRate: summary.firstAttemptSuccessRate ?? null,
  };
}

// 稳定性分组：前端不传时用兜底文案。repeats 夹到 1~20，与 /api/tests/stability 同口径。
function normalizeStabilityGroups(groups) {
  if (!Array.isArray(groups) || !groups.length) return FALLBACK_STABILITY_GROUPS;
  return groups
    .filter((group) => group && String(group.prompt || "").trim())
    .map((group) => ({
      presetId: group.presetId || "custom",
      prompt: String(group.prompt),
      repeats: Math.max(1, Math.min(20, Math.round(Number(group.repeats)) || 1)),
    }));
}

// 任务快照要能被前端轮询反复拉取，不能塞完整响应体和 Markdown 全文。
function stripHeavy(result) {
  if (!result || typeof result !== "object") return result;
  const { reportMarkdown, records, results, cases, ...rest } = result;
  return rest;
}

function collectReport(target, result, label) {
  if (!result?.reportHtmlPath) return;
  target.reports.push({
    profileName: label,
    model: result.model || label,
    reportHtmlPath: result.reportHtmlPath,
    aiAnalysisHtmlPath: result.aiAnalysisHtmlPath || null,
  });
}
