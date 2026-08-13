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
  const groups = Array.isArray(payload.groups) && payload.groups.length ? payload.groups : [{ repeats: Number(payload.rounds || 10) }];
  const requests = groups.reduce((sum, group) => sum + (group.repeats || 0), 0);
  return withAiAnalysisEstimate(payload, {
    requests,
    lowTokens: requests * TOKEN_ESTIMATES.short[0],
    highTokens: requests * TOKEN_ESTIMATES.short[1],
    risk: requests >= 30 ? "中高" : requests >= 10 ? "中" : "低",
    note: "稳定性测试使用短 Prompt，主要看成功率、延迟、错误分布与缓存命中率。",
  });
}

// 压力测试成本预估（校准前用文档 §4.1 的假设 L）：
//   闭环：每点请求数 ≈ 并发 × 时长 / L；开环：每点 ≈ 速率 × 时长。扫描时对所有负载点求和。
const LOAD_ASSUMED_L = { simple: 1.5, think: 6, coding: 12 }; // 秒/请求（按各档【默认】max_tokens 标定）
const LOAD_TOKENS = { simple: [30, 80], think: [300, 700], coding: [800, 1400] };
// 负载档各自的 max_tokens 默认值（同 server/load-test.mjs 的 LOAD_PROFILES，
// 由 tests/load-test.test.mjs 的常量同步测试钉住，防两边各改一处静默漂移）。
// 仅作「用户没填 maxTokens 时」的基线；填了则按用户填的为准。
export const LOAD_PROFILE_MAX_TOKENS = { simple: 64, think: 256, coding: 800 };
// 每请求的固定开销（建连 + 排队 + 首 token），与输出长度无关。上面的 L 减掉它即「生成耗时」，
// 只有生成耗时随 max_tokens 变化——用于把 L 换算到用户填的输出上限（见下方 assumedL）。
const LOAD_FIXED_OVERHEAD_SEC = 0.5;
export function estimateLoadTestCost(payload) {
  const key = LOAD_ASSUMED_L[payload.promptProfile] ? payload.promptProfile : "simple";
  const durationSec = Number(payload.durationSec || 60);
  const open = payload.mode === "open";
  const intervalSec = open ? 0 : Number(payload.intervalSec) || 0; // 闭环思考时间：拉长每请求周期
  const burstPeriodSec = open ? Math.max(1, Number(payload.burstPeriodSec) || 1) : 1; // 开环发送周期：每 N 秒只发 1 秒
  const loads = Array.isArray(payload.loads) && payload.loads.length ? payload.loads : [open ? 10 : 30];

  // max_tokens 现在由用户决定（不再被负载档锁死，见 server/load-test.mjs）。倍数只往上取：
  // 填得比档位默认【小】并不代表模型就会少写——输出长度主要由 prompt 决定，max_tokens 只是上限，
  // 往下砍预估会低报花费。
  const defaultMaxTokens = LOAD_PROFILE_MAX_TOKENS[key];
  const tokenScale = Math.max(1, (Number(payload.maxTokens) || defaultMaxTokens) / defaultMaxTokens);
  // 闭环的请求数由每请求耗时决定，而每请求耗时随输出上限一起变长。只放大 token 不放大 L，
  // 等于拿「短输出的请求数」乘「长输出的单请求 token」，闭环预估会高报数倍
  // （简单档填 640 token 实测约 8×）。故把生成耗时同比拉长，固定开销不动。
  const assumedL = LOAD_FIXED_OVERHEAD_SEC + Math.max(0, LOAD_ASSUMED_L[key] - LOAD_FIXED_OVERHEAD_SEC) * tokenScale;

  const countRequests = (perReqSec) =>
    Math.max(
      1,
      loads.reduce(
        (sum, load) =>
          sum + Math.round(open ? (Number(load) * durationSec) / burstPeriodSec : (Number(load) * durationSec) / (perReqSec + intervalSec)),
        0,
      ),
    );
  const requests = countRequests(assumedL);
  const [lo, hi] = LOAD_TOKENS[key];
  // 成本等级锚在「未放大 max_tokens 时的请求数」上，取两者较大者：闭环放大后请求数会变少，
  // 若直接用它定级，会出现「把 max_tokens 调大 → 实际更贵 → 警示等级反而降一档」。只增不减。
  const riskRequests = Math.max(requests, countRequests(LOAD_ASSUMED_L[key]));
  return {
    requests,
    // 两端同比放大：只抬高位会让「调大 max_tokens」时低位随请求数变少而跌到基线以下，
    // 读起来像「上限调大反而更便宜」。tokenScale=1 时与放开前逐位相等（防回归）。
    lowTokens: Math.round(requests * lo * tokenScale),
    highTokens: Math.round(requests * hi * tokenScale),
    risk: riskRequests >= 2000 ? "高" : riskRequests >= 500 ? "中高" : "中",
    note: "压测请求数为估计值（校准前用假设延迟），实际以运行为准，且全部真实计费。扫描会对每个负载点累加。",
  };
}

