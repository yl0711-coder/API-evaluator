// server/summaries.mjs
// 汇总层：把逐请求测试记录聚合成稳定性 / 场景 汇总（成功率与置信区间、延迟分位、
// token 与成本、错误分布、纯度与计费审计），供 reporting.mjs 渲染报告。
import { maskScenario } from "./profile-store.mjs";
import { aggregateUsage, buildRunConsumption, estimateProfileRunEconomics } from "./costing.mjs";
import { proportionReport } from "./stats.mjs";
import { auditRunTokenUsage } from "./token-auditor.mjs";
import { buildErrorDiagnostics, buildRecommendation, buildScenarioRecommendation, countErrors } from "./reporting.mjs";
import { formatPercent, groupBy, isFiniteNumber, mean, percentile, summarizeText } from "./utils.mjs";

// 缓存命中率：命中缓存的输入 token 占总输入 token 的比例。返回 null 表示该批记录
// 完全没有缓存统计信号（如纯 OpenAI 协议无 usage 明细），区分于「有信号但真是 0 命中」。
function computeCacheHitRate(records) {
  const withSignal = records.filter((r) => isFiniteNumber(r.cacheReadTokens) && isFiniteNumber(r.inputTokens) && r.inputTokens > 0);
  if (withSignal.length === 0) return null;
  const totalInput = withSignal.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalCacheRead = withSignal.reduce((sum, r) => sum + (r.cacheReadTokens || 0), 0);
  return totalInput > 0 ? totalCacheRead / totalInput : null;
}

function buildStabilityGroupBreakdown(records) {
  const groups = groupBy(records, (record) => record.groupId ?? "default");
  return Object.entries(groups).map(([groupId, items]) => {
    const okItems = items.filter((item) => item.success);
    const times = okItems.map((item) => item.totalMs).filter(isFiniteNumber);
    const groupSuccessRate = items.length ? okItems.length / items.length : 0;
    const cacheHitRate = computeCacheHitRate(items);
    return {
      groupId: groupId === "default" ? null : groupId,
      promptPreview: summarizeText(items[0]?.groupPrompt || ""),
      count: items.length,
      successCount: okItems.length,
      successRate: groupSuccessRate,
      successRateText: formatPercent(groupSuccessRate),
      avgTotalMs: Math.round(mean(times) || 0),
      p95TotalMs: percentile(times, 0.95),
      cacheHitRate,
      cacheHitRateText: cacheHitRate == null ? null : formatPercent(cacheHitRate),
    };
  });
}

// 手填温度被传输层摘掉的请求数。该模型拒收自定义 temperature（进程级记忆，见 upstream-transport.mjs
// 的 TEMPERATURE_UNSUPPORTED_MODELS），这些请求实际跑的是模型默认温度、而非用户所填的值。
// 必须在汇总里留痕：否则用户会把报告数字读成「我设的那个温度下的表现」。
// 准入路径（server/test-runner.mjs 的 buildAdmissionSummary）也有温度入口，同样要留痕，故导出。
export function countTemperatureStripped(records) {
  return records.filter((item) => item.temperatureStripped).length;
}

