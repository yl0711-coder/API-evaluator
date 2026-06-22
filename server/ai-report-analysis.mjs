// server/ai-report-analysis.mjs
// 可选的 AI 辅助分析：按脱敏后的报告摘要构造提示词、解析被测模型返回的分析结果。
// 仅作辅助解释，最终判断仍以本地规则结论为准。
import { summarizeText } from "./utils.mjs";

const MAX_ANALYSIS_TEXT = 3000;

export function isAiReportAnalysisEnabled(value) {
  return value === true || value === "true" || value === "1" || value === "on" || value === "yes";
}

export function buildAiReportAnalysisPrompt({ reportType, summary }) {
  const compact = compactReportData(reportType, summary);
  return [
    "你是一名 AI API 评测报告分析员，面向不懂技术的负责人和需要排查问题的工程师两类读者。",
    "请基于下面这份脱敏测试摘要，写一份中文 Markdown 分析，帮助读者判断该 API 渠道当前能不能用。",
    "",
    "要求：",
    "- 只依据给出的摘要数据，不要编造不存在的请求、错误、价格或业务背景。",
    "- 先给非技术人员能看懂的人话结论，再给技术人员看的数据依据。",
    "- 明确给出推荐倾向：继续测试、继续观察、还是暂不推荐。",
    "- 如果数据不足，要明确写“数据不足”，不要强行下结论。",
    "- 如果看到内容安全场景风险，要提醒必须人工复核原始回答。",
    "- 不要输出 API Key、密钥、鉴权信息，也不要要求用户提供密钥。",
    "- 控制在 800 字以内。",
    "",
    "输出结构必须严格使用以下四个二级标题，顺序不变：",
    "## AI 人话结论",
    "## AI 数据依据",
    "## AI 风险点",
    "## AI 下一步建议",
    "",
    "脱敏测试摘要 JSON：",
    "```json",
    JSON.stringify(compact, null, 2),
    "```",
  ].join("\n");
}

export function buildAiAnalysisResult(record) {
  if (!record?.success || !record.responseText) {
    return {
      enabled: true,
      success: false,
      error: record?.normalizedError || record?.rawError || "AI 分析请求失败。",
      requestId: record?.requestId || "",
      inputTokens: record?.inputTokens ?? null,
      outputTokens: record?.outputTokens ?? null,
    };
  }
  return {
    enabled: true,
    success: true,
    text: trimAnalysisText(record.responseText),
    requestId: record.requestId || "",
    inputTokens: record.inputTokens ?? null,
    outputTokens: record.outputTokens ?? null,
  };
}

function compactReportData(reportType, summary) {
  if (reportType === "stability") {
    return compactStabilitySummary(summary);
  }
  if (reportType === "batch-stability") {
    return compactBatchSummary(summary);
  }
  if (reportType === "scenario") {
    return compactScenarioSummary(summary);
  }
  if (reportType === "admission") {
    return compactAdmissionSummary(summary);
  }
  if (reportType === "batch-admission") {
    return compactBatchAdmissionSummary(summary);
  }
  return { reportType, summary: summarizeText(JSON.stringify(summary || {})) };
}

function compactAdmissionSummary(summary) {
  return {
    reportType: "模型准入评测",
    apiName: summary.profileName,
    provider: summary.provider,
    model: summary.model,
    protocol: summary.protocol,
    packageLevel: summary.packageLevel,
    grade: summary.grade,
    score: summary.score,
    successRate: summary.successRateText,
    requestCount: summary.requestCount,
    successCount: summary.successCount,
    passRate: summary.passRate,
    avgTotalMs: summary.avgTotalMs,
    p95TotalMs: summary.p95TotalMs,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    jsonPassed: summary.jsonPassed,
    toolCallPassed: summary.toolCallPassed,
    streamPassed: summary.streamPassed,
    identityPassed: summary.identityPassed,
    identityStatus: summary.identityCheck?.status || null,
    purity: compactPurity(summary.purityAssessment),
    tierDiscrimination: compactTier(summary.tierDiscrimination),
    recommendation: summary.recommendation?.title,
    nextAction: summary.nextAction,
    errorCounts: summary.errorCounts || {},
  };
}

