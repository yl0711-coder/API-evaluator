// tests/admission-suite.test.mjs
// 阶段 2 的核心断言：编排器【不发请求】就能证明它在该停的时候停了。
// 全部 runner 都是假的，用调用序列（calls 数组）来证明"零额外请求"这类花钱的性质——
// 这正是把编排从前端搬到服务端、并把判定抽成纯函数之后才做得到的事。
import assert from "node:assert/strict";
import test from "node:test";
import { CONCLUSION, STABILITY_SMOKE_TOTAL_ROUNDS, VERDICT } from "../server/admission-policy.mjs";
import { EXECUTION_STATUS, buildSuitePlan, countSuiteUnits, createAdmissionSuiteRunner } from "../server/admission-suite.mjs";

// ── 假 runner 的返回样板 ──────────────────────────────────────────────────────
const okQuick = { cases: [{ id: "connectivity", passed: true }], successRate: 1 };
const badQuick = { cases: [{ id: "connectivity", passed: false, issue: "401 未授权" }], successRate: 0 };
const okStability = {
  successCount: STABILITY_SMOKE_TOTAL_ROUNDS,
  failureCount: 0,
  successRate: 1,
  p95TotalMs: 8000,
  errorCounts: {},
  firstAttemptSuccessRate: 1,
};
const badStability = {
  successCount: STABILITY_SMOKE_TOTAL_ROUNDS - 1,
  failureCount: 1,
  successRate: (STABILITY_SMOKE_TOTAL_ROUNDS - 1) / STABILITY_SMOKE_TOTAL_ROUNDS,
  p95TotalMs: 8000,
  errorCounts: { upstream_5xx: 1 },
  firstAttemptSuccessRate: null,
};
const okAdmission = { score: 92, grade: "A", verdict: { verdict: VERDICT.PASSED, blocking: true, summary: "硬门槛全部通过。" } };
const gateFailedAdmission = {
  score: 95,
  grade: "A",
  verdict: { verdict: VERDICT.NOT_PASSED, blocking: true, summary: "硬门槛未通过：tool_call。" },
};

// 记录每次 runner 调用，供"零额外请求"断言。
function makeRunners({ quick = okQuick, stability = okStability, admission = okAdmission } = {}) {
  const calls = [];
  const resolve = (value, args) => (typeof value === "function" ? value(args) : value);
  return {
    calls,
    runQuickVerify: async (args) => {
      calls.push(`quick:${args.profileId}`);
      return resolve(quick, args);
    },
    runStabilityTest: async (args) => {
      calls.push(`stability:${args.profileId}`);
      return resolve(stability, args);
    },
    runAdmissionTest: async (args) => {
      calls.push(`admission:${args.profileId || args.model}`);
      return resolve(admission, args);
    },
  };
}

const taskContextFor = (task = {}) => ({ task: { status: "running", completedUnits: 0, totalUnits: 1, ...task } });

// ── 计划与进度单元 ────────────────────────────────────────────────────────────

test("buildSuitePlan: 每个必选模型 3 步，档位探针各 1 步", () => {
  const plan = buildSuitePlan({
    profileIds: ["p1", "p2"],
    claudeChannelId: "ch1",
    tierProbeModels: ["claude-opus-4-8"],
  });
  assert.equal(plan.length, 3);
  assert.deepEqual(
    plan.map((g) => g.steps.length),
    [3, 3, 1],
  );
  assert.equal(plan[2].isTierProbe, true);
  assert.equal(countSuiteUnits({ profileIds: ["p1", "p2"], claudeChannelId: "ch1", tierProbeModels: ["claude-opus-4-8"] }), 7);
});

test("buildSuitePlan: 没有 claudeChannelId 时不排档位探针（没渠道就发不出请求）", () => {
  const plan = buildSuitePlan({ profileIds: ["p1"], tierProbeModels: ["claude-opus-4-8"] });
  assert.equal(plan.length, 1);
});

// ── ① 硬门槛未通过后不得再发任何请求（花钱的性质） ──────────────────────────

test("快速测试未通过 → 不再调用稳定性与准入 runner，且剩余步骤标 skipped", async () => {
  const runners = makeRunners({ quick: badQuick });
  const run = createAdmissionSuiteRunner(runners);
  const result = await run({ profileIds: ["p1"] }, taskContextFor());

  assert.deepEqual(runners.calls, ["quick:p1"]);
  assert.equal(result.conclusion, CONCLUSION.REJECTED);
  const [quickStep, stabilityStep, admissionStep] = result.steps;
  assert.equal(quickStep.executionStatus, EXECUTION_STATUS.COMPLETED);
  assert.equal(quickStep.verdict, VERDICT.NOT_PASSED);
  assert.equal(stabilityStep.executionStatus, EXECUTION_STATUS.SKIPPED);
  assert.equal(admissionStep.executionStatus, EXECUTION_STATUS.SKIPPED);
  // 跳过必须写明原因（PRD 12.1），否则报告读者无法区分"没测"和"测了没过"。
  assert.match(stabilityStep.summary, /已跳过/);
});

test("稳定性未达标 → 不再调用准入 runner", async () => {
  const runners = makeRunners({ stability: badStability });
  const run = createAdmissionSuiteRunner(runners);
  const result = await run({ profileIds: ["p1"] }, taskContextFor());

  assert.deepEqual(runners.calls, ["quick:p1", "stability:p1"]);
  assert.equal(result.conclusion, CONCLUSION.REJECTED);
  assert.equal(result.steps[2].executionStatus, EXECUTION_STATUS.SKIPPED);
});