export function buildStabilitySummary({ runId, profile, records, rounds, concurrency, prompt, startedAt, endedAt }) {
  const successRecords = records.filter((item) => item.success);
  const failedRecords = records.filter((item) => !item.success);
  const totalTimes = successRecords.map((item) => item.totalMs).filter(isFiniteNumber);
  const firstByteTimes = successRecords.map((item) => item.firstByteMs).filter(isFiniteNumber);
  const outputChars = successRecords.map((item) => item.outputChars).filter(isFiniteNumber);
  const errorCounts = countErrors(failedRecords);
  const successRate = records.length > 0 ? successRecords.length / records.length : 0;
  // 首次成功率（ADM-009 的成功率部分）：重试会把"首次 503、第二次成功"记成一次成功，
  // 只看 successRate 会比真实用户的首次请求体验乐观。record.attempts 是实际发出的请求次数，
  // attempts===1 且成功 = 首次就成功。
  // 只要有一条记录缺 attempts 就返回 null——把缺失当成 1 会把未知说成"首次成功"，
  // 那正是本项要修的假通过。延迟的双口径（首次 / 端到端）仍待 upstream-transport 改造。
  const hasAttempts = records.length > 0 && records.every((item) => Number(item.attempts) >= 1);
  const firstAttemptSuccessCount = hasAttempts ? successRecords.filter((item) => Number(item.attempts) === 1).length : null;
  const firstAttemptSuccessRate = hasAttempts ? firstAttemptSuccessCount / records.length : null;
  const recoveredCount = hasAttempts ? successRecords.length - firstAttemptSuccessCount : null;
  const p95TotalMs = percentile(totalTimes, 0.95);
  const recommendation = buildRecommendation(successRate, p95TotalMs, errorCounts);
  const usageTotals = aggregateUsage(records);
  const { inputTokens, outputTokens } = usageTotals;
  const economics = estimateProfileRunEconomics(profile, { inputTokens, outputTokens });
  const cacheHitRate = computeCacheHitRate(records);
  const groups = buildStabilityGroupBreakdown(records);
  // 计费灌水审计（整轮聚合，复用 prompt/输出/usage，不发新请求）
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
    // 双口径：successRate 是重试后的最终成功率，下面两个描述"没有重试兜底时"的表现。
    // null 表示这批记录没有 attempts 信息，无法判断，不能当作首次全成功。
    firstAttemptSuccessCount,
    firstAttemptSuccessRate,
    firstAttemptSuccessRateText: firstAttemptSuccessRate === null ? null : formatPercent(firstAttemptSuccessRate),
    recoveredCount,
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
    cacheHitRate,
    cacheHitRateText: cacheHitRate == null ? null : formatPercent(cacheHitRate),
    groups,
    tokenAudit,
    tokenAuditFindings: tokenAudit.flags || [],
    temperatureStrippedCount: countTemperatureStripped(records),
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
  // 能力分母排除被截断的题（输出不完整无法判分，否则把"窗口/中转限制"误判成"模型能力差"）。
  const qualityScores = records
    .filter((record) => !record.quality?.truncated)
    .map((record) => record.quality?.score)
    .filter(isFiniteNumber);
  const successRate = records.length > 0 ? successRecords.length / records.length : 0;
  const avgQualityScore = Math.round(mean(qualityScores) || 0);
  const errorCounts = countErrors(failedRecords);
  const usageTotals = aggregateUsage(records);
  const { inputTokens, outputTokens } = usageTotals;
  const economics = estimateProfileRunEconomics(profile, { inputTokens, outputTokens });
  // 计费审计：场景测试每条 prompt 不同，做输出侧审计（输出计费更贵，是主要灌水向量）
  const tokenAudit = auditRunTokenUsage(
    records.map((record) => ({
      outputText: record.responseText || "",
      usage: { outputTokens: record.outputTokens },
    })),
  );
  const scenarioGroups = groupBy(records, (record) => record.scenarioId);
  const scenarios = Object.entries(scenarioGroups).map(([scenarioId, items]) => {
    const okItems = items.filter((item) => item.success);
    // 质量分只统计未被截断的题（截断=输出不完整，无法判分，排除出能力分母）。
    const scoredItems = items.filter((item) => !item.quality?.truncated);
    const scores = scoredItems.map((item) => item.quality?.score).filter(isFiniteNumber);
    const times = okItems.map((item) => item.totalMs).filter(isFiniteNumber);
    const truncatedCount = items.length - scoredItems.length;
    // 报告「模型样例回答」列用：优先取一条未截断的成功回答；全截断/全失败时退回首条并标注。
    // responseSummary 在落库时已 summarizeText（截断+脱敏），此处只是挑一条代表样例。
    const sampleItem = okItems.find((item) => !item.quality?.truncated) || okItems[0] || items[0] || null;
    const sampleText = sampleItem?.responseSummary || sampleItem?.rawError || "";
    return {
      scenarioId,
      scenarioName: items[0]?.scenarioName || scenarioId,
      category: items[0]?.category || "",
      difficulty: items[0]?.difficulty || "",
      count: items.length,
      successCount: okItems.length,
      truncatedCount,
      successRate: items.length ? okItems.length / items.length : 0,
      successRateText: formatPercent(items.length ? okItems.length / items.length : 0),
      avgTotalMs: Math.round(mean(times) || 0),
      p95TotalMs: percentile(times, 0.95),
      avgQualityScore: Math.round(mean(scores) || 0),
      issues: [...new Set(items.flatMap((item) => item.quality?.issues || []))],
      sampleResponse: sampleItem?.quality?.truncated ? `（输出已截断）${sampleText}` : sampleText,
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
    temperatureStrippedCount: countTemperatureStripped(records),
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
    judge: judge
      ? { calls: judge.calls, inputTokens: judge.inputTokens, outputTokens: judge.outputTokens, cost: judge.cost ?? null }
      : null,
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
    // 逐 API 精简摘要：供前端「汇总结论」卡使用。任务通道会剥离重字段 results/records，
    // 这里单列一份轻量副本（仅卡片所需字段）确保前端拿得到。
    profileDigest: profileResults.map((p) => ({
      profileId: p.profileId,
      profileName: p.profileName,
      model: p.model,
      successRateText: p.successRateText,
      avgQualityScore: p.avgQualityScore,
      p95TotalMs: p.p95TotalMs,
      recommendation: p.recommendation,
      // 手填温度被摘的请求数：digest 是前端唯一可靠来源（results/records 会被任务通道剥掉），
      // 提示要显示就必须在这里带上。
      temperatureStrippedCount: p.temperatureStrippedCount || 0,
      caseCount: p.caseCount, // 上面那条提示的分母（「N/总数 次请求」）
    })),
    results: profileResults,
  };
}
