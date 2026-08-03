// server/test-runner.mjs
// 测试执行引擎：构造并发起对被测 API 的探测请求（普通生成 / 工具调用 / 流式结构），
// 归一化结果与错误、落库为脱敏测试记录，并编排准入 / 稳定性 / 场景 / 快检各类测试。
import crypto from "node:crypto";
import { executeUpstreamRequest, streamCompletenessError } from "./upstream-transport.mjs";
import { buildAiAnalysisResult, buildAiReportAnalysisPrompt, isAiReportAnalysisEnabled } from "./ai-report-analysis.mjs";
import { getSettings } from "./settings-store.mjs";
import { getTestScenarios } from "./scenarios/index.mjs";
import { REQUEST_LOG_FILE, TEST_RUNS_FILE } from "./paths.mjs";
import { loadRunnableProfiles, resolveAdhocTarget } from "./run-targets.mjs";
import { loadModelTargets, saveModelTargets } from "./model-target-store.mjs";
import { computeEarnedTags, applyEarnedTags } from "./scenario-tag-award.mjs";
import { P95_LATENCY_SLOW_MS } from "./constants.mjs";
import {
  ADMISSION_POLICY_VERSION,
  ITEM_STATUS,
  OBSERVATION_ONLY_CASE_IDS,
  computeAdmissionScore,
  evaluateAdmission,
  pickSevereError,
  resolveGroupStatus,
  resolveItemStatus,
  validateStructuredJsonCase,
  validateWeatherToolCall,
} from "./admission-policy.mjs";
import { evaluateScenarioOutput } from "./scenario-evaluator.mjs";
// readProfileApiKey / assertPublicTarget 已随 runUpstreamProbe 迁至 upstream-transport.mjs
import {
  buildFingerprintProbeCases,
  buildFingerprintProbeSummary,
  buildPurityAssessment,
  buildTokenAudit,
  evaluateFingerprintProbe,
  getBaseFingerprintProbeTexts,
  inferModelFamily,
  normalizeModelFamily,
} from "./model-fingerprint.mjs";
import {
  buildProtocolRequest,
  buildProtocolStreamRequest,
  buildProtocolToolRequest,
  coalesceSseResponse,
  extractFinishReason,
  extractOutputText,
  extractToolCall,
  extractUsage,
  normalizeEmptyResponse,
  summarizeStreamStructure,
} from "./protocols.mjs";
import { buildRunConsumption, estimateProfileRunEconomics } from "./costing.mjs";
import { auditAbsoluteTokens, auditBillingDimensions } from "./token-auditor.mjs";
import { auditTokenizerFingerprint, resolveBaselineModel } from "./tokenizer-fingerprint-audit.mjs";
import { TOKENIZER_PROBES } from "./tokenizer-probes.mjs";
import {
  countErrors,
  formatAdmissionReport,
  formatAiAnalysisDocument,
  formatBatchReport,
  formatQuickVerifyReport,
  formatScenarioReport,
  formatStabilityReport,
  saveAiAnalysisReport,
  saveReportFiles,
} from "./reporting.mjs";
import { buildScenarioProfileSummary, buildScenarioSummary, buildStabilitySummary } from "./summaries.mjs";
import { buildFingerprintSnapshot, trackModelFingerprint } from "./fingerprint-tracking.mjs";
import { buildTierProbeCases, classifyTierFromRecords, evaluateTierCase, loadTierContext } from "./tier-admission.mjs";
import { buildTrendSeries, detectRegression, toTrendPoint } from "./regression.mjs";
import { queryProfileRunSummaries, recordRegressionAlert, recordRequest, recordSpend, recordTestRun } from "./db.mjs";
import { isLiveJudgeEnabled, runLiveJudgeAudit } from "./live-adapters.mjs";
import { assertTaskNotCancelled, updateTaskProgress } from "./task-manager.mjs";
import {
  appendJsonLine,
  clampNumber,
  compactDate,
  mean,
  parseLooseJson,
  percentile,
  redactSensitiveText,
  safeJson,
  summarizeText,
  sumNullable,
} from "./utils.mjs";
import { saveRunArtifacts } from "./workspace-store.mjs";

// 以下从 upstream-transport.mjs 搬出；重导出以维持下游兼容。
export { MAX_UPSTREAM_RESPONSE_BYTES, MAX_UPSTREAM_STREAM_RESPONSE_BYTES, streamCompletenessError } from "./upstream-transport.mjs";

// Owns all real upstream evaluation work. server.mjs should route requests here
// instead of carrying test execution details in the HTTP entrypoint.
async function attachRunArtifacts(runId, summary, artifacts = {}) {
  const files = await saveRunArtifacts(runId, {
    summary,
    ...artifacts,
  });
  return {
    ...summary,
    ...files,
  };
}

// 报告命名：渠道_模型；取不到渠道/模型则返回空串（→ 多目标）。profile.name = "渠道 / 模型"。
// 导出：压测模块（load-test.mjs）复用同一套报告命名，避免重复实现。
export function reportTargetSlug(profile) {
  const channel = String(profile?.name || "")
    .split(" / ")[0]
    .trim();
  const model = String(profile?.defaultModel || profile?.model || "").trim();
  if (!channel) return model;
  return model ? `${channel}_${model}` : channel;
}
// 报告 id：渠道_模型_测试_YYYYMMDD_HHMMSS_短哈希；headSlug 为空（多目标）时用「多目标」。
export function buildReportId(type, headSlug) {
  const stamp = compactDate(new Date()).replace("-", "_"); // YYYYMMDD_HHMMSS
  const hash = crypto.randomUUID().slice(0, 4);
  const head = (headSlug || "").trim() || "多目标";
  return `${head}_${type}_${stamp}_${hash}`;
}

// 轻量快检（quick-verify）：固定一小撮探针、输出封顶控成本，一次性给出
// 【真伪 + token 虚报 + 真实消耗】速报。最大化复用准入引擎。
const QUICK_VERIFY_MAX_OUTPUT = 96;

// 场景测试统一输出窗口。答案纪律后缀已把 LiveBench 输出压到几百 token，更大的窗口在中转侧
// 也未生效；统一 4096 既够任何场景输出又可预期。对场景测试覆盖渠道配置（只作用于场景路径）。
const SCENARIO_MAX_OUTPUT_TOKENS = 4096;

export async function runQuickVerify(body, taskContext = {}) {
  const profiles = await loadRunnableProfiles();
  const profile = profiles.find((item) => item.id === body.profileId);
  if (!profile) {
    throw new Error("没有找到被测 API 配置。");
  }

  const runId = buildReportId("quickverify", reportTargetSlug(profile));
  const startedAt = new Date();
  // token 高效：探针输出封顶（指纹/身份只需短 JSON），单次成本可预估、可控。
  const leanProfile = { ...profile, maxTokens: Math.min(Number(profile.maxTokens) || QUICK_VERIFY_MAX_OUTPUT, QUICK_VERIFY_MAX_OUTPUT) };

  // 极简用例集：连通 + 标称一致性 + 4 个固定文本指纹探针（提供 tokenizer 信号，跨渠道可比）。
  const cases = [
    { id: "connectivity", name: "连通", prompt: "请只回复一句：verify ok" },
    {
      id: "model_identity",
      name: "模型标称一致性",
      prompt: [
        "请严格返回 JSON，不要使用 Markdown。",
        "字段必须包含 modelFamily、modelGeneration、confidence、evidence。",
        "modelFamily 只能填写 claude、openai、gemini、deepseek、glm、doubao、kimi、grok、unknown 之一。",
        "请根据你当前可见的模型标识和能力边界回答；如果无法确认，请填写 unknown，不要编造。",
      ].join("\n"),
    },
    ...buildFingerprintProbeCases({ modelName: profile.defaultModel, includeFamilySpecific: false }),
  ];

  const records = [];
  for (const testCase of cases) {
    assertTaskNotCancelled(taskContext);
    const record = await executeAdmissionTestCase(leanProfile, testCase, runId, taskContext);
    const admission = evaluateAdmissionCase(testCase, record);
    delete record.responseText;
    records.push({ ...record, caseName: testCase.name, admission });
  }
  const endedAt = new Date();

  const identityCheck = records.find((r) => r.caseId === "model_identity")?.admission?.identityCheck || null;
  const fingerprintSummary = buildFingerprintProbeSummary(records);
  const actualConsumption = buildRunConsumption(profile, records);

  const baseTexts = getBaseFingerprintProbeTexts();
  const probePoints = records
    .filter((r) => baseTexts[r.caseId] && Number(r.inputTokens) > 0)
    .map((r) => ({ id: r.caseId, text: baseTexts[r.caseId], reportedTokens: r.inputTokens }));
  let absoluteTokenAudit = { applicable: false };
  let fingerprintTracking = null;
  try {
    absoluteTokenAudit = await auditAbsoluteTokens({ probes: probePoints, model: profile.defaultModel });
  } catch {
    // best-effort
  }
  try {
    const snapshot = buildFingerprintSnapshot({
      profileId: profile.id,
      model: profile.defaultModel,
      runId,
      identityCheck,
      records,
      fingerprintSummary,
      protocol: profile.protocol,
      createdAt: endedAt.toISOString(),
    });
    fingerprintTracking = await trackModelFingerprint(snapshot);
  } catch {
    // best-effort
  }

  const verdict = buildQuickVerifyVerdict({ records, identityCheck, fingerprintSummary, absoluteTokenAudit, fingerprintTracking });

  // 成功率 + 延迟：让快检也进「稳定性趋势」与基线回归（可用性/耗时退化都能被看见、被告警）。
  const successCount = records.filter((r) => r.success).length;
  const okTotalTimes = records
    .filter((r) => r.success)
    .map((r) => r.totalMs)
    .filter(Number.isFinite);

  const summary = {
    runId,
    type: "quick-verify",
    profileId: profile.id,
    profileName: profile.name,
    model: profile.defaultModel,
    protocol: profile.protocol,
    channelCode: profile.channelCode || "",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    requestCount: records.length,
    successCount,
    successRate: records.length ? successCount / records.length : null,
    avgTotalMs: Math.round(mean(okTotalTimes) || 0),
    p95TotalMs: percentile(okTotalTimes, 0.95),
    verdict,
    identityCheck,
    fingerprintSummary,
    absoluteTokenAudit,
    fingerprintTracking,
    actualConsumption,
    cases: records.map((r) => ({
      id: r.caseId,
      name: r.caseName,
      passed: Boolean(r.admission?.passed),
      statusCode: r.statusCode,
      totalMs: r.totalMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      issue: r.admission?.issue,
    })),
  };

  const reportMarkdown = formatQuickVerifyReport(summary);
  const reportFiles = await saveReportFiles(runId, reportMarkdown, "快检报告");
  await persistTestRun({
    ...summary,
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    reportMarkdown: undefined,
  });
  return { ...summary, reportPath: reportFiles.markdownPath, reportHtmlPath: reportFiles.htmlPath, reportMarkdown };
}

