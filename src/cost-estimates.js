import { formatNumber } from "./client-utils.js";

const TOKEN_ESTIMATES = {
  short: [80, 200],
  normal: [300, 800],
  coding: [1000, 3000],
  longContext: [4000, 10000],
  reasoning: [800, 2000],
  safety: [300, 900],
};

export function estimateStabilityCost(payload) {
  const requests = Number(payload.rounds || 10);
  return withAiAnalysisEstimate(payload, {
    requests,
    lowTokens: requests * TOKEN_ESTIMATES.short[0],
    highTokens: requests * TOKEN_ESTIMATES.short[1],
    risk: requests >= 30 ? "中高" : requests >= 10 ? "中" : "低",
    note: "稳定性测试使用短 Prompt，主要看成功率、延迟和错误分布。",
  });
}

export function estimateStandardCost(payload, scenarioCount = 2) {
  const rounds = Number(payload.rounds || 3);
  const requests = 1 + rounds + scenarioCount;
  const estimate = {
    requests,
    lowTokens: TOKEN_ESTIMATES.short[0] + rounds * TOKEN_ESTIMATES.short[0] + scenarioCount * TOKEN_ESTIMATES.normal[0],
    highTokens: TOKEN_ESTIMATES.short[1] + rounds * TOKEN_ESTIMATES.short[1] + scenarioCount * TOKEN_ESTIMATES.normal[1],
    risk: rounds >= 10 ? "中" : "低",
    note: "标准评测会依次执行快速测试、稳定性测试和少量场景测试，适合初筛。",
  };
  return withAiAnalysisEstimate(payload, estimate, scenarioCount > 0 ? 2 : 1);
}

export function estimateAdmissionCost(payload) {
  const packageLevel = payload.packageLevel || "standard";
  const familyProbeCount = packageLevel === "quick" ? 0 : knownModelFamily(payload.modelName) ? 1 : 0;
  const requests = (packageLevel === "deep" ? 12 : packageLevel === "quick" ? 5 : 11) + familyProbeCount;
  const normalRequests = Math.max(0, requests - 1);
  return withAiAnalysisEstimate(payload, {
    requests,
    lowTokens: TOKEN_ESTIMATES.short[0] * 2 + normalRequests * TOKEN_ESTIMATES.normal[0],
    highTokens: TOKEN_ESTIMATES.short[1] * 2 + normalRequests * TOKEN_ESTIMATES.normal[1],
    risk: packageLevel === "deep" ? "中" : "低",
    note: "准入评测会检查连通、结构化输出、标称一致性、工具调用、流式结构、任务行为和模型指纹探针，用于接入前初筛。",
  });
}

export function estimateAdmissionBatchCost(payload) {
  const profiles = payload.profileIds?.length || 0;
  const modelNames = Array.isArray(payload.modelNames) ? payload.modelNames : [];
  // 单渠道估算里关掉 AI 分析（批次只在总层做一次），避免逐渠道重复累加。
  const estimates = profiles > 0
    ? Array.from({ length: profiles }, (_, index) =>
        estimateAdmissionCost({ ...payload, modelName: modelNames[index], useAiReportAnalysis: "" }))
    : [];
  const requests = estimates.reduce((total, estimate) => total + estimate.requests, 0);
  return withAiAnalysisEstimate(payload, {
    requests,
    lowTokens: estimates.reduce((total, estimate) => total + estimate.lowTokens, 0),
    highTokens: estimates.reduce((total, estimate) => total + estimate.highTokens, 0),
    risk: requests >= 60 ? "中高" : requests >= 24 ? "中" : "低",
    note: "批量准入会对多个 API 逐个执行准入评测，用于同模型多渠道初筛。建议先选 2-3 个关键候选。",
  });
}

export function estimateBatchCost(payload) {
  const profiles = payload.profileIds?.length || 0;
  const rounds = Number(payload.rounds || 10);
  const requests = profiles * rounds;
  return withAiAnalysisEstimate(payload, {
    requests,
    lowTokens: requests * TOKEN_ESTIMATES.short[0],
    highTokens: requests * TOKEN_ESTIMATES.short[1],
    risk: requests >= 100 ? "高" : requests >= 30 ? "中" : "低",
    note: "批量测试会按 API 数量成倍增加请求数。建议先跑 3 轮筛查。",
  });
}

