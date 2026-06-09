import { maskScenario } from "./profile-store.mjs";
import { aggregateUsage, buildRunConsumption, estimateProfileRunEconomics } from "./costing.mjs";
import { proportionReport } from "./stats.mjs";
import { auditRunTokenUsage } from "./token-auditor.mjs";
import {
  buildErrorDiagnostics,
  buildRecommendation,
  buildScenarioRecommendation,
  countErrors,
} from "./reporting.mjs";
import { formatPercent, groupBy, isFiniteNumber, mean, percentile, summarizeText } from "./utils.mjs";

export function buildStabilitySummary({ runId, profile, records, rounds, concurrency, prompt, startedAt, endedAt }) {
  const successRecords = records.filter((item) => item.success);
  const failedRecords = records.filter((item) => !item.success);
  const totalTimes = successRecords.map((item) => item.totalMs).filter(isFiniteNumber);
  const firstByteTimes = successRecords.map((item) => item.firstByteMs).filter(isFiniteNumber);
  const outputChars = successRecords.map((item) => item.outputChars).filter(isFiniteNumber);
  const errorCounts = countErrors(failedRecords);
  const successRate = records.length > 0 ? successRecords.length / records.length : 0;
  const p95TotalMs = percentile(totalTimes, 0.95);
  const recommendation = buildRecommendation(successRate, p95TotalMs, errorCounts);
  const usageTotals = aggregateUsage(records);
  const { inputTokens, outputTokens } = usageTotals;
  const economics = estimateProfileRunEconomics(profile, { inputTokens, outputTokens });
  // PALACE 计费灌水审计（整轮聚合，复用 prompt/输出/usage，不发新请求）
  const tokenAudit = auditRunTokenUsage(
    records.map((item) => ({
      inputText: prompt,
      outputText: item.responseText || "",
      usage: { inputTokens: item.inputTokens, outputTokens: item.outputTokens },
    })),
  );

  return {
    runId,
    profileId: profile.id,
    profileName: profile.name,
    profileRole: profile.role || "target",
    provider: profile.provider,
    model: profile.defaultModel,
    protocol: profile.protocol,
    channelCode: profile.channelCode || "",
    rounds,
    concurrency,
    promptPreview: summarizeText(prompt),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    successCount: successRecords.length,
    failureCount: failedRecords.length,
    successRate,
    successRateText: formatPercent(successRate),
    successRateCi: proportionReport(successRecords.length, records.length),
    avgFirstByteMs: Math.round(mean(firstByteTimes) || 0),
    avgTotalMs: Math.round(mean(totalTimes) || 0),
    p50TotalMs: percentile(totalTimes, 0.5),
    p95TotalMs,
    p99TotalMs: percentile(totalTimes, 0.99),
    minTotalMs: totalTimes.length ? Math.min(...totalTimes) : null,
    maxTotalMs: totalTimes.length ? Math.max(...totalTimes) : null,
    avgOutputChars: Math.round(mean(outputChars) || 0),
    inputTokens,
    outputTokens,
    cacheCreationTokens: usageTotals.cacheCreationTokens,
    cacheReadTokens: usageTotals.cacheReadTokens,
    reasoningTokens: usageTotals.reasoningTokens,
    tokenAudit,
    tokenAuditFindings: tokenAudit.flags || [],
    ...economics,
    actualConsumption: buildRunConsumption(profile, records),
    errorCounts,
    diagnostics: buildErrorDiagnostics(errorCounts),
    recommendation,
  };
}