// 快检判定（纯逻辑）：综合连通 / 标称 / 指纹 / token 虚报 → ok | watch | suspect。
export function buildQuickVerifyVerdict({ records = [], identityCheck, fingerprintSummary, absoluteTokenAudit, fingerprintTracking } = {}) {
  const order = { ok: 0, watch: 1, suspect: 2 };
  let level = "ok";
  const reasons = [];
  const bump = (l) => {
    if (order[l] > order[level]) level = l;
  };

  const connectivity = records.find((r) => r.caseId === "connectivity");
  if (connectivity && !connectivity.success) {
    bump("suspect");
    reasons.push(`连通失败：${connectivity.normalizedError || connectivity.rawError || "无响应"}`);
  }
  if (identityCheck?.status === "conflict") {
    bump("suspect");
    reasons.push(`标称冲突：标称 ${identityCheck.expectedFamily}，自述 ${identityCheck.reportedFamily}`);
  } else if (identityCheck?.status === "unknown") {
    bump("watch");
    reasons.push("模型未能明确自述身份");
  }
  if (fingerprintSummary?.totalCount && fingerprintSummary.passRate < 0.5) {
    bump("watch");
    reasons.push(`指纹探针通过率偏低（${fingerprintSummary.passRateText}）`);
  }
  if (absoluteTokenAudit?.applicable && absoluteTokenAudit.status === "inflation") {
    bump("suspect");
    reasons.push(`token 虚报约 ${absoluteTokenAudit.estimatedInflationPct}%（官方分词器绝对判定）`);
  } else if (fingerprintTracking?.tokenHonesty?.status === "suspected_inflation") {
    bump("suspect");
    reasons.push(fingerprintTracking.tokenHonesty.verdict);
  }
  if ((absoluteTokenAudit?.flags || []).some((f) => f.code === "tokenizer_family_mismatch")) {
    bump("suspect");
    reasons.push("token 计费与标称家族官方分词器不一致，疑似挂羊头");
  }

  const titles = {
    ok: "通过：未见明显异常",
    watch: "观察：有需留意项",
    suspect: "可疑：建议人工复核 / 要求上游解释",
  };
  return { level, title: titles[level], reasons };
}

// 归一化前端跑前预估（token 区间 + 请求数），记进 run 供"预测 vs 实际"对比。
// 前端无单价，故预测只有 token/请求；实际侧(actualConsumption/economics)才有成本。
function normalizePredicted(predicted) {
  if (!predicted || typeof predicted !== "object") return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const requests = num(predicted.requests);
  const lowTokens = num(predicted.lowTokens);
  const highTokens = num(predicted.highTokens);
  if (requests === null && lowTokens === null && highTokens === null) return null;
  return { requests, lowTokens, highTokens, source: "pre-run-estimate" };
}

export async function runAdmissionTest(body, taskContext = {}) {
  const profile = await resolveAdmissionProfile(body);
  if (!profile) {
    throw new Error("没有找到被测 API 配置。");
  }

  const packageLevel = ["quick", "standard", "deep"].includes(body.packageLevel) ? body.packageLevel : "standard";
  const runId = buildReportId("admission", reportTargetSlug(profile));
  const startedAt = new Date();
  const cases = buildAdmissionCases(packageLevel, profile.defaultModel);
  // 档位降级判别：仅 standard/deep + Claude + 有匹配档位参考时，追加"多跑几次的判别题"。
  const tierContext = packageLevel === "standard" || packageLevel === "deep" ? loadTierContext(profile.defaultModel) : null;
  if (tierContext) cases.push(...buildTierProbeCases(tierContext.reference));
  const records = [];

  for (const testCase of cases) {
    // 取消必须在每轮开头检查，否则「取消」只 abort 掉在飞的那一个请求，循环照样往下走：
    // 剩余用例的 fetch 因 signal 已 abort 而瞬间 reject，几秒内刷完全部用例、写一堆
    // status=0 的垃圾请求记录，任务最后还显示 27/27 99%。实测复现过（standard 档 Claude
    // 模型共 27 条用例，取消后 2 秒内多写了 24 行）。runQuickVerify 的循环一直是这么做的。
    assertTaskNotCancelled(taskContext);
    const record = await executeAdmissionTestCase(profile, testCase, runId, taskContext);
    const admission = evaluateAdmissionCase(testCase, record);
    delete record.responseText;
    records.push({
      ...record,
      caseName: testCase.name,
      admission,
    });
    // 单 API 准入作为独立异步任务跑时，进度条靠这里推进（standard 档 11 条用例，每条最长
    // 300s——不上报的话用户会看着 0% 干等十几分钟，然后倾向于重新点一次 = 双花）。
    // 作为 admission-suite 的一个步骤被嵌套调用时，taskContext 是隔离过的子上下文，
    // 这里的计数写不进去、只透出 message，不会污染外层的步骤进度。
    updateTaskProgress(taskContext, records.length, cases.length, `准入评测进行中：${records.length}/${cases.length} 项用例`);
  }

  const endedAt = new Date();
  let summary = buildAdmissionSummary({
    runId,
    profile,
    records,
    packageLevel,
    startedAt,
    endedAt,
    tierContext,
  });
  summary = await attachRunArtifacts(runId, summary, { records });
  summary.predictedConsumption = normalizePredicted(body.predicted);
  try {
    const snapshot = buildFingerprintSnapshot({
      profileId: profile.id,
      model: profile.defaultModel,
      runId,
      identityCheck: summary.identityCheck,
      records,
      fingerprintSummary: summary.fingerprintSummary,
      protocol: profile.protocol,
      createdAt: endedAt.toISOString(),
    });
    summary.fingerprintTracking = await trackModelFingerprint(snapshot);
  } catch {
    // best-effort：指纹追踪失败不影响准入主流程
  }
  try {
    const baseTexts = getBaseFingerprintProbeTexts();
    const probePoints = records
      .filter((record) => baseTexts[record.caseId] && Number(record.inputTokens) > 0)
      .map((record) => ({ id: record.caseId, text: baseTexts[record.caseId], reportedTokens: record.inputTokens }));
    summary.absoluteTokenAudit = await auditAbsoluteTokens({ probes: probePoints, model: profile.defaultModel });
  } catch {
    // best-effort：绝对 token 审计失败不影响准入主流程
  }
  const tokenizerProbeRecords = []; // 分词器探针虽 writeLog:false，但真实打到上游，需计入"实际上游消耗"口径
  try {
    // 分词器指纹核验：仅当声称 Claude 家族。有该代本地基线才发探针(避免无谓请求)。
    if (inferModelFamily(profile.defaultModel) === "claude") {
      if (resolveBaselineModel(profile.defaultModel)) {
        const points = [];
        for (const probe of TOKENIZER_PROBES) {
          assertTaskNotCancelled(taskContext);
          const probeRecord = await measureProbeInputTokens(profile, probe.text, { runId });
          tokenizerProbeRecords.push(probeRecord);
          if (Number(probeRecord.inputTokens) > 0) points.push({ id: probe.id, reportedTokens: probeRecord.inputTokens });
        }
        summary.tokenizerFingerprint = auditTokenizerFingerprint({ model: profile.defaultModel, points });
      } else {
        // 声称 Claude 但本地没有该代基线 → 标 applicable:false（附原因），不发探针。
        summary.tokenizerFingerprint = auditTokenizerFingerprint({ model: profile.defaultModel, points: [] });
      }
    }
  } catch {
    // best-effort：分词器指纹失败不影响准入主流程
  }
  // 实际上游口径（仅报告体现，不进 UI 卡）：报告"请求数/合计 token"按逻辑用例计（重试合并、静默探针不计），
  // 与中转后台对账会偏小。这里另算一份真实打到上游的口径——含每个用例的重试次数 + 14 个分词器探针。
  summary.upstreamUsage = buildUpstreamUsage(records, tokenizerProbeRecords);
  summary.regression = await assessRunRegression(summary);
  const aiAnalysis = await maybeBuildAiAnalysis({
    enabled: body.useAiReportAnalysis,
    reportType: "admission",
    profile,
    summary,
    runId,
    taskContext,
  });
  const reportMarkdown = formatAdmissionReport(summary, records, { aiAnalysis });
  const reportFiles = await saveReportFiles(runId, reportMarkdown, "模型准入评测报告");
  const aiAnalysisFiles = await saveAiAnalysisReport(
    runId,
    formatAiAnalysisDocument(aiAnalysis, { title: "模型准入评测 · AI 辅助分析" }),
    "模型准入评测 · AI 辅助分析",
  );

  await persistTestRun({
    ...summary,
    type: "admission",
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    aiAnalysisHtmlPath: aiAnalysisFiles?.htmlPath || null,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown: undefined,
  });

  return {
    ...summary,
    type: "admission",
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    aiAnalysisHtmlPath: aiAnalysisFiles?.htmlPath || null,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown,
  };
}