export function estimateScenarioCost(payload, scenarios) {
  const profiles = payload.profileIds?.length || 0;
  const repeats = Number(payload.repeats || 1);
  const selectedIds = payload.scenarioIds || [];
  const selectedScenarios = scenarios.filter((scenario) => selectedIds.includes(scenario.id));
  const perRun = selectedScenarios.reduce((total, scenario) => total + highTokenEstimateForScenario(scenario), 0);
  const lowPerRun = selectedScenarios.reduce((total, scenario) => total + lowTokenEstimateForScenario(scenario), 0);
  const requests = profiles * selectedScenarios.length * repeats;
  return withAiAnalysisEstimate(payload, {
    requests,
    lowTokens: profiles * repeats * lowPerRun,
    highTokens: profiles * repeats * perRun,
    risk: profiles * repeats * perRun >= 100000 ? "高" : profiles * repeats * perRun >= 20000 ? "中高" : "中",
    note: "场景测试包含代码和长上下文，token 消耗可能明显高于稳定性测试。",
  });
}

export function formatEstimate(estimate) {
  const guide = costGuideForRisk(estimate.risk);
  return [
    `大概花费：${guide.title}`,
    `建议：${guide.action}`,
    `会发起 ${estimate.requests} 次请求，预计消耗 ${formatNumber(estimate.lowTokens)} - ${formatNumber(estimate.highTokens)} tokens。`,
    `说明：${estimate.note}`,
    `技术参考：成本等级 ${estimate.risk}。`,
  ].join("\n");
}

export function confirmExecution(title, estimate) {
  return {
    title: `准备执行：${title}`,
    message: formatEstimate(estimate),
    detail: "这次测试会消耗额度。确认后会立即开始请求 API。",
    confirmLabel: "确认开始测试",
    cancelLabel: "先不运行",
    tone: estimate.risk === "高" || estimate.risk === "中高" ? "danger" : "normal",
  };
}

function costGuideForRisk(risk) {
  if (risk === "高" || risk === "中高") {
    return {
      title: "偏高，先别直接大批量跑",
      action: "建议先问负责人，或把轮数、API 数量、场景数量降下来。",
    };
  }
  if (risk === "中") {
    return {
      title: "中等，适合确认后运行",
      action: "如果只是日常复测可以跑；如果 Key 额度紧张，先跑 3 轮。",
    };
  }
  return {
    title: "较低，适合先跑一轮",
    action: "可以放心用于初筛；失败后不要继续跑更贵的测试。",
  };
}

function withAiAnalysisEstimate(payload, estimate, analysisRequests = 1) {
  if (!isAiAnalysisChecked(payload)) {
    return estimate;
  }
  const extraLowTokens = analysisRequests * 800;
  const extraHighTokens = analysisRequests * 1800;
  return {
    ...estimate,
    requests: estimate.requests + analysisRequests,
    lowTokens: estimate.lowTokens + extraLowTokens,
    highTokens: estimate.highTokens + extraHighTokens,
    risk: upgradeRisk(estimate.risk, extraHighTokens),
    note: `${estimate.note} 已勾选 AI 分析，会额外调用 ${analysisRequests} 次当前 API/模型生成报告解读。`,
  };
}

function isAiAnalysisChecked(payload) {
  return payload?.useAiReportAnalysis === "1" || payload?.useAiReportAnalysis === "on" || payload?.useAiReportAnalysis === true;
}

function upgradeRisk(risk, extraHighTokens) {
  if (extraHighTokens >= 3000 && risk === "低") return "中";
  return risk;
}

function knownModelFamily(modelName) {
  const text = String(modelName || "").toLowerCase();
  return /claude|anthropic|gemini|palm|deepseek|(^|[-_])glm|chatglm|zhipu|doubao|ark|volc|豆包|kimi|moonshot|grok|xai|gpt|openai|codex|(^|[-_])o[134](?:[-_]|$)|o\d/.test(text);
}

function highTokenEstimateForScenario(scenario) {
  if (scenario.category === "long_context") return TOKEN_ESTIMATES.longContext[1];
  if (scenario.category === "coding") return TOKEN_ESTIMATES.coding[1];
  if (scenario.category === "reasoning") return TOKEN_ESTIMATES.reasoning[1];
  if (scenario.category === "safety") return TOKEN_ESTIMATES.safety[1];
  if (scenario.difficulty === "normal") return TOKEN_ESTIMATES.normal[1];
  return TOKEN_ESTIMATES.short[1];
}

function lowTokenEstimateForScenario(scenario) {
  if (scenario.category === "long_context") return TOKEN_ESTIMATES.longContext[0];
  if (scenario.category === "coding") return TOKEN_ESTIMATES.coding[0];
  if (scenario.category === "reasoning") return TOKEN_ESTIMATES.reasoning[0];
  if (scenario.category === "safety") return TOKEN_ESTIMATES.safety[0];
  if (scenario.difficulty === "normal") return TOKEN_ESTIMATES.normal[0];
  return TOKEN_ESTIMATES.short[0];
}