function compactBatchAdmissionSummary(summary) {
  return {
    reportType: "批量准入评测",
    profileCount: summary.profileCount,
    packageLevel: summary.packageLevel,
    maxParallelProfiles: summary.maxParallelProfiles,
    durationMs: summary.durationMs,
    results: (summary.results || []).map((result) => ({
      apiName: result.profileName,
      model: result.model,
      grade: result.grade,
      score: result.score,
      successRate: result.successRateText,
      avgTotalMs: result.avgTotalMs,
      p95TotalMs: result.p95TotalMs,
      purityTitle: result.purityAssessment?.title || "",
      recommendation: result.recommendation?.title || "",
      error: result.error || "",
      errorCounts: result.errorCounts || {},
    })),
  };
}

// 模型纯度初判压缩：只留标题、分数与风险点标题，丢弃明细证据。
function compactPurity(purity) {
  if (!purity) return null;
  return {
    title: purity.title,
    score: purity.score,
    riskFlags: (purity.riskFlags || []).map((flag) => flag.title || flag.code).filter(Boolean),
  };
}

// 档位降级判别压缩：声称档 / 行为最像档 / 判词 / 置信度。
function compactTier(tier) {
  if (!tier) return null;
  return {
    claimedTier: tier.claimedTier,
    likelyTier: tier.likelyTier ?? null,
    status: tier.status,
    verdict: tier.verdict,
    confidence: tier.confidence,
  };
}

function compactStabilitySummary(summary) {
  return {
    reportType: "稳定性测试",
    apiName: summary.profileName,
    provider: summary.provider,
    model: summary.model,
    protocol: summary.protocol,
    rounds: summary.rounds,
    concurrency: summary.concurrency,
    successRate: summary.successRateText,
    successCount: summary.successCount,
    failureCount: summary.failureCount,
    avgFirstByteMs: summary.avgFirstByteMs,
    avgTotalMs: summary.avgTotalMs,
    p50TotalMs: summary.p50TotalMs,
    p95TotalMs: summary.p95TotalMs,
    minTotalMs: summary.minTotalMs,
    maxTotalMs: summary.maxTotalMs,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    recommendation: summary.recommendation,
    errorCounts: summary.errorCounts,
    diagnostics: compactDiagnostics(summary.diagnostics),
  };
}

function compactBatchSummary(summary) {
  return {
    reportType: "批量稳定性测试",
    profileCount: summary.profileCount,
    rounds: summary.rounds,
    maxParallelProfiles: summary.maxParallelProfiles,
    requestConcurrency: summary.requestConcurrency,
    durationMs: summary.durationMs,
    results: (summary.results || []).map((result) => ({
      apiName: result.profileName,
      model: result.model,
      successRate: result.successRateText,
      avgTotalMs: result.avgTotalMs,
      p95TotalMs: result.p95TotalMs,
      recommendation: result.recommendation?.title,
      error: result.error || "",
      errorCounts: result.errorCounts || {},
      diagnostics: compactDiagnostics(result.diagnostics),
    })),
  };
}

function compactScenarioSummary(summary) {
  return {
    reportType: "复杂场景测试",
    profileCount: summary.profileCount,
    scenarioCount: summary.scenarioCount,
    repeats: summary.repeats,
    maxParallelProfiles: summary.maxParallelProfiles,
    requestConcurrency: summary.requestConcurrency,
    durationMs: summary.durationMs,
    scenarios: (summary.scenarios || []).map((scenario) => ({
      id: scenario.id,
      name: scenario.name,
      category: scenario.category,
      difficulty: scenario.difficulty,
    })),
    results: (summary.results || []).map((result) => ({
      apiName: result.profileName,
      model: result.model,
      successRate: result.successRateText,
      avgQualityScore: result.avgQualityScore,
      avgTotalMs: result.avgTotalMs,
      p95TotalMs: result.p95TotalMs,
      recommendation: result.recommendation?.title,
      errorCounts: result.errorCounts || {},
      diagnostics: compactDiagnostics(result.diagnostics),
      scenarios: (result.scenarios || []).map((scenario) => ({
        name: scenario.scenarioName,
        category: scenario.category,
        successRate: scenario.successRateText,
        avgQualityScore: scenario.avgQualityScore,
        avgTotalMs: scenario.avgTotalMs,
        p95TotalMs: scenario.p95TotalMs,
        issues: scenario.issues || [],
      })),
    })),
  };
}

function compactDiagnostics(diagnostics) {
  return (diagnostics || []).map((item) => ({
    code: item.code,
    count: item.count,
    title: item.title,
    action: item.action,
  }));
}

function trimAnalysisText(text) {
  return String(text || "").trim().slice(0, MAX_ANALYSIS_TEXT);
}
