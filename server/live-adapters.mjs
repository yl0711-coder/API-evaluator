// server/live-adapters.mjs
//
// LLM 裁判 / RUT（防换模型秩检验）的「真实采样」适配器（实验性，默认关闭）。
//
// 编排层（judge-orchestration / rut-orchestration）对采样全用依赖注入：
//   - 裁判：callJudge(judgeModel, prompt) => Promise<文本>
//   - RUT：sampleTarget(prompt) / sampleBaseline(prompt) => Promise<record>
// 这里提供把这些注入点接到真实请求机的适配器（runRequest 由上层注入）。
//
// **安全设计**：
//   1. runRequest 一律依赖注入（真实跑传 executeTestRequest，测试传 mock），
//      本模块自身不强制发任何真实请求 —— 单测零额度消耗。
//   2. 真实跑由上层显式构造适配器并提供「裁判/基线 profile + 额度上限」才会发生；
//      默认 env 开关关闭（见 isLiveJudgeEnabled / isLiveRutEnabled）。
//   3. 上线顺序遵循：纯透传 → 审计(只记录) → shadow → 小流量 → 阻断。
//      首次真实跑应停在「审计」：跑并记录裁判/RUT 结论，但不据此改变任何对外结论。

import { assessJudgePanel } from "./judge-orchestration.mjs";
import { selectEligibleJudges } from "./llm-judge.mjs";
import { estimateProfileRunCost, roundCost } from "./costing.mjs";
import { envCompat } from "./env-compat.mjs";

// runRequest 一律依赖注入：真实跑由 test-runner 传 executeTestRequest，测试传 mock。
// 不在此 import executeTestRequest —— 避免与 test-runner 形成循环依赖，也确保本模块
// 自身永远不会"默认"发真实请求。
function defaultRunRequest() {
  throw new Error("live-adapters 需要注入 runRequest（真实跑传 executeTestRequest，测试传 mock）");
}

// env 闸门：默认关闭。真实激活需显式置 1，且仍受额度守卫约束。
export function isLiveJudgeEnabled() {
  return envCompat("ENABLE_LIVE_JUDGE") === "1";
}
export function isLiveRutEnabled() {
  return envCompat("ENABLE_LIVE_RUT") === "1";
}

// 裁判调用器：judges 传裁判 profile 列表；callJudge 收到的是“裁判模型名”
// （编排层用模型名做同家族规避），按模型名映射回 profile 再发请求。
// runRequest 由上层注入（真实跑传 executeTestRequest，测试传 mock）。
export function createJudgeCaller(judgeProfiles = [], { runRequest = defaultRunRequest, runId = "llm-judge", abortSignal = null, onJudgeRecord = null } = {}) {
  const byModel = new Map();
  for (const profile of judgeProfiles) {
    if (profile?.defaultModel && !byModel.has(profile.defaultModel)) {
      byModel.set(profile.defaultModel, profile);
    }
  }
  return async function callJudge(judgeModel, prompt) {
    const profile = byModel.get(judgeModel);
    if (!profile) return ""; // 找不到对应裁判渠道 → 空文本（编排层会跳过该裁判）
    const record = await runRequest(profile, prompt, {
      runId,
      caseId: "llm-judge",
      writeLog: true,
      abortSignal,
    });
    // 旁路上报裁判调用的真实 usage（编排层契约仍只收文本），供上层统计裁判成本。
    if (typeof onJudgeRecord === "function") onJudgeRecord(profile, record);
    return record?.success ? record.responseText || "" : "";
  };
}

// 汇总一批裁判调用的真实消耗（按各裁判 profile 单价计 cost）。
function aggregateJudgeConsumption(entries) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let hasCost = false;
  for (const { profile, record } of entries) {
    const inTok = Number(record?.inputTokens) || 0;
    const outTok = Number(record?.outputTokens) || 0;
    inputTokens += inTok;
    outputTokens += outTok;
    const c = estimateProfileRunCost(profile, { inputTokens: inTok, outputTokens: outTok });
    if (c !== null) {
      cost += c;
      hasCost = true;
    }
  }
  return {
    calls: entries.length,
    inputTokens,
    outputTokens,
    cost: hasCost ? roundCost(cost) : null, // 没填裁判单价 → null（区分"0"与"未知"）
  };
}

