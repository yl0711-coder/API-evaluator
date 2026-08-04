// tests/cost-estimates.test.mjs
// 成本预估纯逻辑测试：用户在各测试表单里改参数时实时看到的「大概花费 / 请求数 / token 区间 / 成本等级」，
// 以及确认框（confirmExecution）的危险色，全部来自 src/cost-estimates.js 的纯函数。这些数字直接影响用户
// 「要不要花真金白银跑这次测试」的决策——预估算错会误导花费。此处锁定请求数/ token 数学、风险阈值、
// AI 分析加价与确认框语气，防重构悄悄改坏预估。数值均按当前实现核对（见各断言旁注）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateStabilityCost,
  estimateBatchCost,
  estimateScenarioCost,
  estimateAdmissionCost,
  estimateAdmissionBatchCost,
  estimateStandardCost,
  estimateLoadTestCost,
  formatEstimate,
  confirmExecution,
} from "../src/cost-estimates.js";

// ---- 稳定性测试 ----
test("estimateStabilityCost：请求数=轮数，短 Prompt token 区间 = 轮数×[80,200]", () => {
  const e = estimateStabilityCost({ rounds: 10 });
  assert.equal(e.requests, 10);
  assert.equal(e.lowTokens, 800); // 10×80
  assert.equal(e.highTokens, 2000); // 10×200
});

test("estimateStabilityCost：风险随轮数分档（<10 低、=10 中、>=30 中高）", () => {
  assert.equal(estimateStabilityCost({ rounds: 5 }).risk, "低");
  assert.equal(estimateStabilityCost({ rounds: 10 }).risk, "中"); // 边界：恰好 10
  assert.equal(estimateStabilityCost({ rounds: 30 }).risk, "中高"); // 边界：恰好 30
});

test("estimateStabilityCost：缺 rounds 时按默认 10 估", () => {
  const e = estimateStabilityCost({});
  assert.equal(e.requests, 10);
});

test("estimateStabilityCost：有 groups 时按各组 repeats 求和，忽略 rounds", () => {
  const e = estimateStabilityCost({
    rounds: 999,
    groups: [
      { presetId: "basic", repeats: 3 },
      { presetId: "coding", repeats: 3 },
      { presetId: "custom", repeats: 1 },
    ],
  });
  assert.equal(e.requests, 7);
  assert.equal(e.lowTokens, 7 * 80);
  assert.equal(e.highTokens, 7 * 200);
});

test("estimateStabilityCost：空 groups 数组回落到 rounds", () => {
  const e = estimateStabilityCost({ rounds: 5, groups: [] });
  assert.equal(e.requests, 5);
});

// ---- AI 分析加价（横切所有带 payload 的估算） ----
test("勾选 AI 分析：额外 +1 请求、token +[800,1800]（稳定性为例）", () => {
  const base = estimateStabilityCost({ rounds: 10 });
  const ai = estimateStabilityCost({ rounds: 10, useAiReportAnalysis: "1" });
  assert.equal(ai.requests, base.requests + 1);
  assert.equal(ai.lowTokens, base.lowTokens + 800);
  assert.equal(ai.highTokens, base.highTokens + 1800);
  assert.match(ai.note, /AI 分析/);
});

test("AI 分析开关识别 '1' / 'on' / true，其它值（含 '0'/'' ）不加价", () => {
  const base = estimateStabilityCost({ rounds: 10 }).requests;
  for (const on of ["1", "on", true]) {
    assert.equal(estimateStabilityCost({ rounds: 10, useAiReportAnalysis: on }).requests, base + 1, `期望加价：${on}`);
  }
  for (const off of ["0", "", undefined, false, "true"]) {
    assert.equal(estimateStabilityCost({ rounds: 10, useAiReportAnalysis: off }).requests, base, `不该加价：${off}`);
  }
});