test("准入硬门槛失败但综合分 95 → 整体 rejected（综合分不得翻案，ADM-008 端到端）", async () => {
  const runners = makeRunners({ admission: gateFailedAdmission });
  const run = createAdmissionSuiteRunner(runners);
  const result = await run({ profileIds: ["p1"] }, taskContextFor());

  assert.equal(result.conclusion, CONCLUSION.REJECTED);
  // 执行状态是 completed（跑完了），裁决是 not_passed（没达标）——两者正交。
  assert.equal(result.steps[2].executionStatus, EXECUTION_STATUS.COMPLETED);
  assert.equal(result.steps[2].verdict, VERDICT.NOT_PASSED);
});

// ── ② 取消会阻止下一个步骤 ───────────────────────────────────────────────────

test("快速测试后请求取消 → 抛 TaskCancelledError，不再发起稳定性请求", async () => {
  const context = taskContextFor();
  const runners = makeRunners({
    quick: () => {
      context.task.cancelRequested = true; // 模拟用户在第一步执行期间点了取消
      return okQuick;
    },
  });
  const run = createAdmissionSuiteRunner(runners);

  await assert.rejects(() => run({ profileIds: ["p1"] }, context), { name: "TaskCancelledError" });
  assert.deepEqual(runners.calls, ["quick:p1"]);
});

// ── ③ 一个模型失败不阻断其它模型 ─────────────────────────────────────────────

test("模型 A 快速测试失败不影响模型 B 继续执行；整体结论覆盖全部模型（ADM-006 端到端）", async () => {
  const runners = makeRunners({ quick: (args) => (args.profileId === "p1" ? badQuick : okQuick) });
  const run = createAdmissionSuiteRunner(runners);
  const result = await run({ profileIds: ["p1", "p2"] }, taskContextFor());

  assert.deepEqual(runners.calls, ["quick:p1", "quick:p2", "stability:p2", "admission:p2"]);
  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].conclusion, CONCLUSION.REJECTED);
  assert.equal(result.models[1].conclusion, CONCLUSION.ACCEPTED);
  // 关键：整体结论不是"取第一个模型"，也不是"有一个过就算过"。
  assert.equal(result.conclusion, CONCLUSION.REJECTED);
});

test("全部模型通过 → accepted", async () => {
  const run = createAdmissionSuiteRunner(makeRunners());
  const result = await run({ profileIds: ["p1", "p2"] }, taskContextFor());
  assert.equal(result.conclusion, CONCLUSION.ACCEPTED);
});

// ── ④ 平台异常 ≠ 渠道不行 ────────────────────────────────────────────────────

test("runner 抛异常 → executionStatus=failed + verdict=indeterminate，结论 indeterminate 而非 rejected", async () => {
  const runners = makeRunners({
    stability: () => {
      throw new Error("写盘失败");
    },
  });
  const run = createAdmissionSuiteRunner(runners);
  const result = await run({ profileIds: ["p1"] }, taskContextFor());

  assert.equal(result.steps[1].executionStatus, EXECUTION_STATUS.FAILED);
  assert.equal(result.steps[1].verdict, VERDICT.INDETERMINATE);
  assert.equal(result.conclusion, CONCLUSION.INDETERMINATE);
  // 平台自己出错时也不能继续烧额度。
  assert.deepEqual(runners.calls, ["quick:p1", "stability:p1"]);
});

test("准入结果缺 verdict 字段 → indeterminate，不按通过处理", async () => {
  const run = createAdmissionSuiteRunner(makeRunners({ admission: { score: 99, grade: "A" } }));
  const result = await run({ profileIds: ["p1"] }, taskContextFor());
  assert.equal(result.steps[2].verdict, VERDICT.INDETERMINATE);
  assert.equal(result.conclusion, CONCLUSION.INDETERMINATE);
});

// ── ⑤ 档位探测是观察项，不改主结论 ───────────────────────────────────────────

test("档位探针失败不影响整体结论（optional，PRD 7.7）", async () => {
  const runners = makeRunners({
    admission: (args) => {
      if (args.model) throw new Error("该档位尚未开放");
      return okAdmission;
    },
  });
  const run = createAdmissionSuiteRunner(runners);
  const result = await run({ profileIds: ["p1"], claudeChannelId: "ch1", tierProbeModels: ["claude-opus-4-8"] }, taskContextFor());

  assert.equal(result.conclusion, CONCLUSION.ACCEPTED);
  const probeStep = result.steps.find((s) => s.isTierProbe);
  assert.equal(probeStep.executionStatus, EXECUTION_STATUS.FAILED);
});

// ── ⑥ 进度推进与步骤快照 ─────────────────────────────────────────────────────

test("每个步骤都推进进度，跳过的步骤同样计入，完成时 completedUnits 等于总步骤数", async () => {
  const context = taskContextFor();
  const run = createAdmissionSuiteRunner(makeRunners({ quick: badQuick }));
  await run({ profileIds: ["p1", "p2"] }, context);
  // 2 个模型 × 3 步 = 6，即使 p1 只真跑了 1 步、其余 2 步是跳过的。
  assert.equal(context.task.completedUnits, 6);
});

test("步骤快照挂到 task 上，且不携带原始响应体（每 900ms 被轮询一次）", async () => {
  const context = taskContextFor();
  const run = createAdmissionSuiteRunner(makeRunners());
  await run({ profileIds: ["p1"] }, context);

  assert.equal(context.task.steps.length, 3);
  for (const step of context.task.steps) {
    assert.deepEqual(Object.keys(step).sort(), [
      "executionStatus",
      "groupKey",
      "groupLabel",
      "isTierProbe",
      "stepLabel",
      "stepName",
      "summary",
      "verdict",
    ]);
  }
});

test("没有选择模型 → 直接报错，不建空任务", async () => {
  const run = createAdmissionSuiteRunner(makeRunners());
  await assert.rejects(() => run({ profileIds: [] }, taskContextFor()), /至少选择一个被测模型/);
});