// 裁判模型名列表（喂给 runMultiJudge 的 judges，用于同家族规避）。
export function judgeModelsFromProfiles(judgeProfiles = []) {
  return judgeProfiles.map((p) => p?.defaultModel).filter(Boolean);
}

// RUT 采样器：给定 profile，返回 sample(prompt) => Promise<record>。
// scoreResponse 默认读 record.responseText（textLengthScore 兼容）。
export function createProfileSampler(profile, { runRequest = defaultRunRequest, runId = "rut", caseId = "rut", abortSignal = null } = {}) {
  if (!profile) throw new Error("createProfileSampler 需要一个 profile");
  return async function sample(prompt) {
    return runRequest(profile, prompt, { runId, caseId, writeLog: true, abortSignal });
  };
}

// 裁判额度守卫：题数 × 可用裁判数 = 调用数，超 maxCalls 则截断题目（不静默）。
export function judgeBudgetPlan(itemCount, judgeCount, maxCalls) {
  const perItem = Math.max(1, judgeCount);
  const maxItems = Math.max(0, Math.floor(maxCalls / perItem));
  const itemsToJudge = Math.min(itemCount, maxItems);
  return {
    perItem,
    maxItems,
    itemsToJudge,
    dropped: Math.max(0, itemCount - itemsToJudge),
    callsPlanned: itemsToJudge * perItem,
  };
}

// LLM 裁判「审计模式」真实跑：只产出并记录裁判结论，绝不据此改变任何对外评测结论
// （上线顺序第二步：审计）。受 maxCalls 硬上限约束，超额截断题目并显式声明丢弃。
// runRequest 由上层注入（真实跑传 executeTestRequest，测试传 mock）。真实跑由上层在
// isLiveJudgeEnabled() 为真且提供裁判 profile 后触发。
export async function runLiveJudgeAudit({
  targetModel = "",
  items = [], // [{ question, answer, rubric }]
  judgeProfiles = [],
  scale = 100,
  maxCalls = 50,
  runRequest = defaultRunRequest,
  runId = "llm-judge-audit",
  abortSignal = null,
} = {}) {
  const judgeModels = judgeModelsFromProfiles(judgeProfiles);
  const { eligible, excluded } = selectEligibleJudges(judgeModels, targetModel);
  if (eligible.length === 0) {
    return {
      mode: "audit",
      ok: false,
      reason: "no_eligible_judge",
      excluded,
      needsHumanReview: true,
      callsUsed: 0,
      note: "无可用裁判（全部与被测同家族，或未配置裁判渠道），结果不可信，需人工复核。",
    };
  }
  const plan = judgeBudgetPlan(items.length, eligible.length, maxCalls);
  if (plan.itemsToJudge === 0) {
    return {
      mode: "audit",
      ok: false,
      reason: "budget_too_small",
      needsHumanReview: true,
      callsUsed: 0,
      note: `额度上限 ${maxCalls} 次不足以评一题×${plan.perItem} 个裁判，未发任何请求。`,
    };
  }
  const used = items.slice(0, plan.itemsToJudge);
  const judgeRecords = [];
  const callJudge = createJudgeCaller(judgeProfiles, {
    runRequest,
    runId,
    abortSignal,
    onJudgeRecord: (profile, record) => judgeRecords.push({ profile, record }),
  });
  const panel = await assessJudgePanel({ items: used, judges: judgeModels, targetModel, scale, callJudge });
  return {
    mode: "audit", // 仅记录，不改变任何对外结论
    ok: true,
    judgeCount: eligible.length,
    itemsJudged: used.length,
    droppedForBudget: plan.dropped,
    maxCalls,
    callsUsed: plan.callsPlanned, // 每题对每个可用裁判恰好发 1 次
    // 裁判调用的真实消耗（并入本次评测"实际消耗"用）
    judgeConsumption: aggregateJudgeConsumption(judgeRecords),
    excluded,
    ...panel,
    note:
      plan.dropped > 0
        ? `审计模式：受额度上限 ${maxCalls} 次约束，只评了前 ${used.length} 题、丢弃 ${plan.dropped} 题（已显式声明，非静默截断）。裁判结论仅记录，不改变任何对外结论。`
        : "审计模式：裁判结论仅记录，不改变任何对外评测结论。",
  };
}