// ---- 批量稳定性测试 ----
test("estimateBatchCost：请求数 = API 数 × 轮数；空选择 → 0 请求", () => {
  assert.equal(estimateBatchCost({ profileIds: ["a", "b", "c"], rounds: 10 }).requests, 30);
  assert.equal(estimateBatchCost({ profileIds: [], rounds: 10 }).requests, 0);
  assert.equal(estimateBatchCost({ rounds: 10 }).requests, 0); // 无 profileIds 字段
});

test("estimateBatchCost：风险分档（<30 低、=30 中、>=100 高）", () => {
  assert.equal(estimateBatchCost({ profileIds: ["a"], rounds: 3 }).risk, "低"); // 3
  assert.equal(estimateBatchCost({ profileIds: ["a", "b", "c"], rounds: 10 }).risk, "中"); // 30
  assert.equal(estimateBatchCost({ profileIds: Array(10).fill("x"), rounds: 10 }).risk, "高"); // 100
});

// ---- 场景测试（按场景 category 估 token） ----
const SCENARIOS = [
  { id: "s-code", category: "coding", difficulty: "small" }, // [1000,3000]
  { id: "s-long", category: "long_context", difficulty: "small" }, // [4000,10000]
  { id: "s-short", category: "connectivity", difficulty: "small" }, // 回落 short [80,200]
];

test("estimateScenarioCost：请求数 = API数 × 场景数 × 重复；token 按 category 分档累加", () => {
  const e = estimateScenarioCost({ profileIds: ["a"], repeats: 1, scenarioIds: ["s-code", "s-long"] }, SCENARIOS);
  assert.equal(e.requests, 2); // 1×2×1
  assert.equal(e.lowTokens, 5000); // 1000(code) + 4000(long)
  assert.equal(e.highTokens, 13000); // 3000(code) + 10000(long)
});

test("estimateScenarioCost：多 API × 重复正确相乘 token", () => {
  const e = estimateScenarioCost({ profileIds: ["a", "b"], repeats: 3, scenarioIds: ["s-short"] }, SCENARIOS);
  assert.equal(e.requests, 6); // 2×1×3
  assert.equal(e.highTokens, 2 * 3 * 200); // profiles×repeats×perRun(short high)
});

test("estimateScenarioCost：未勾选场景 → 0 请求（不会误报花费）", () => {
  const e = estimateScenarioCost({ profileIds: ["a"], repeats: 1, scenarioIds: [] }, SCENARIOS);
  assert.equal(e.requests, 0);
  assert.equal(e.highTokens, 0);
});

// ---- 准入评测 ----
test("estimateAdmissionCost：档位请求数 quick=5 / standard=11 / deep=12（+已知模型家族探针1）", () => {
  assert.equal(estimateAdmissionCost({ packageLevel: "quick", modelName: "whatever" }).requests, 5);
  assert.equal(estimateAdmissionCost({ packageLevel: "standard", modelName: "unknown-x" }).requests, 11);
  assert.equal(estimateAdmissionCost({ packageLevel: "deep", modelName: "unknown-x" }).requests, 12);
  assert.equal(estimateAdmissionCost({ packageLevel: "deep", modelName: "claude-opus" }).requests, 13); // +1 家族探针
});

test("estimateAdmissionCost：quick 档不做家族探针（即便是已知模型）", () => {
  assert.equal(estimateAdmissionCost({ packageLevel: "quick", modelName: "gpt-4o" }).requests, 5);
});

test("estimateAdmissionBatchCost：多渠道逐个累加请求数（单渠道内不叠 AI 分析）", () => {
  const e = estimateAdmissionBatchCost({ profileIds: ["a", "b"], modelNames: ["unknown-1", "unknown-2"] });
  assert.equal(e.requests, 22); // 11 + 11
  assert.equal(e.lowTokens, 2 * 3160); // 每个 standard 未知模型 low=160+10×300
});

// ---- 标准评测 ----
test("estimateStandardCost：单模型 = 6(快速测试/quick-verify) + 9(3组预设文案×3轮稳定性) + 标准准入(11)", () => {
  const e = estimateStandardCost({ modelNames: ["demo-model"] });
  const admission = estimateAdmissionCost({ packageLevel: "standard", modelName: "demo-model" });
  assert.equal(e.requests, 6 + 9 + admission.requests);
  assert.equal(e.risk, "中"); // 26 次请求 ≥ 24 门槛
});

