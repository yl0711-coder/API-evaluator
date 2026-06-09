// 汇总一组记录的逐字段 token 用量（审计基础）。
// 某字段在所有记录里都缺失 → 返回 null（区分"无数据"与"真实为 0"）。
const USAGE_TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "reasoningTokens",
];

export function aggregateUsage(records) {
  const list = Array.isArray(records) ? records : [];
  const totals = {};
  for (const field of USAGE_TOKEN_FIELDS) {
    const values = list
      .map((record) => record?.[field])
      .filter((value) => Number.isFinite(Number(value)))
      .map(Number);
    totals[field] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  return totals;
}

export function normalizePricePerMillion(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

export function estimateTokenCost({ inputTokens, outputTokens, inputPricePerMTokens, outputPricePerMTokens }) {
  const inputPrice = normalizePricePerMillion(inputPricePerMTokens);
  const outputPrice = normalizePricePerMillion(outputPricePerMTokens);
  if (inputPrice === null && outputPrice === null) {
    return null;
  }
  const input = Number.isFinite(Number(inputTokens)) ? Number(inputTokens) : 0;
  const output = Number.isFinite(Number(outputTokens)) ? Number(outputTokens) : 0;
  const cost = (input / 1_000_000) * (inputPrice || 0) + (output / 1_000_000) * (outputPrice || 0);
  return roundCost(cost);
}

export function estimateProfileRunCost(profile, { inputTokens, outputTokens }) {
  return estimateTokenCost({
    inputTokens,
    outputTokens,
    inputPricePerMTokens: profile?.inputPricePerMTokens,
    outputPricePerMTokens: profile?.outputPricePerMTokens,
  });
}

export function estimateTokenEconomics({
  inputTokens,
  outputTokens,
  inputCostPerMTokens,
  outputCostPerMTokens,
  inputSellPricePerMTokens,
  outputSellPricePerMTokens,
}) {
  const estimatedCost = estimateTokenCost({
    inputTokens,
    outputTokens,
    inputPricePerMTokens: inputCostPerMTokens,
    outputPricePerMTokens: outputCostPerMTokens,
  });
  const estimatedRevenue = estimateTokenCost({
    inputTokens,
    outputTokens,
    inputPricePerMTokens: inputSellPricePerMTokens,
    outputPricePerMTokens: outputSellPricePerMTokens,
  });
  const estimatedGrossProfit =
    estimatedCost !== null && estimatedRevenue !== null ? roundCost(estimatedRevenue - estimatedCost) : null;
  const estimatedGrossMargin =
    estimatedGrossProfit !== null && estimatedRevenue > 0 ? roundRatio(estimatedGrossProfit / estimatedRevenue) : null;

  return {
    estimatedCost,
    estimatedRevenue,
    estimatedGrossProfit,
    estimatedGrossMargin,
  };
}

export function estimateProfileRunEconomics(profile, { inputTokens, outputTokens }) {
  return estimateTokenEconomics({
    inputTokens,
    outputTokens,
    inputCostPerMTokens: profile?.inputPricePerMTokens,
    outputCostPerMTokens: profile?.outputPricePerMTokens,
    inputSellPricePerMTokens: profile?.inputSellPricePerMTokens,
    outputSellPricePerMTokens: profile?.outputSellPricePerMTokens,
  });
}

// 本次测试的【真实消耗】：把每条请求上游回报的 usage 累加（含 reasoning/cache），
// 并按配置单价估出真实成本。与"预估消耗"(测试前估算)区分——这是测试本身实际烧掉的量。
export function buildRunConsumption(profile, records) {
  const list = Array.isArray(records) ? records : [];
  // 注意 Number(null)===0（finite），必须显式排除 null/undefined，否则把"无 usage"的请求误计为计费。
  const hasUsage = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  const billedRequests = list.filter((r) => hasUsage(r?.inputTokens) || hasUsage(r?.outputTokens)).length;
  if (billedRequests === 0) {
    // 全程没有任何 usage 回报：区分"无数据"与"真实为 0"，整体返回 null。
    return {
      billedRequests: 0,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheCreationTokens: null,
      cacheReadTokens: null,
      totalTokens: null,
      estimatedCost: null,
      hasPrices: false,
      currency: "USD",
    };
  }
  const usage = aggregateUsage(list);
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const totalTokens = inputTokens + outputTokens;
  const estimatedCost = estimateProfileRunCost(profile, { inputTokens, outputTokens });
  return {
    billedRequests,
    inputTokens,
    outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    totalTokens,
    estimatedCost, // 未配单价时为 null（只统计 token，不出成本）
    hasPrices: estimatedCost !== null,
    currency: "USD",
  };
}

export function roundCost(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 1_000_000) / 1_000_000;
}

function roundRatio(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 10_000) / 10_000;
}