export function buildScenarioProfileSummary(profile, records, { judgeAudit = null } = {}) {
  const successRecords = records.filter((record) => record.success);
  const failedRecords = records.filter((record) => !record.success);
  const totalTimes = successRecords.map((record) => record.totalMs).filter(isFiniteNumber);
  const qualityScores = records.map((record) => record.quality?.score).filter(isFiniteNumber);
  const successRate = records.length > 0 ? successRecords.length / records.length : 0;
  const avgQualityScore = Math.round(mean(qualityScores) || 0);
  const errorCounts = countErrors(failedRecords);
  const usageTotals = aggregateUsage(records);
  const { inputTokens, outputTokens } = usageTotals;
  const economics = estimateProfileRunEconomics(profile, { inputTokens, outputTokens });
  // PALACE 审计：场景测试每条 prompt 不同，做输出侧审计（输出计费更贵，是主要灌水向量）
  const tokenAudit = auditRunTokenUsage(
    records.map((record) => ({
      outputText: record.responseText || "",
      usage: { outputTokens: record.outputTokens },
    })),
  );
  const scenarioGroups = groupBy(records, (record) => record.scenarioId);
  const scenarios = Object.entries(scenarioGroups).map(([scenarioId, items]) => {
    const okItems = items.filter((item) => item.success);
    const scores = items.map((item) => item.quality?.score).filter(isFiniteNumber);
    const times = okItems.map((item) => item.totalMs).filter(isFiniteNumber);
    return {
      scenarioId,
      scenarioName: items[0]?.scenarioName || scenarioId,
      category: items[0]?.category || "",
      difficulty: items[0]?.difficulty || "",
      count: items.length,
      successCount: okItems.length,
      successRate: items.length ? okItems.length / items.length : 0,
      successRateText: formatPercent(items.length ? okItems.length / items.length : 0),
      avgTotalMs: Math.round(mean(times) || 0),
      p95TotalMs: percentile(times, 0.95),
      avgQualityScore: Math.round(mean(scores) || 0),
      issues: [...new Set(items.flatMap((item) => item.quality?.issues || []))],
    };
  });

  return {
    profileId: profile.id,
    profileName: profile.name,
    profileRole: profile.role || "target",
    provider: profile.provider,
    model: profile.defaultModel,
    protocol: profile.protocol,
    channelCode: profile.channelCode || "",
    caseCount: records.length,
    successCount: successRecords.length,
    successRate,
    successRateText: formatPercent(successRate),
    successRateCi: proportionReport(successRecords.length, records.length),
    avgTotalMs: Math.round(mean(totalTimes) || 0),
    p95TotalMs: percentile(totalTimes, 0.95),
    p99TotalMs: percentile(totalTimes, 0.99),
    avgQualityScore,
    inputTokens,
    outputTokens,
    cacheCreationTokens: usageTotals.cacheCreationTokens,
    cacheReadTokens: usageTotals.cacheReadTokens,
    reasoningTokens: usageTotals.reasoningTokens,
    tokenAudit,
    tokenAuditFindings: tokenAudit.flags || [],
    ...economics,
    errorCounts,
    diagnostics: buildErrorDiagnostics(errorCounts),
    recommendation: buildScenarioRecommendation(successRate, avgQualityScore, percentile(totalTimes, 0.95), errorCounts),
    scenarios,
    // LLM 裁判审计结论（审计模式，仅记录，不参与 recommendation）。null=未启用/无裁判。
    judgeAudit,
    // 本次评测的实际消耗（跑后记录）：目标渠道 + 裁判调用合计。
    actualConsumption: buildActualConsumption(
      { inputTokens, outputTokens, cost: economics.estimatedCost },
      judgeAudit?.judgeConsumption || null,
    ),
    records,
  };
}

// 合并目标渠道与裁判调用的真实消耗。cost 为 null（未填单价）时不计入合计，
// totalCost 仅在至少一侧有金额时给数，否则 null（区分“0”与“未知”）。
function buildActualConsumption(target, judge) {
  const costs = [target?.cost, judge?.cost].filter((c) => typeof c === "number" && Number.isFinite(c));
  return {
    target: { inputTokens: target?.inputTokens ?? null, outputTokens: target?.outputTokens ?? null, cost: target?.cost ?? null },
    judge: judge ? { calls: judge.calls, inputTokens: judge.inputTokens, outputTokens: judge.outputTokens, cost: judge.cost ?? null } : null,
    totalCost: costs.length ? Math.round(costs.reduce((a, b) => a + Number(b), 0) * 1_000_000) / 1_000_000 : null,
  };
}

export function buildScenarioSummary({
  runId,
  profileResults,
  selectedScenarios,
  maxParallelProfiles,
  requestConcurrency,
  repeats,
  startedAt,
  endedAt,
}) {
  return {
    runId,
    type: "scenario",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    profileCount: profileResults.length,
    scenarioCount: selectedScenarios.length,
    repeats,
    maxParallelProfiles,
    requestConcurrency,
    scenarios: selectedScenarios.map(maskScenario),
    results: profileResults,
  };
}