test("estimateStandardCost：多模型请求数按模型数线性叠加（顺序执行、不并发不影响预估）", () => {
  const one = estimateStandardCost({ modelNames: ["m1"] });
  const two = estimateStandardCost({ modelNames: ["m1", "m2"] });
  assert.equal(two.requests, one.requests * 2);
});

test("estimateStandardCost：勾选「这是 Claude 渠道」额外加 4 个模型的快速准入(5 次/个)", () => {
  const without = estimateStandardCost({ modelNames: ["m1"] });
  const withClaude = estimateStandardCost({ modelNames: ["m1"], isClaudeChannel: "1" });
  assert.equal(withClaude.requests, without.requests + 4 * 5);
});

test("estimateStandardCost：勾选 AI 分析按「模型数×2」累加（稳定性+标准准入各触发一次），claude 探测不触发", () => {
  const withoutClaude = estimateStandardCost({ modelNames: ["m1", "m2"], useAiReportAnalysis: "1" });
  assert.equal(withoutClaude.requests, estimateStandardCost({ modelNames: ["m1", "m2"] }).requests + 2 * 2);

  // 勾选 claude 渠道后，AI 分析次数不应额外增加（4 个 tier probe 探测调用没有 useAiReportAnalysis）。
  const withClaude = estimateStandardCost({ modelNames: ["m1", "m2"], useAiReportAnalysis: "1", isClaudeChannel: "1" });
  const withClaudeNoAi = estimateStandardCost({ modelNames: ["m1", "m2"], isClaudeChannel: "1" });
  assert.equal(withClaude.requests, withClaudeNoAi.requests + 2 * 2);
});

// ---- 压测（闭环/开环请求数模型不同） ----
test("estimateLoadTestCost：闭环 每负载点≈并发×时长/L；开环≈速率×时长/发送周期", () => {
  const closed = estimateLoadTestCost({ mode: "closed", loads: [10], durationSec: 60, promptProfile: "simple" });
  assert.equal(closed.requests, 400); // round(10×60 / 1.5)
  const open = estimateLoadTestCost({ mode: "open", loads: [10], durationSec: 60, burstPeriodSec: 1 });
  assert.equal(open.requests, 600); // round(10×60 / 1)
  assert.equal(open.risk, "中高"); // 600 ≥500
});

test("estimateLoadTestCost：扫描多负载点时请求数对各点求和，且下限为 1", () => {
  const e = estimateLoadTestCost({ mode: "open", loads: [10, 20], durationSec: 60, burstPeriodSec: 1 });
  assert.equal(e.requests, 600 + 1200);
  const tiny = estimateLoadTestCost({ mode: "open", loads: [0], durationSec: 1, burstPeriodSec: 1 });
  assert.ok(tiny.requests >= 1, "请求数下限为 1，不会显示 0 次");
});

// ---- 成文与确认框 ----
test("formatEstimate：成文含请求数与 token 区间（用户可读的花费说明）", () => {
  const text = formatEstimate(estimateStabilityCost({ rounds: 10 }));
  assert.match(text, /会发起 10 次请求/);
  assert.match(text, /800 - 2,?000 tokens/); // 允许千分位
  assert.match(text, /成本等级 中/);
});

test("confirmExecution：高/中高风险 → danger 语气；中/低 → normal", () => {
  const mk = (risk) => confirmExecution("标准评测", { risk, requests: 1, lowTokens: 1, highTokens: 2, note: "n" });
  assert.equal(mk("高").tone, "danger");
  assert.equal(mk("中高").tone, "danger");
  assert.equal(mk("中").tone, "normal");
  assert.equal(mk("低").tone, "normal");
  // 确认框始终提示会消耗额度，避免用户误以为免费
  assert.match(mk("低").detail, /消耗额度/);
});
