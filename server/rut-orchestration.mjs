// server/rut-orchestration.mjs
//
// RUT 编排脚手架。
//
// 把 rut-auditor 的统计核心串成可运行流程：对每个 prompt，目标渠道采 1 次、可信基线
// 采 m 次，用 scoreResponse 把响应映射成标量，喂 auditModelSubstitution 做秩均匀性检验。
//
// 采样器（sampleTarget / sampleBaseline）+ 标量函数（scoreResponse）全用依赖注入：
// 测试用 mock，零真实请求、零额度消耗。真实采样（接 test-runner 请求机 + "可信基线 API"
// profile 角色）留待用户授权基线渠道 + 额度后接。
//
// 预算守卫前置：RUT 单次可上万调用，超预算直接 blocked，**一个请求都不发**。
//
// 标量来源：OpenAI 有 logprobs 可用 log-rank；Anthropic 无 logprobs → 纯文本评分降级
// （textLengthScore 是**弱代理**，仅占位，真实场景应注入更有判别力的 scoreResponse）。

import { estimateTokens } from "./tokenizer-fingerprint.mjs";
import { auditModelSubstitution, rutBudgetGuard } from "./rut-auditor.mjs";

// 无 logprobs 时的纯文本评分降级：响应长度的 token 估算。弱代理，明确标注。
export function textLengthScore(response) {
  const text =
    typeof response === "string" ? response : response?.text || response?.responseText || "";
  return estimateTokens(text);
}

export async function runRutAudit({
  prompts = [],
  sampleTarget,
  sampleBaseline,
  scoreResponse = textLengthScore,
  baselineSamples = 100,
  alpha = 0.05,
  maxCalls = 2000,
  allowHighTier = false,
} = {}) {
  if (typeof sampleTarget !== "function" || typeof sampleBaseline !== "function") {
    throw new Error("runRutAudit 需要 sampleTarget / sampleBaseline 函数");
  }
  const m = Math.max(1, Math.floor(baselineSamples) || 1);
  const guard = rutBudgetGuard(prompts.length, m, { maxCalls, allowHighTier });
  if (!guard.allowed) {
    // 超预算：不发任何请求，直接返回阻断结果。
    return { allowed: false, budget: guard, audit: null, callsUsed: 0, note: guard.note };
  }

  const targetValues = [];
  const baselineSamplesPerPrompt = [];
  let callsUsed = 0;

  for (const prompt of prompts) {
    // eslint-disable-next-line no-await-in-loop
    const tResp = await sampleTarget(prompt);
    callsUsed += 1;
    targetValues.push(scoreResponse(tResp));

    const baseVals = [];
    for (let k = 0; k < m; k++) {
      // eslint-disable-next-line no-await-in-loop
      const bResp = await sampleBaseline(prompt);
      callsUsed += 1;
      baseVals.push(scoreResponse(bResp));
    }
    baselineSamplesPerPrompt.push(baseVals);
  }

  const audit = auditModelSubstitution({ targetValues, baselineSamplesPerPrompt, alpha });
  return { allowed: true, budget: guard, audit, callsUsed };
}