// 标准评测新流程（每个选中模型顺序执行、不并发）：
//   快速测试(=/api/tests/quick-verify，连通+标称一致性+4个指纹探针=6次，输出封顶96 token)
//   + 稳定性(3 组预设文案各 3 遍，共 9 轮：基础稳定性 + 结构化输出 + 编程场景) + 标准准入(取代场景测试)。
// 勾选“这是 Claude 渠道”时，额外对 4 个固定新档位模型各跑一次快速准入（临时探测，不计入 modelNames）。
const STANDARD_STABILITY_ROUNDS = 9;
const QUICK_VERIFY_REQUESTS = 6; // 见 server/test-runner.mjs runQuickVerify：1 连通 + 1 标称一致性 + 4 基础指纹探针
const CLAUDE_TIER_PROBE_MODELS = ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"];

function estimateStandardCostForModel(modelName) {
  const quick = {
    requests: QUICK_VERIFY_REQUESTS,
    lowTokens: QUICK_VERIFY_REQUESTS * TOKEN_ESTIMATES.short[0],
    highTokens: QUICK_VERIFY_REQUESTS * TOKEN_ESTIMATES.short[1],
  };
  const stability = {
    requests: STANDARD_STABILITY_ROUNDS,
    lowTokens: STANDARD_STABILITY_ROUNDS * TOKEN_ESTIMATES.short[0],
    highTokens: STANDARD_STABILITY_ROUNDS * TOKEN_ESTIMATES.short[1],
  };
  const admission = estimateAdmissionCost({ packageLevel: "standard", modelName });
  return {
    requests: quick.requests + stability.requests + admission.requests,
    lowTokens: quick.lowTokens + stability.lowTokens + admission.lowTokens,
    highTokens: quick.highTokens + stability.highTokens + admission.highTokens,
  };
}

export function estimateStandardCost(payload) {
  const modelNames = Array.isArray(payload.modelNames) && payload.modelNames.length ? payload.modelNames : [""];
  const perModel = modelNames.map(estimateStandardCostForModel);
  let requests = perModel.reduce((sum, e) => sum + e.requests, 0);
  let lowTokens = perModel.reduce((sum, e) => sum + e.lowTokens, 0);
  let highTokens = perModel.reduce((sum, e) => sum + e.highTokens, 0);
  const isClaudeChannel = isCheckboxOn(payload.isClaudeChannel);
  if (isClaudeChannel) {
    for (const model of CLAUDE_TIER_PROBE_MODELS) {
      const probe = estimateAdmissionCost({ packageLevel: "quick", modelName: model });
      requests += probe.requests;
      lowTokens += probe.lowTokens;
      highTokens += probe.highTokens;
    }
  }
  const modelCount = modelNames.length;
  const estimate = {
    requests,
    lowTokens,
    highTokens,
    risk: requests >= 60 ? "中高" : requests >= 24 ? "中" : "低",
    note: `标准评测会对选中的 ${modelCount} 个模型逐个（不并发）依次执行快速测试、稳定性测试（3 组预设文案各 3 遍，共 ${STANDARD_STABILITY_ROUNDS} 轮）和标准准入评测${isClaudeChannel ? "，并额外对 4 个 Claude 新档位模型做快速准入" : ""}。`,
  };
  // 每个模型实际会各触发 2 次 AI 分析（稳定性一次 + 标准准入一次）；Claude 档位快速准入探测
  // 不支持 AI 分析（调用时未传 useAiReportAnalysis），不计入此项。
  return withAiAnalysisEstimate(payload, estimate, modelCount * 2);
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
  const estimates =
    profiles > 0
      ? Array.from({ length: profiles }, (_, index) =>
          estimateAdmissionCost({ ...payload, modelName: modelNames[index], useAiReportAnalysis: "" }),
        )
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
    note: `${estimate.note} 已勾选 AI 分析，会额外调用 ${analysisRequests} 次 AI 分析模型（被测渠道，或在『设置』里指定）生成报告解读。`,
  };
}

function isAiAnalysisChecked(payload) {
  return isCheckboxOn(payload?.useAiReportAnalysis);
}

function isCheckboxOn(value) {
  return value === "1" || value === "on" || value === true;
}

function upgradeRisk(risk, extraHighTokens) {
  if (extraHighTokens >= 3000 && risk === "低") return "中";
  return risk;
}

function knownModelFamily(modelName) {
  const text = String(modelName || "").toLowerCase();
  return /claude|anthropic|gemini|palm|deepseek|(^|[-_])glm|chatglm|zhipu|doubao|ark|volc|豆包|kimi|moonshot|grok|xai|gpt|openai|codex|(^|[-_])o[134](?:[-_]|$)|o\d/.test(
    text,
  );
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