export async function runBatchAdmissionTest(body, taskContext = {}) {
  const profiles = await loadRunnableProfiles();
  const profileIds = normalizeProfileIds(body.profileIds);
  if (profileIds.length === 0) {
    throw new Error("请至少选择一个被测 API。");
  }

  const existingIds = new Set(profiles.map((profile) => profile.id));
  const validProfileIds = profileIds.filter((profileId) => existingIds.has(profileId));
  if (validProfileIds.length === 0) {
    throw new Error("没有找到可用的被测 API 配置。");
  }

  const packageLevel = ["quick", "standard", "deep"].includes(body.packageLevel) ? body.packageLevel : "standard";
  const maxParallelProfiles = clampNumber(body.maxParallelProfiles, 1, 3, 1);
  const batchId = buildReportId(
    "admission-batch",
    validProfileIds.length === 1 ? reportTargetSlug(profiles.find((p) => p.id === validProfileIds[0])) : "",
  );
  const startedAt = new Date();
  const results = [];

  for (let index = 0; index < validProfileIds.length; index += maxParallelProfiles) {
    assertTaskNotCancelled(taskContext);
    const batch = validProfileIds.slice(index, index + maxParallelProfiles);
    const settled = await Promise.allSettled(
      batch.map((profileId) =>
        runAdmissionTest(
          {
            ...body,
            profileId,
            packageLevel,
            predicted: null, // 预测记在批量总结里，不重复挂到每个子渠道
            // 每模型一篇独立报告：AI 分析随各自报告生成（此前批量只在批次层做一次）。
            useAiReportAnalysis: body.useAiReportAnalysis,
          },
          taskContext,
        ),
      ),
    );
    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(stripHeavyRunResult(result.value));
      } else {
        results.push({
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
    updateTaskProgress(
      taskContext,
      results.length,
      validProfileIds.length,
      `批量准入评测进行中：${results.length}/${validProfileIds.length} 个 API`,
    );
  }

  const endedAt = new Date();
  let summary = {
    batchId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    profileCount: validProfileIds.length,
    packageLevel,
    maxParallelProfiles,
    results,
  };
  summary = await attachRunArtifacts(batchId, summary, { results });
  summary.predictedConsumption = normalizePredicted(body.predicted);

  // 不再出合并报告：每个模型的报告已由各自 runAdmissionTest 落盘（渠道_模型_admission_…）。
  // 汇集各模型报告，作为本批任务的 reports[] 返回（供前端逐篇弹出 + 报告中心按渠道/模型筛选）。
  const reports = results
    .filter((r) => r && r.reportHtmlPath)
    .map((r) => ({
      runId: r.runId,
      profileId: r.profileId,
      profileName: r.profileName,
      model: r.model,
      grade: r.grade,
      score: r.score,
      successRateText: r.successRateText,
      reportPath: r.reportPath,
      reportHtmlPath: r.reportHtmlPath,
      aiAnalysisHtmlPath: r.aiAnalysisHtmlPath || null,
      rawJsonPath: r.rawJsonPath || null,
    }));

  const first = reports[0] || {};
  return {
    ...summary,
    type: "batch-admission",
    reports, // 每模型一篇（新契约）
    // 兼容标量：结果面板/历史按单篇读取，取第一篇。
    reportPath: first.reportPath || null,
    reportHtmlPath: first.reportHtmlPath || null,
    aiAnalysisHtmlPath: first.aiAnalysisHtmlPath || null,
    rawJsonPath: first.rawJsonPath || summary.rawJsonPath || null,
  };
}

export async function runStabilityTest(body, taskContext = {}) {
  const profiles = await loadRunnableProfiles();
  const profile = profiles.find((item) => item.id === body.profileId);
  if (!profile) {
    throw new Error("没有找到被测 API 配置。");
  }

  return runStabilityForProfile({
    profile,
    body,
    taskContext,
    onProgress: (completed, total) => {
      updateTaskProgress(taskContext, completed, total, `稳定性测试进行中：${completed}/${total} 轮`);
    },
  });
}

// 准入目标解析：优先 body.profileId（已登记的模型目标）；若带 channelId+model 且没有匹配的
// profileId，走临时（不落库）目标——用于对渠道下尚未登记的模型做一次性快速准入探测。
async function resolveAdmissionProfile(body) {
  if (body.profileId) {
    const profiles = await loadRunnableProfiles();
    const profile = profiles.find((item) => item.id === body.profileId);
    if (profile) return profile;
  }
  if (body.channelId && body.model) {
    return resolveAdhocTarget({ channelId: body.channelId, model: body.model });
  }
  return null;
}

function buildAdmissionCases(packageLevel, modelName = "") {
  const cases = [
    {
      id: "connectivity",
      name: "连通与模型响应",
      prompt: "请只回复一句：admission ok",
    },
    {
      id: "json_structure",
      name: "结构化输出",
      prompt: [
        "请严格返回 JSON，不要使用 Markdown。",
        "字段必须包含 channelReady、modelType、risk。",
        "channelReady 为 true，modelType 填当前模型类型的简短判断，risk 填 low。",
      ].join("\n"),
    },
    {
      id: "model_identity",
      name: "模型标称一致性",
      prompt: [
        "请严格返回 JSON，不要使用 Markdown。",
        "字段必须包含 modelFamily、modelGeneration、confidence、evidence。",
        "modelFamily 只能填写 claude、openai、gemini、deepseek、glm、doubao、kimi、grok、unknown 之一。",
        "请根据你当前可见的模型标识和能力边界回答；如果无法确认，请填写 unknown，不要编造。",
      ].join("\n"),
    },
    {
      id: "tool_call",
      name: "工具调用结构",
      kind: "tool",
    },
    {
      id: "stream_structure",
      name: "流式响应结构",
      kind: "stream",
      prompt: "请用一句话说明流式响应正常。",
    },
  ];

  if (packageLevel === "standard" || packageLevel === "deep") {
    cases.push(
      {
        id: "coding_small",
        name: "小型编程任务",
        prompt: [
          "下面这段 JavaScript 有一个明显问题，请说明问题并给出修复后的代码。",
          "",
          "function add(a, b) {",
          "  return a + b",
          "}",
          "console.log(add('1', 2))",
          "",
          "要求：简洁回答，必须包含修复后的代码。",
        ].join("\n"),
      },
      {
        id: "behavior_reasoning",
        name: "渠道行为解释",
        prompt: "用 4 点说明为什么同一个模型在不同 API 渠道上可能出现速度、稳定性和输出结构差异。要求具体、专业、不要泛泛而谈。",
      },
      ...buildFingerprintProbeCases({ modelName }),
    );
  }

  if (packageLevel === "deep") {
    cases.push({
      id: "long_context_light",
      name: "轻量长上下文",
      prompt: [
        "请阅读以下规则片段并输出 5 条可执行检查项。",
        "规则：接入 API 渠道前，需要确认协议类型、模型名、工具调用、流式响应、token 用量、超时表现、错误码归因、成本倍率和复测记录。",
        "请按“检查项 / 通过标准 / 失败处理”三列输出。",
      ].join("\n"),
    });
  }

  return cases;
}

async function executeAdmissionTestCase(profile, testCase, runId, taskContext = {}) {
  const baseOptions = {
    runId,
    caseId: testCase.id,
    caseName: testCase.name,
    writeLog: true,
    abortSignal: taskContext?.task?.abortController?.signal,
  };

  // 用例可声明自身输出上限（如档位判别题校准时限 256 token）。只下调、不上调：
  //   取 min(渠道配置, 用例上限)，既复现校准运行参数，又不会把硬推理题放成超时重请求。
  const effectiveProfile = testCase.maxTokens
    ? { ...profile, maxTokens: Math.min(Number(profile.maxTokens) || 512, testCase.maxTokens) }
    : profile;

  if (testCase.kind === "tool") {
    return executeToolCallTestRequest(effectiveProfile, baseOptions);
  }
  if (testCase.kind === "stream") {
    return executeStreamStructureTestRequest(effectiveProfile, testCase.prompt, baseOptions);
  }
  return executeTestRequest(effectiveProfile, testCase.prompt, baseOptions);
}

function evaluateAdmissionCase(testCase, record) {
  if (testCase.kind === "tool") {
    if (!record.success || !record.toolCall) {
      return { passed: false, issue: record.rawError || "没有返回期望的工具调用结构。" };
    }
    // 修 ADM-013：原实现只比对函数名，arguments 为 {}、损坏 JSON 或城市填错都算通过——
    // 而"能报出工具名但传不对参数"的渠道在真实业务里同样不可用。
    const check = validateWeatherToolCall(record.toolCall);
    return { passed: check.passed, issue: check.issue };
  }

  if (testCase.kind === "stream") {
    const passed = Boolean(record.success && record.streamValidation?.passed);
    const issues = record.streamValidation?.issues || [];
    return {
      passed,
      issue: passed ? "流式响应结构完整。" : issues.length ? `流式结构异常：${issues.join(", ")}` : record.rawError || "流式结构未通过。",
    };
  }

  if (!record.success) {
    return {
      passed: false,
      issue: record.normalizedError || record.rawError || "请求失败。",
    };
  }

  const text = String(record.responseSummary || "");
  if (testCase.id === "json_structure") {
    // 修 ADM-012：原实现只查字段【存在】（Object.hasOwn + 真值），于是
    // {"channelReady":"false","modelType":123,"risk":"critical"} 会通过——字符串 "false"
    // 是真值、数字 123 是真值、"critical" 也是真值。硬门槛必须校验类型和取值。
    const check = validateStructuredJsonCase(record.responseText || record.responseSummary);
    return { passed: check.passed, issue: check.issue };
  }
  if (testCase.id === "model_identity") {
    const parsed = parseLooseJson(record.responseText || record.responseSummary);
    const identityCheck = evaluateModelIdentity(record.model, parsed, record.responseText || record.responseSummary);
    return {
      passed: identityCheck.status !== "conflict",
      issue: identityIssueText(identityCheck),
      identityCheck,
    };
  }
  // 以下三项降为观察项（修 ADM-014）。判据仍是"命中关键词 + 长度阈值"——它既放过"逻辑错但
  // 词凑够"的回答，也误杀"正确但简洁"的回答，不足以支撑准入结论。observation:true 让
  // buildAdmissionSummary 把它们排除在计分通过率和硬门槛之外，但结果照样执行、照样展示为证据。
  // 要让它们重新参与判定，需要先有隔离执行器（编程题）或人工标定的评分器（解释题）。
  if (testCase.id === "coding_small") {
    const passed = /function|const|let|return|Number|parseInt|parseFloat|修复|代码/i.test(text) && text.length >= 50;
    return {
      passed,
      observation: true,
      issue: passed
        ? "观察项：编程小任务有有效回答（关键词与长度启发式，不作准入依据）。"
        : "观察项：编程回答过短或缺少修复代码（启发式判断，不阻断准入）。",
    };
  }
  if (testCase.id === "behavior_reasoning") {
    const passed = /(渠道|模型|协议|延迟|稳定|路由|缓存|限流)/.test(text) && text.length >= 80;
    return {
      passed,
      observation: true,
      issue: passed
        ? "观察项：行为解释具备基本专业性（关键词与长度启发式，不作准入依据）。"
        : "观察项：解释过短或缺少渠道评测关键点（启发式判断，不阻断准入）。",
    };
  }
  if (testCase.id === "long_context_light") {
    const passed = /(检查项|通过标准|失败处理|协议|模型|token|超时)/i.test(text) && text.length >= 120;
    return {
      passed,
      observation: true,
      issue: passed
        ? "观察项：规则理解与结构化整理完成（关键词与长度启发式，不作准入依据）。"
        : "观察项：检查项不完整（启发式判断，不阻断准入）。",
    };
  }
  if (testCase.id.startsWith("fingerprint_")) {
    return evaluateFingerprintProbe(testCase, record.responseText || record.responseSummary);
  }
  if (testCase.id.startsWith("tier_")) {
    return evaluateTierCase(testCase, record.responseText || record.responseSummary);
  }

  return {
    passed: true,
    issue: "请求正常返回。",
  };
}

function evaluateModelIdentity(modelName, parsed, rawText) {
  const expectedFamily = inferModelFamily(modelName);
  const reportedFamily = normalizeModelFamily(parsed?.modelFamily || parsed?.family || parsed?.provider || rawText);
  const confidence = String(parsed?.confidence || "")
    .trim()
    .toLowerCase();
  const evidence = summarizeText(parsed?.evidence || parsed?.notes || rawText || "");

  if (!expectedFamily) {
    return {
      status: reportedFamily ? "observed" : "unknown",
      expectedFamily: "unknown",
      reportedFamily: reportedFamily || "unknown",
      confidence,
      evidence,
    };
  }

  if (!reportedFamily || reportedFamily === "unknown") {
    return {
      status: "unknown",
      expectedFamily,
      reportedFamily: "unknown",
      confidence,
      evidence,
    };
  }

  if (reportedFamily !== expectedFamily) {
    return {
      status: "conflict",
      expectedFamily,
      reportedFamily,
      confidence,
      evidence,
    };
  }

  return {
    status: "aligned",
    expectedFamily,
    reportedFamily,
    confidence,
    evidence,
  };
}

function identityIssueText(identityCheck) {
  if (identityCheck.status === "aligned") {
    return `模型自述与标称家族一致：${identityCheck.expectedFamily}。`;
  }
  if (identityCheck.status === "conflict") {
    return `模型自述与标称家族冲突：标称 ${identityCheck.expectedFamily}，自述 ${identityCheck.reportedFamily}。`;
  }
  if (identityCheck.status === "observed") {
    return `模型标称家族无法从模型名判断，自述为 ${identityCheck.reportedFamily}。`;
  }
  return `模型没有明确自述家族，标称 ${identityCheck.expectedFamily}，需结合后续测试判断。`;
}

// 实际上游/计费口径：把每个用例的真实请求次数（含重试，record.attempts）与静默分词器探针都算进去，
// token 同理（含探针；重试的失败尝试不返回 usage，自然不计；流式无 usage，也不计——符合"不算流式"）。
function buildUpstreamUsage(records, probeRecords = []) {
  const attemptsOf = (r) => (Number(r?.attempts) > 0 ? Number(r.attempts) : 1);
  const sumAttempts = (list) => list.reduce((sum, r) => sum + attemptsOf(r), 0);
  const caseHits = sumAttempts(records);
  const probeHits = sumAttempts(probeRecords);
  const all = [...records, ...probeRecords];
  return {
    logicalRequestCount: records.length,
    billedRequestCount: caseHits + probeHits,
    probeRequestCount: probeHits,
    retryCount: caseHits - records.length + (probeHits - probeRecords.length),
    inputTokens: sumNullable(all.map((r) => r.inputTokens)),
    outputTokens: sumNullable(all.map((r) => r.outputTokens)),
  };
}

// 观察证据不参与计分（修 ADM-014，与 ADM-007 同源）：
//   - coding_small / behavior_reasoning / long_context_light：靠"关键词 + 长度"判分；
//   - fingerprint_* / tier_*（admission.probe）：按 PRD 7.6 只用于横向差异与历史漂移，
//     且指纹失败已在 purityAssessment 里单独扣分，再进 passRate 就是同一件事扣两次。
// 把它们算进 passRate，等于让启发式决定综合分 25 分的权重。它们仍然执行、仍然出现在
// cases[] 中（observation:true），只是不进计分、不进硬门槛。
function isObservationRecord(record) {
  return record?.admission?.observation === true || record?.admission?.probe === true || OBSERVATION_ONLY_CASE_IDS.includes(record?.caseId);
}

function buildAdmissionSummary({ runId, profile, records, packageLevel, startedAt, endedAt, tierContext = null }) {
  const requestCount = records.length;
  const successCount = records.filter((record) => record.success).length;
  const successRate = requestCount ? successCount / requestCount : 0;

  const gradedRecords = records.filter((record) => !isObservationRecord(record));
  const observationRecords = records.filter((record) => isObservationRecord(record));
  const gradedCaseCount = gradedRecords.length;
  const passedCount = gradedRecords.filter((record) => record.admission?.passed).length;
  const passRate = gradedCaseCount ? passedCount / gradedCaseCount : 0;

  const errorCounts = countErrors(records.filter((record) => !record.success));
  const avgTotalMs = mean(records.map((record) => record.totalMs)) ?? null;
  const p95TotalMs = percentile(
    records.map((record) => record.totalMs),
    0.95,
  );
  const inputTokens = sumNullable(records.map((record) => record.inputTokens));
  const outputTokens = sumNullable(records.map((record) => record.outputTokens));
  const tokenCoverage =
    records.filter((record) => record.inputTokens !== null || record.outputTokens !== null).length / Math.max(1, requestCount);

  const caseSummaries = records.map((record) => ({
    id: record.caseId,
    name: record.caseName,
    passed: Boolean(record.admission?.passed),
    observation: isObservationRecord(record),
    statusCode: record.statusCode,
    totalMs: record.totalMs,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    summary: record.responseSummary,
    issue: record.admission?.issue,
    identityCheck: record.admission?.identityCheck || null,
    streamValidation: record.streamValidation || null,
    probe: record.admission?.probe || false,
    signals: record.admission?.signals || [],
  }));

  // 三态而非布尔：用例没跑（如 quick 包不含编程题）必须是 not_applicable，不能靠 [].every()
  // 变成 true 白送分，也不能算成失败（修 ADM-007）。
  const jsonStatus = resolveItemStatus(caseSummaries, "json_structure");
  const toolCallStatus = resolveItemStatus(caseSummaries, "tool_call");
  const streamStatus = resolveItemStatus(caseSummaries, "stream_structure");
  const identityStatus = resolveItemStatus(caseSummaries, "model_identity");
  const observationStatus = resolveGroupStatus(caseSummaries, OBSERVATION_ONLY_CASE_IDS);
  const jsonPassed = jsonStatus === ITEM_STATUS.PASSED;
  const toolCallPassed = toolCallStatus === ITEM_STATUS.PASSED;
  const streamPassed = streamStatus === ITEM_STATUS.PASSED;
  const identityPassed = identityStatus === ITEM_STATUS.PASSED;
  const identityRecord = records.find((record) => record.caseId === "model_identity");
  const identityCheck = identityRecord?.admission?.identityCheck || null;

  // 修 ADM-018：显式优先级，不再取决于 errorCounts 的键插入顺序（即用例执行顺序）。
  const severeError = pickSevereError(errorCounts);

  const tokenAudit = buildTokenAudit(records);
  const billingAudit = auditBillingDimensions(records, { model: profile.defaultModel });
  const fingerprintSummary = buildFingerprintProbeSummary(records);
  const tierDiscrimination = classifyTierFromRecords(records, tierContext);
  const economics = estimateProfileRunEconomics(profile, { inputTokens, outputTokens });
  const purityAssessment = buildPurityAssessment({
    modelName: profile.defaultModel,
    protocol: profile.protocol,
    successRate,
    p95TotalMs,
    identityCheck,
    jsonPassed,
    toolCallPassed,
    streamPassed,
    errorCounts,
    tokenAudit,
    fingerprintSummary,
    tierDiscrimination,
  });
  // 综合分改由 policy 按"实际适用权重"归一化计算，不再把不存在的维度写死进分母。
  // 它只用于排序与历史对比，能否交付看下面的 verdict（PRD 7.6.1）。
  const score = computeAdmissionScore({
    successRate,
    passRate,
    jsonStatus,
    toolCallStatus,
    streamStatus,
    identityStatus,
    tokenCoverage,
    p95TotalMs,
    identityConflict: identityCheck?.status === "conflict",
  });
  const grade = gradeAdmission(score, { successRate, severeError, toolCallPassed, jsonPassed, streamPassed, identityCheck });
  const recommendation = buildAdmissionRecommendation(grade, { severeError, successRate, p95TotalMs });

  const summary = {
    runId,
    type: "admission",
    policyVersion: ADMISSION_POLICY_VERSION,
    profileId: profile.id,
    profileName: profile.name,
    profileRole: profile.role || "target",
    provider: profile.provider,
    model: profile.defaultModel,
    protocol: profile.protocol,
    channelCode: profile.channelCode || "",
    packageLevel,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    requestCount,
    successCount,
    successRate,
    successRateText: `${Math.round(successRate * 100)}%`,
    gradedCaseCount,
    passedCount,
    passRate,
    observation: {
      total: observationRecords.length,
      passed: observationRecords.filter((record) => record.admission?.passed).length,
      status: observationStatus,
    },
    score,
    grade,
    avgTotalMs,
    p95TotalMs,
    inputTokens,
    outputTokens,
    ...economics,
    jsonPassed,
    toolCallPassed,
    streamPassed,
    identityPassed,
    identityCheck,
    purityAssessment,
    tierDiscrimination,
    tokenAudit,
    billingAudit,
    actualConsumption: buildRunConsumption(profile, records),
    fingerprintSummary,
    errorCounts,
    recommendation,
    nextAction: nextActionForAdmission(grade),
    cases: caseSummaries,
  };

  // 修 ADM-008：硬门槛失败时综合分再高也不能翻案。verdict 与 grade 并存——grade 有 8 处
  // 下游消费方（等级跌落告警、高风险库、报告对比等），改它的语义会连带影响告警口径和
  // 历史可比性，所以这里只做纯增量字段。
  summary.verdict = evaluateAdmission(summary);
  return summary;
}

function gradeAdmission(score, { successRate, severeError, toolCallPassed, jsonPassed, streamPassed, identityCheck }) {
  if (severeError === "auth_failed" || severeError === "model_not_found") return "F";
  if (severeError === "content_block_not_found") return "E";
  if (severeError === "upstream_5xx" && successRate < 0.8) return "X";
  if (identityCheck?.status === "conflict" && score < 80) return "D";
  if (score >= 90 && toolCallPassed && jsonPassed && streamPassed) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 55) return "D";
  if (successRate > 0) return "E";
  return "F";
}

function buildAdmissionRecommendation(grade, { severeError, successRate, p95TotalMs }) {
  if (grade === "A" || grade === "B") {
    return {
      level: "pass",
      title: "可进入稳定性和复杂场景测试",
      detail: "基础协议、结构和任务行为表现正常，可以继续做更高轮数稳定性、编程场景和成本测算。",
    };
  }
  if (grade === "C") {
    return {
      level: "watch",
      title: "可观察，需要复测",
      detail: "基础链路可用，但存在部分结构、工具调用、耗时或 token 返回问题。建议先复核配置，再做小轮数复测。",
    };
  }
  if (severeError) {
    return {
      level: "fail",
      title: "暂不建议接入",
      detail: `检测到关键错误 ${severeError}。建议先确认协议类型、模型名、Key 权限和上游渠道状态。`,
    };
  }
  if (p95TotalMs && p95TotalMs > P95_LATENCY_SLOW_MS) {
    return {
      level: "watch",
      title: "链路较慢，需要观察",
      detail: "请求可以返回，但慢请求明显。建议换时段复测，并补充稳定性测试确认尾部延迟。",
    };
  }
  return {
    level: successRate > 0 ? "watch" : "fail",
    title: successRate > 0 ? "不建议直接开放" : "不可用",
    detail: successRate > 0 ? "有请求返回，但准入测试未达标。建议先内部排查和复测。" : "本轮没有有效响应，需要先修复配置或更换渠道。",
  };
}

function nextActionForAdmission(grade) {
  if (grade === "A" || grade === "B") return "进入稳定性测试和编程场景测试。";
  if (grade === "C") return "复核协议、模型名和工具调用后，再跑一次准入评测。";
  if (grade === "D" || grade === "E") return "先不要开放给用户，交给技术复核错误证据。";
  if (grade === "X") return "重点排查上游稳定性，换时段或换渠道复测。";
  return "暂停接入，先修复 Key、模型名、权限或上游状态。";
}

// 兜底文案：groups 缺失/为空/全部数量<=0 时退化为单组扁平路径（供旧调用方如
// standard-eval-controller.js 的内联 /api/tests/stability、auto-test-scheduler.mjs 继续使用）。
const DEFAULT_STABILITY_PROMPT = "请用两句话说明你可以正常工作，并返回当前测试编号。";

function normalizeStabilityGroups(body) {
  if (Array.isArray(body.groups) && body.groups.length > 0) {
    const groups = body.groups
      .map((group) => {
        const repeats = Number(group.repeats);
        if (!Number.isFinite(repeats) || repeats <= 0) return null;
        return {
          presetId: group.presetId != null ? String(group.presetId) : null,
          prompt: String(group.prompt || "").trim() || DEFAULT_STABILITY_PROMPT,
          repeats: clampNumber(repeats, 1, 20, 1),
        };
      })
      .filter(Boolean);
    if (groups.length > 0) return groups;
  }
  const rounds = clampNumber(body.rounds, 1, 100, 10);
  const prompt = String(body.prompt || "").trim() || DEFAULT_STABILITY_PROMPT;
  return [{ presetId: null, prompt, repeats: rounds }];
}

async function runStabilityForProfile({ profile, body, taskContext = {}, onProgress = null }) {
  const concurrency = clampNumber(body.concurrency, 1, 5, 1);
  const groups = normalizeStabilityGroups(body);
  const jobs = [];
  for (const group of groups) {
    for (let repeat = 1; repeat <= group.repeats; repeat += 1) {
      jobs.push({ group, repeat });
    }
  }
  const rounds = jobs.length;
  const runId = buildReportId("run", reportTargetSlug(profile));
  const startedAt = new Date();
  const records = [];

  for (let index = 0; index < jobs.length; index += concurrency) {
    assertTaskNotCancelled(taskContext);
    const batch = jobs.slice(index, index + concurrency).map((job, offset) => {
      const globalRound = index + offset + 1;
      const casePrompt = buildRoundPrompt(job.group.prompt, job.repeat, job.group.repeats);
      return executeTestRequest(profile, casePrompt, {
        runId,
        caseId: `round-${globalRound}`,
        writeLog: true,
        abortSignal: taskContext?.task?.abortController?.signal,
      }).then((record) => ({
        ...record,
        groupId: job.group.presetId,
        groupPrompt: job.group.prompt,
        repeat: job.repeat,
        repeatsInGroup: job.group.repeats,
      }));
    });
    records.push(...(await Promise.all(batch)));
    onProgress?.(records.length, rounds);
  }

  const endedAt = new Date();
  let summary = buildStabilitySummary({
    runId,
    profile,
    records,
    rounds,
    concurrency,
    prompt: groups[0]?.prompt || DEFAULT_STABILITY_PROMPT,
    startedAt,
    endedAt,
  });
  summary = await attachRunArtifacts(runId, summary, { records });
  summary.predictedConsumption = normalizePredicted(body.predicted);
  summary.regression = await assessRunRegression(summary);
  const aiAnalysis = await maybeBuildAiAnalysis({
    enabled: body.useAiReportAnalysis,
    reportType: "stability",
    profile,
    summary,
    runId,
    taskContext,
  });
  const reportMarkdown = formatStabilityReport(summary, records, { aiAnalysis });
  const reportFiles = await saveReportFiles(runId, reportMarkdown, "稳定性测试报告");
  const aiAnalysisFiles = await saveAiAnalysisReport(
    runId,
    formatAiAnalysisDocument(aiAnalysis, { title: "稳定性测试 · AI 辅助分析" }),
    "稳定性测试 · AI 辅助分析",
  );

  await persistTestRun({
    ...summary,
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    aiAnalysisHtmlPath: aiAnalysisFiles?.htmlPath || null,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown: undefined,
  });

  return {
    ...summary,
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    aiAnalysisHtmlPath: aiAnalysisFiles?.htmlPath || null,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown,
  };
}

export async function runBatchStabilityTest(body, taskContext = {}) {
  const profiles = await loadRunnableProfiles();
  const profileIds = normalizeProfileIds(body.profileIds);
  if (profileIds.length === 0) {
    throw new Error("请至少选择一个被测 API。");
  }

  const existingIds = new Set(profiles.map((profile) => profile.id));
  const validProfileIds = profileIds.filter((profileId) => existingIds.has(profileId));
  if (validProfileIds.length === 0) {
    throw new Error("没有找到可用的被测 API 配置。");
  }

  const batchId = buildReportId(
    "batch",
    validProfileIds.length === 1 ? reportTargetSlug(profiles.find((p) => p.id === validProfileIds[0])) : "",
  );
  const maxParallelProfiles = clampNumber(body.maxParallelProfiles, 1, 5, 2);
  const startedAt = new Date();
  const results = [];

  for (let index = 0; index < validProfileIds.length; index += maxParallelProfiles) {
    assertTaskNotCancelled(taskContext);
    const batch = validProfileIds.slice(index, index + maxParallelProfiles);
    const settled = await Promise.allSettled(
      batch.map((profileId) => {
        const profile = profiles.find((item) => item.id === profileId);
        return runStabilityForProfile({
          profile,
          body: {
            ...body,
            profileId,
            useAiReportAnalysis: false,
            predicted: null, // 预测记在批量总结里，不重复挂到每个子渠道
          },
          taskContext,
        });
      }),
    );
    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(stripHeavyRunResult(result.value));
      } else {
        results.push({
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
    updateTaskProgress(
      taskContext,
      results.length,
      validProfileIds.length,
      `批量稳定性测试进行中：${results.length}/${validProfileIds.length} 个 API`,
    );
  }

  const endedAt = new Date();
  let summary = {
    batchId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    profileCount: validProfileIds.length,
    maxParallelProfiles,
    rounds: clampNumber(body.rounds, 1, 100, 10),
    requestConcurrency: clampNumber(body.concurrency, 1, 5, 1),
    results,
  };
  summary = await attachRunArtifacts(batchId, summary, { results });
  summary.predictedConsumption = normalizePredicted(body.predicted);
  const aiAnalysisProfile = selectBatchAnalysisProfile(profiles, summary, validProfileIds);
  const aiAnalysis = await maybeBuildAiAnalysis({
    enabled: body.useAiReportAnalysis,
    reportType: "batch-stability",
    profile: aiAnalysisProfile,
    summary,
    runId: batchId,
    taskContext,
  });
  const reportMarkdown = formatBatchReport(summary, { aiAnalysis });
  const reportFiles = await saveReportFiles(batchId, reportMarkdown, "批量稳定性测试总报告");
  const aiAnalysisFiles = await saveAiAnalysisReport(
    batchId,
    formatAiAnalysisDocument(aiAnalysis, { title: "批量稳定性测试 · AI 辅助分析" }),
    "批量稳定性测试 · AI 辅助分析",
  );

  await persistTestRun({
    ...summary,
    type: "batch-stability",
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    aiAnalysisHtmlPath: aiAnalysisFiles?.htmlPath || null,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown: undefined,
  });

  return {
    ...summary,
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    aiAnalysisHtmlPath: aiAnalysisFiles?.htmlPath || null,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown,
  };
}

// 场景测验夺标：某模型在某场景 avgQualityScore >= 90 → 授予该场景的能力标签（并集去重、只增不撤）。
// profile.id === 模型目标 id，故按 result.profileId 直接回写模型目标。best-effort。
// 纯逻辑（推导应得标签 / 合并去重）抽到 scenario-tag-award.mjs 单测；此处只做开关门禁与读写编排。
async function awardScenarioTags(summary, selectedScenarios) {
  // 设置「为高分通过场景测试的模型添加对应标签」关闭时，即使 >=90 分也不授标签。
  if (!getSettings().enableAutoTag) return;
  const earnedByProfile = computeEarnedTags(summary, selectedScenarios);
  if (!earnedByProfile.size) return;
  const targets = await loadModelTargets();
  if (applyEarnedTags(targets, earnedByProfile, new Date().toISOString())) {
    await saveModelTargets(targets);
  }
}

// 可选的一次性数值覆盖：空/无效 → null（表示不覆盖，回落默认）；有效正数 → clamp 到 [min,max]。
// 注意不能直接用 clampNumber：Number("")===0 是有限值，会被 clamp 到 min 而非回落。
function optionalOverrideInt(value, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// 表单复选框未勾选时字段直接缺席，勾选时为 "1"；JSON 调用方可传 true/"true"/"on"/"yes"。
function isScenarioFlagOn(value) {
  return (
    value === true ||
    ["1", "true", "on", "yes"].includes(
      String(value ?? "")
        .trim()
        .toLowerCase(),
    )
  );
}

export async function runScenarioTest(body, taskContext = {}) {
  const profiles = await loadRunnableProfiles();
  const profileIds = normalizeProfileIds(body.profileIds);
  const scenarioIds = normalizeScenarioIds(body.scenarioIds);
  const selectedProfiles = profiles.filter((profile) => profileIds.includes(profile.id));
  const selectedScenarios = getTestScenarios().filter((scenario) => scenarioIds.includes(scenario.id));

  if (selectedProfiles.length === 0) {
    throw new Error("请至少选择一个被测 API。");
  }
  if (selectedScenarios.length === 0) {
    throw new Error("请至少选择一个测试场景。");
  }

  const runId = buildReportId("scenario", selectedProfiles.length === 1 ? reportTargetSlug(selectedProfiles[0]) : "");
  const maxParallelProfiles = clampNumber(body.maxParallelProfiles, 1, 5, 2);
  const requestConcurrency = clampNumber(body.requestConcurrency || body.concurrency, 1, 3, 1);
  const repeats = clampNumber(body.repeats, 1, 5, 1);
  // 一次性覆盖：仅本次运行生效，不持久化。留空则回落（maxTokens→场景默认 4096，timeoutMs→渠道配置）。
  const maxTokensOverride = optionalOverrideInt(body.maxTokens, 1, 32768);
  const timeoutMsOverride = optionalOverrideInt(body.timeoutMs, 1000, 600000);
  // 「在报告中完整显示返回」：表单复选框传 "1"；同时容忍 JSON 调用方传 true/"true"/"on"/"yes"。
  const fullResponseInReport = isScenarioFlagOn(body.fullResponseInReport);
  // 「发送流式请求（SSE）」：开启则整轮场景都走流式，并采集真 TTFT。
  const streamRequest = isScenarioFlagOn(body.streamRequest);
  const startedAt = new Date();
  const profileResults = [];
  if (taskContext?.task) {
    taskContext.task.totalUnits = selectedProfiles.length * selectedScenarios.length * repeats;
  }

  for (let index = 0; index < selectedProfiles.length; index += maxParallelProfiles) {
    assertTaskNotCancelled(taskContext);
    const batch = selectedProfiles.slice(index, index + maxParallelProfiles);
    const results = await Promise.all(
      batch.map((profile) =>
        runScenarioProfile({
          runId,
          profile,
          scenarios: selectedScenarios,
          repeats,
          requestConcurrency,
          maxTokensOverride,
          timeoutMsOverride,
          keepFullResponse: fullResponseInReport,
          streamRequest,
          taskContext,
        }),
      ),
    );
    profileResults.push(...results);
    updateTaskProgress(
      taskContext,
      profileResults.length,
      selectedProfiles.length,
      `场景测试进行中：${profileResults.length}/${selectedProfiles.length} 个 API`,
    );
  }

  const endedAt = new Date();

  // 汇总对象（仅供前端「汇总结论」卡与返回聚合字段：profileDigest/计数/type）；不再据此出合并报告。
  const aggregate = buildScenarioSummary({
    runId,
    profileResults,
    selectedScenarios,
    maxParallelProfiles,
    requestConcurrency,
    repeats,
    startedAt,
    endedAt,
  });
  aggregate.predictedConsumption = normalizePredicted(body.predicted);
  // 场景测验夺标：>=90 分给对应模型授予能力标签（对全体一次，标签本按 profile 归属）。best-effort。
  try {
    await awardScenarioTags(aggregate, selectedScenarios);
  } catch {
    /* 夺标失败不影响场景测试主流程 */
  }

  // 每个模型各出一篇独立报告（渠道_模型_scenario_…），可被报告中心按渠道/模型筛选。
  const reports = [];
  for (const profileResult of profileResults) {
    const profile = selectedProfiles.find((p) => p.id === profileResult.profileId) || null;
    const slug = reportTargetSlug(profile || { name: profileResult.profileName, defaultModel: profileResult.model });
    const perId = buildReportId("scenario", slug);
    let one = buildScenarioSummary({
      runId: perId,
      profileResults: [profileResult],
      selectedScenarios,
      maxParallelProfiles,
      requestConcurrency,
      repeats,
      startedAt,
      endedAt,
    });
    one = await attachRunArtifacts(perId, one, { profileResults: [profileResult] });
    one.predictedConsumption = normalizePredicted(body.predicted);
    const aiAnalysis = await maybeBuildAiAnalysis({
      enabled: body.useAiReportAnalysis,
      reportType: "scenario",
      profile,
      summary: one,
      runId: perId,
      taskContext,
    });
    const reportMarkdown = formatScenarioReport(one, { aiAnalysis, fullResponse: fullResponseInReport });
    const reportFiles = await saveReportFiles(perId, reportMarkdown, "场景测试报告");
    // 全文的用途到此为止：落库/返回前剥掉，避免 test-runs.jsonl、SQLite 与任务结果被回答全文撑大。
    // buildScenarioSummary 里 results 就是 profileResults 本身（同引用），删这里等于 one/aggregate 一起干净。
    if (fullResponseInReport) {
      for (const record of profileResult.records || []) {
        delete record.responseText;
        delete record.rawResponse;
        delete record.rawResponsePartial;
      }
    }
    const aiAnalysisFiles = await saveAiAnalysisReport(
      perId,
      formatAiAnalysisDocument(aiAnalysis, { title: "场景测试 · AI 辅助分析" }),
      "场景测试 · AI 辅助分析",
    );
    await persistTestRun({
      ...one,
      reportPath: reportFiles.markdownPath,
      reportHtmlPath: reportFiles.htmlPath,
      aiAnalysisHtmlPath: aiAnalysisFiles?.htmlPath || null,
      rawJsonPath: one.rawJsonPath,
      workspaceDir: one.workspaceDir,
      reportMarkdown: undefined,
    });
    reports.push({
      runId: perId,
      profileId: profileResult.profileId,
      profileName: profileResult.profileName,
      model: profileResult.model,
      successRateText: profileResult.successRateText,
      avgQualityScore: profileResult.avgQualityScore,
      reportPath: reportFiles.markdownPath,
      reportHtmlPath: reportFiles.htmlPath,
      aiAnalysisHtmlPath: aiAnalysisFiles?.htmlPath || null,
      rawJsonPath: one.rawJsonPath,
    });
  }

  const first = reports[0] || {};
  return {
    ...aggregate,
    reports, // 每模型一篇（新契约）
    // 兼容标量：视图/标准评测按单篇读取，取第一篇。
    reportPath: first.reportPath || null,
    reportHtmlPath: first.reportHtmlPath || null,
    aiAnalysisHtmlPath: first.aiAnalysisHtmlPath || null,
    rawJsonPath: first.rawJsonPath || aggregate.rawJsonPath || null,
  };
}

export const MAX_BATCH_PROFILES = 20; // 批量目标数硬上限:防一次选过多目标 × 轮数 × 并发把小机器(2C/2G)压垮

export function normalizeProfileIds(value) {
  const raw = Array.isArray(value)
    ? value.map((item) => String(item || "").trim())
    : String(value || "")
        .split(",")
        .map((item) => item.trim());
  // 去重 + 封顶(去重避免同目标重复跑;封顶是资源兜底,前端另给软提示)
  return [...new Set(raw.filter(Boolean))].slice(0, MAX_BATCH_PROFILES);
}

export function normalizeScenarioIds(value) {
  const ids = Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  return ids.length > 0 ? ids : getTestScenarios().map((scenario) => scenario.id);
}

async function runScenarioProfile({
  runId,
  profile,
  scenarios,
  repeats,
  requestConcurrency,
  maxTokensOverride = null,
  timeoutMsOverride = null,
  keepFullResponse = false,
  streamRequest = false,
  taskContext,
}) {
  const records = [];
  // LLM 裁判审计（内联）：仅在开关开启时收集 (问题, 回答) 对，回答剥离前抓取。
  const collectForJudge = isLiveJudgeEnabled();
  const judgeItems = [];
  const jobs = [];
  for (const scenario of scenarios) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      jobs.push({ scenario, repeat });
    }
  }

  for (let index = 0; index < jobs.length; index += requestConcurrency) {
    assertTaskNotCancelled(taskContext);
    const batch = jobs.slice(index, index + requestConcurrency);
    const batchRecords = await Promise.all(
      batch.map(async ({ scenario, repeat }) => {
        // 场景测试默认用 4096 输出窗口（覆盖渠道配置与 scenario.maxTokens）；
        // 高级设置里的一次性覆盖（若填写）优先。timeoutMs 默认继承渠道配置，同样可被一次性覆盖。
        const caseProfile = {
          ...profile,
          maxTokens: maxTokensOverride ?? SCENARIO_MAX_OUTPUT_TOKENS,
          timeoutMs: timeoutMsOverride ?? profile.timeoutMs,
        };
        const record = await executeTestRequest(caseProfile, buildScenarioPrompt(scenario, repeat, repeats), {
          runId,
          caseId: scenario.id,
          writeLog: true,
          stream: streamRequest,
          keepRawResponse: keepFullResponse,
          abortSignal: taskContext?.task?.abortController?.signal,
        });
        const quality = evaluateScenarioOutput(scenario, record);
        if (collectForJudge && record.success && record.responseText) {
          judgeItems.push({ question: scenario.prompt, answer: record.responseText, rubric: scenario.judgeRubric || "" });
        }
        // 回答全文默认剥离（会把 test-runs.jsonl / 任务结果撑大）；
        // 仅「在报告中完整显示返回」开启时留到出报告，出完立刻剥掉（见 runScenarioTest）。
        if (!keepFullResponse) {
          delete record.responseText;
          delete record.rawResponse;
          delete record.rawResponsePartial;
        }
        return {
          ...record,
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          category: scenario.category,
          difficulty: scenario.difficulty,
          repeat,
          quality,
        };
      }),
    );
    records.push(...batchRecords);
    updateTaskProgress(
      taskContext,
      taskContext?.task?.completedUnits + batchRecords.length,
      taskContext?.task?.totalUnits || jobs.length,
      `场景测试 ${profile.name}：${records.length}/${jobs.length} 个场景请求`,
    );
  }

  const judgeAudit = collectForJudge ? await maybeRunInlineJudgeAudit({ profile, items: judgeItems, runId, taskContext }) : null;
  return buildScenarioProfileSummary(profile, records, { judgeAudit });
}

// 内联裁判审计：审计模式（只记录，不改结论）。开关关 / 无裁判渠道 / 无回答 → 跳过。
// 裁判 = 配置里 role==="judge" 的渠道；额度上限默认 50（可 env 调），传 executeTestRequest 真实跑。
const JUDGE_AUDIT_MAX_CALLS = Number(process.env.EVALUATOR_JUDGE_MAX_CALLS || 50);
async function maybeRunInlineJudgeAudit({ profile, items, runId, taskContext }) {
  if (!isLiveJudgeEnabled() || !items || items.length === 0) return null;
  const profiles = await loadRunnableProfiles();
  const judgeProfiles = profiles.filter((p) => p.role === "judge");
  if (judgeProfiles.length === 0) {
    return {
      mode: "audit",
      ok: false,
      reason: "no_judge_channel",
      callsUsed: 0,
      note: "已开启裁判审计，但未配置「裁判 / 主 API」角色渠道，已跳过（不影响评测结论）。",
    };
  }
  return runLiveJudgeAudit({
    targetModel: profile.defaultModel,
    items,
    judgeProfiles,
    maxCalls: JUDGE_AUDIT_MAX_CALLS,
    runRequest: executeTestRequest,
    runId: `${runId}-judge`,
    abortSignal: taskContext?.task?.abortController?.signal,
  });
}

export { linkExternalAbort } from "./upstream-transport.mjs";

// 普通生成探测：解析输出文本与 usage；空回复按 normalizeEmptyResponse 归一。
// options.stream=true 时改发 SSE 流式请求（贴近真实前端流量，且可测真 TTFT）。
// 解析层无需分流：coalesceSseResponse 会把 SSE 拼回非流式响应形状，下面 interpret 原样复用。
export async function executeTestRequest(profile, prompt, options = {}) {
  const streaming = options.stream === true;
  return executeUpstreamRequest(profile, options, {
    captureFirstToken: streaming, // 真 TTFT 仅流式可测；非流式整体返回，保持 null
    finalizeRecord: finalizeTestRecord,
    buildRequest: (p) => (streaming ? buildProtocolStreamRequest(p, prompt, { includeUsage: true }) : buildProtocolRequest(p, prompt)),
    interpret: (r, raw) => {
      // 上游若无视 stream:false 回了 SSE，safeJson 读不出 → 用 SSE 兜底拼回非流式形状。
      const parsed = safeJson(raw) || coalesceSseResponse(profile.protocol, raw);
      r.responseText = extractOutputText(profile.protocol, parsed);
      r.usage = extractUsage(parsed);
      r.finishReason = extractFinishReason(profile.protocol, parsed);
      if (!r.responseText) {
        r.rawError = summarizeText(raw);
        r.normalizedError = normalizeEmptyResponse(raw);
      }
      // 流式完整性校验：coalesceSseResponse 会把「吐了一半就断」或「中途 error 帧」的流照样拼出文本，
      // 只看「2xx + 有文本」会把这种半截流判成功——成功率虚高，半截答案还进 LLM 裁判打分。
      // 复用准入路已有的 summarizeStreamStructure（此前只用在准入探测，未覆盖场景/压测流式路）。
      if (streaming) {
        r.streamValidation = summarizeStreamStructure(profile.protocol, raw);
        const streamError = streamCompletenessError(r.streamValidation);
        if (streamError) {
          r.normalizedError = streamError; // 覆盖：半截流即便拼出了文本也不算成功
          if (!r.rawError) r.rawError = (r.streamValidation.issues || []).join(", ");
        }
      }
    },
    // 流式：除「2xx + 有文本」外，还须流完整（无致命不完整信号）；非流式走 finalize 默认。
    computeSuccess: (r) =>
      streaming
        ? Boolean(
            r.statusCode && r.statusCode >= 200 && r.statusCode < 300 && r.responseText && !streamCompletenessError(r.streamValidation),
          )
        : undefined,
  });
}

// 分词器指纹探针：只为读取输入 token 数。max_tokens=1、不带 temperature（Opus 4.7+ 拒绝采样参数），
// 把产出成本压到最小；不写请求日志，避免污染准入分项明细。
function buildProbeTokenRequest(profile, text) {
  const baseUrl = profile.baseUrl.replace(/\/+$/, "");
  if (profile.protocol === "claude_messages") {
    return {
      url: `${baseUrl}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": profile.apiKey,
        "anthropic-version": profile.anthropicVersion || "2023-06-01",
      },
      body: { model: profile.defaultModel, max_tokens: 1, stream: false, messages: [{ role: "user", content: text }] },
    };
  }
  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${profile.apiKey}` },
    body: { model: profile.defaultModel, max_tokens: 1, stream: false, messages: [{ role: "user", content: text }] },
  };
}

async function measureProbeInputTokens(profile, text, options = {}) {
  return executeUpstreamRequest(
    profile,
    { writeLog: false, ...options },
    {
      finalizeRecord: finalizeTestRecord,
      buildRequest: (p) => buildProbeTokenRequest(p, text),
      interpret: (r, raw) => {
        r.usage = extractUsage(safeJson(raw) || coalesceSseResponse(profile.protocol, raw));
      },
      computeSuccess: (r) => Number(r.usage?.inputTokens) > 0,
    },
  );
}

// 工具调用探测：要求模型返回 tool_call；缺失记 tool_call_missing。成功 = 2xx 且拿到 toolCall。
export async function executeToolCallTestRequest(profile, options = {}) {
  return executeUpstreamRequest(profile, options, {
    finalizeRecord: finalizeTestRecord,
    buildRequest: (p) => buildProtocolToolRequest(p),
    interpret: (r, raw) => {
      const parsed = safeJson(raw) || coalesceSseResponse(profile.protocol, raw);
      r.toolCall = extractToolCall(profile.protocol, parsed);
      r.usage = extractUsage(parsed);
      r.responseText = r.toolCall ? `tool_call:${r.toolCall.name}` : extractOutputText(profile.protocol, parsed);
      if (!r.toolCall) {
        r.rawError = summarizeText(raw);
        r.normalizedError = "tool_call_missing";
      }
    },
    computeSuccess: (r) => Boolean(r.statusCode && r.statusCode >= 200 && r.statusCode < 300 && r.toolCall),
  });
}

// 流式结构探测：校验 SSE 事件结构（captureFirstToken 测真 TTFT）。成功 = 2xx 且结构校验通过。
export async function executeStreamStructureTestRequest(profile, prompt, options = {}) {
  return executeUpstreamRequest(profile, options, {
    captureFirstToken: true,
    finalizeRecord: finalizeTestRecord,
    buildRequest: (p) => buildProtocolStreamRequest(p, prompt),
    interpret: (r, raw) => {
      r.streamValidation = summarizeStreamStructure(profile.protocol, raw);
      r.responseText = `stream_events:${r.streamValidation.eventCount}; issues:${r.streamValidation.issues.join(",") || "none"}`;
      if (!r.streamValidation.passed) {
        r.rawError = r.streamValidation.issues.join(", ") || summarizeText(raw);
        r.normalizedError = r.streamValidation.issues.includes("content_block_not_found")
          ? "content_block_not_found"
          : "stream_structure_invalid";
      }
    },
    computeSuccess: (r) => Boolean(r.statusCode && r.statusCode >= 200 && r.statusCode < 300 && r.streamValidation?.passed),
  });
}

export { readBoundedResponseText } from "./upstream-transport.mjs";

export function stripHeavyRunResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const { reportMarkdown, records, ...safeResult } = result;
  return {
    ...safeResult,
    recordCount: Array.isArray(records) ? records.length : undefined,
  };
}

// 持久化一条测试运行汇总：JSONL 为可移植的事实来源，同时双写 SQLite 作查询索引（best-effort）。
// 基线回归评估：取该渠道同类历史中位数当基线，与本次比对；明显退化则落 regression_alerts。
// best-effort：失败返回 null，绝不影响测试主流程。
async function assessRunRegression(summary) {
  try {
    if (!summary?.profileId) return null;
    const history = await queryProfileRunSummaries(summary.profileId);
    const regression = detectRegression({ current: toTrendPoint(summary), history: buildTrendSeries(history) });
    if (regression.status === "regressed") {
      await recordRegressionAlert({
        profileId: summary.profileId,
        profileName: summary.profileName,
        runId: summary.runId,
        runType: summary.type,
        severity: regression.severity,
        summary: regression.changes.map((c) => c.detail).join("；"),
        createdAt: summary.endedAt,
      });
    }
    return regression;
  } catch {
    return null;
  }
}

async function persistTestRun(record) {
  await appendJsonLine(TEST_RUNS_FILE, record);
  await recordTestRun(record, { type: record.type || "" });
  // 记账：把本次测试的【真实消耗】写入 spend_ledger（兼容两种 actualConsumption 形态：
  // 准入/稳定性的 estimatedCost，场景的 totalCost）。best-effort，失败不影响主流程。
  try {
    const ac = record.actualConsumption;
    const actual = ac ? (ac.estimatedCost ?? ac.totalCost ?? null) : null;
    const estimated = record.predictedConsumption?.estimatedCost ?? null;
    if (ac && (actual !== null || estimated !== null)) {
      await recordSpend({
        runId: record.runId || record.batchId || null,
        estimated,
        actual,
        currency: ac.currency || "USD",
        createdAt: record.endedAt || null,
      });
    }
  } catch {
    // best-effort
  }
}

async function finalizeTestRecord({
  options,
  profile,
  requestId,
  startedAt,
  firstByteMs,
  firstTokenMs = null,
  stream = false,
  totalMs,
  statusCode,
  statusText = "",
  responseText,
  usage,
  finishReason = null,
  rawError,
  rawResponse = "",
  rawResponsePartial = false,
  normalizedError,
  toolCall = null,
  streamValidation = null,
  attempts = 1,
  successOverride = undefined,
}) {
  const record = {
    requestId,
    runId: options.runId || "manual-test",
    caseId: options.caseId || "",
    profileId: profile.id,
    profileName: profile.name,
    profileRole: profile.role || "target",
    provider: profile.provider,
    model: profile.defaultModel,
    protocol: profile.protocol,
    // 实际发出的输出窗口（场景题会把它抬到 scenario.maxTokens）。落进 requests.jsonl 便于
    // 直接核对"发的是不是 8192"，不必靠输出长度反推。
    requestMaxTokens: Number(profile.maxTokens) || null,
    // 实际发出的是不是 SSE 流式请求。诊断时不必再靠 firstTokenMs 反推（那会把「流式但没吐内容」
    // 的失败误判成非流式）。
    stream,
    startedAt: startedAt.toISOString(),
    firstByteMs,
    firstTokenMs,
    totalMs,
    statusCode,
    statusText, // 上游返回的原因短语（reason phrase），供压测报告逐码展示
    success: successOverride ?? Boolean(statusCode && statusCode >= 200 && statusCode < 300 && responseText),
    attempts,
    normalizedError,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheCreationTokens: usage?.cacheCreationTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    tokenSource: usage ? "upstream" : "unknown",
    outputChars: responseText.length,
    finishReason,
    responseSummary: summarizeText(responseText),
    responseText,
    toolCall,
    streamValidation,
    rawError: summarizeText(rawError),
    // 未截断原始响应（仅 keepRawResponse 时非空）。记录会原样写进工作区 result.json，
    // 故在此就脱敏，不能等到出报告时才做。
    rawResponse: rawResponse ? redactSensitiveText(rawResponse) : "",
    rawResponsePartial: Boolean(rawResponse) && rawResponsePartial === true,
  };

  if (options.writeLog !== false) {
    const logRecord = { ...record };
    // Full response text can be large and user-provided; keep reports useful but
    // avoid turning request logs into a data dump.
    delete logRecord.responseText;
    // 同上：日志留 rawError 的 500 字摘要即可（partial 标记是给它配套的，一并去掉）
    delete logRecord.rawResponse;
    delete logRecord.rawResponsePartial;
    await appendJsonLine(REQUEST_LOG_FILE, logRecord);
    // 双写 SQLite：逐请求全量历史，供统计严谨用。best-effort，
    // node:sqlite 不可用或出错时静默跳过，JSONL 仍是事实来源。
    await recordRequest(logRecord);
  }
  return record;
}

function buildRoundPrompt(prompt, round, rounds) {
  return [prompt, "", `本次是稳定性测试第 ${round}/${rounds} 轮。`, "请正常完成任务，不要只回复测试编号。"].join("\n");
}

function buildScenarioPrompt(scenario, repeat, repeats) {
  if (repeats <= 1) {
    return scenario.prompt;
  }
  return [
    scenario.prompt,
    "",
    `本次是场景测试 ${scenario.name} 的第 ${repeat}/${repeats} 次重复测试。`,
    "请正常完成任务，不要只回复测试编号。",
  ].join("\n");
}

async function maybeBuildAiAnalysis({ enabled, reportType, profile, summary, runId, taskContext }) {
  if (!isAiReportAnalysisEnabled(enabled)) {
    return { enabled: false };
  }
  assertTaskNotCancelled(taskContext);
  // 优先用「设置」里指定的 AI 总结模型（一个已配置的模型目标）；未指定/失效则用被测渠道自己。
  const settings = getSettings();
  let analysisProfile = null;
  if (settings.aiAnalysisModelTargetId) {
    const profiles = await loadRunnableProfiles();
    analysisProfile = profiles.find((p) => p.id === settings.aiAnalysisModelTargetId) || null;
  }
  analysisProfile = analysisProfile || profile;
  if (!analysisProfile) {
    return {
      enabled: true,
      success: false,
      error: "没有找到可用于生成 AI 分析的 API 配置。",
    };
  }

  const prompt = buildAiReportAnalysisPrompt({ reportType, summary });
  const record = await executeTestRequest(
    {
      ...analysisProfile,
      maxTokens: Math.max(Number(analysisProfile.maxTokens || 0), 1200),
      timeoutMs: Math.max(Number(analysisProfile.timeoutMs || 0), 90000),
    },
    prompt,
    {
      runId,
      caseId: "ai-report-analysis",
      writeLog: true,
      abortSignal: taskContext?.task?.abortController?.signal,
    },
  );
  return buildAiAnalysisResult(record);
}

function selectBatchAnalysisProfile(profiles, summary, fallbackProfileIds) {
  const ranked = [...(summary.results || [])]
    .filter((result) => !result.error)
    .sort((a, b) => b.successRate - a.successRate || (a.p95TotalMs ?? Infinity) - (b.p95TotalMs ?? Infinity));
  const profileId = ranked[0]?.profileId || fallbackProfileIds[0];
  return profiles.find((profile) => profile.id === profileId) || null;
}
