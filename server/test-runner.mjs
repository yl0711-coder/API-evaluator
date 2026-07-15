// server/test-runner.mjs
// 测试执行引擎：构造并发起对被测 API 的探测请求（普通生成 / 工具调用 / 流式结构），
// 归一化结果与错误、落库为脱敏测试记录，并编排准入 / 稳定性 / 场景 / 快检各类测试。
import crypto from "node:crypto";
import {
  buildAiAnalysisResult,
  buildAiReportAnalysisPrompt,
  isAiReportAnalysisEnabled,
} from "./ai-report-analysis.mjs";
import { getSettings } from "./settings-store.mjs";
import { getTestScenarios } from "./scenarios/index.mjs";
import { REQUEST_LOG_FILE, TEST_RUNS_FILE } from "./paths.mjs";
import { loadRunnableProfiles } from "./run-targets.mjs";
import { loadModelTargets, saveModelTargets } from "./model-target-store.mjs";
import { computeEarnedTags, applyEarnedTags } from "./scenario-tag-award.mjs";
import { evaluateScenarioOutput } from "./scenario-evaluator.mjs";
import { readProfileApiKey } from "./secret-store.mjs";
import { assertPublicTarget } from "./egress-guard.mjs";
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
  firstTokenPatternFor,
  extractUsage,
  isStreamOptionsUnsupportedError,
  isTemperatureUnsupportedError,
  normalizeEmptyResponse,
  normalizeHttpError,
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

const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;

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
  const channel = String(profile?.name || "").split(" / ")[0].trim();
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

export async function runQuickTest(profileId, prompt) {
  const profiles = await loadRunnableProfiles();
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) {
    return {
      success: false,
      normalizedError: "profile_not_found",
      message: "没有找到被测 API 配置。",
    };
  }

  return executeTestRequest(profile, prompt, {
    runId: "quick-test",
    caseId: "quick-connectivity",
    writeLog: true,
  });
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
  const okTotalTimes = records.filter((r) => r.success).map((r) => r.totalMs).filter(Number.isFinite);

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
  const profiles = await loadRunnableProfiles();
  const profile = profiles.find((item) => item.id === body.profileId);
  if (!profile) {
    throw new Error("没有找到被测 API 配置。");
  }

  const packageLevel = ["quick", "standard", "deep"].includes(body.packageLevel)
    ? body.packageLevel
    : "standard";
  const runId = buildReportId("admission", reportTargetSlug(profile));
  const startedAt = new Date();
  const cases = buildAdmissionCases(packageLevel, profile.defaultModel);
  // 档位降级判别：仅 standard/deep + Claude + 有匹配档位参考时，追加"多跑几次的判别题"。
  const tierContext = packageLevel === "standard" || packageLevel === "deep" ? loadTierContext(profile.defaultModel) : null;
  if (tierContext) cases.push(...buildTierProbeCases(tierContext.reference));
  const records = [];

  for (const testCase of cases) {
    const record = await executeAdmissionTestCase(profile, testCase, runId, taskContext);
    const admission = evaluateAdmissionCase(testCase, record);
    delete record.responseText;
    records.push({
      ...record,
      caseName: testCase.name,
      admission,
    });
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

  const packageLevel = ["quick", "standard", "deep"].includes(body.packageLevel)
    ? body.packageLevel
    : "standard";
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
    const passed = record.success && record.toolCall?.name === "get_weather";
    return {
      passed,
      issue: passed ? "工具调用结构正常。" : record.rawError || "没有返回期望的工具调用结构。",
    };
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
    const parsed = parseLooseJson(record.responseText || record.responseSummary);
    const passed = Boolean(parsed && Object.hasOwn(parsed, "channelReady") && parsed.modelType && parsed.risk);
    return {
      passed,
      issue: passed ? "结构化 JSON 字段完整。" : "没有返回可解析且字段完整的 JSON。",
    };
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
  if (testCase.id === "coding_small") {
    const passed = /function|const|let|return|Number|parseInt|parseFloat|修复|代码/i.test(text) && text.length >= 50;
    return {
      passed,
      issue: passed ? "编程小任务有有效回答。" : "编程回答过短或缺少修复代码。",
    };
  }
  if (testCase.id === "behavior_reasoning") {
    const passed = /(渠道|模型|协议|延迟|稳定|路由|缓存|限流)/.test(text) && text.length >= 80;
    return {
      passed,
      issue: passed ? "行为解释具备基本专业性。" : "解释过短或缺少渠道评测关键点。",
    };
  }
  if (testCase.id === "long_context_light") {
    const passed = /(检查项|通过标准|失败处理|协议|模型|token|超时)/i.test(text) && text.length >= 120;
    return {
      passed,
      issue: passed ? "轻量长上下文任务完成。" : "长上下文检查项不完整。",
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
  const confidence = String(parsed?.confidence || "").trim().toLowerCase();
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

function buildAdmissionSummary({ runId, profile, records, packageLevel, startedAt, endedAt, tierContext = null }) {
  const requestCount = records.length;
  const successCount = records.filter((record) => record.success).length;
  const passedCount = records.filter((record) => record.admission?.passed).length;
  const successRate = requestCount ? successCount / requestCount : 0;
  const passRate = requestCount ? passedCount / requestCount : 0;
  const errorCounts = countErrors(records.filter((record) => !record.success));
  const avgTotalMs = mean(records.map((record) => record.totalMs)) ?? null;
  const p95TotalMs = percentile(records.map((record) => record.totalMs), 0.95);
  const inputTokens = sumNullable(records.map((record) => record.inputTokens));
  const outputTokens = sumNullable(records.map((record) => record.outputTokens));
  const tokenCoverage = records.filter((record) => record.inputTokens !== null || record.outputTokens !== null).length / Math.max(1, requestCount);
  const jsonPassed = Boolean(records.find((record) => record.caseId === "json_structure")?.admission?.passed);
  const toolCallPassed = Boolean(records.find((record) => record.caseId === "tool_call")?.admission?.passed);
  const streamPassed = Boolean(records.find((record) => record.caseId === "stream_structure")?.admission?.passed);
  const identityRecord = records.find((record) => record.caseId === "model_identity");
  const identityCheck = identityRecord?.admission?.identityCheck || null;
  const identityPassed = Boolean(identityRecord?.admission?.passed);
  const codingPassed = records
    .filter((record) => ["coding_small", "behavior_reasoning", "long_context_light"].includes(record.caseId))
    .every((record) => record.admission?.passed);
  const severeError = Object.keys(errorCounts).find((code) =>
    ["auth_failed", "model_not_found", "content_block_not_found", "upstream_5xx"].includes(code),
  );
  const identityPenalty = identityCheck?.status === "conflict" ? 15 : identityCheck?.status === "unknown" ? 3 : 0;
  const latencyPenalty = p95TotalMs && p95TotalMs > 45000 ? 10 : p95TotalMs && p95TotalMs > 15000 ? 5 : 0;
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
  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        successRate * 35 +
          passRate * 25 +
          (jsonPassed ? 10 : 0) +
          (toolCallPassed ? 10 : 0) +
          (streamPassed ? 10 : 0) +
          (identityPassed ? 5 : 0) +
          (codingPassed ? 10 : 0) +
          tokenCoverage * 5 -
          latencyPenalty -
          identityPenalty,
      ),
    ),
  );
  const grade = gradeAdmission(score, { successRate, severeError, toolCallPassed, jsonPassed, streamPassed, identityCheck });
  const recommendation = buildAdmissionRecommendation(grade, { severeError, successRate, p95TotalMs });

  return {
    runId,
    type: "admission",
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
    passedCount,
    passRate,
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
    cases: records.map((record) => ({
      id: record.caseId,
      name: record.caseName,
      passed: Boolean(record.admission?.passed),
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
    })),
  };
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
  if (p95TotalMs && p95TotalMs > 45000) {
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

async function runStabilityForProfile({ profile, body, taskContext = {}, onProgress = null }) {
  const rounds = clampNumber(body.rounds, 1, 100, 10);
  const concurrency = clampNumber(body.concurrency, 1, 5, 1);
  const prompt = String(body.prompt || "").trim() || "请用两句话说明你可以正常工作，并返回当前测试编号。";
  const runId = buildReportId("run", reportTargetSlug(profile));
  const startedAt = new Date();
  const records = [];

  for (let index = 0; index < rounds; index += concurrency) {
    assertTaskNotCancelled(taskContext);
    const batch = Array.from({ length: Math.min(concurrency, rounds - index) }, (_, offset) => {
      const round = index + offset + 1;
      const casePrompt = buildRoundPrompt(prompt, round, rounds);
      return executeTestRequest(profile, casePrompt, {
        runId,
        caseId: `round-${round}`,
        writeLog: true,
        abortSignal: taskContext?.task?.abortController?.signal,
      });
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
    prompt,
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
  return value === true || ["1", "true", "on", "yes"].includes(String(value ?? "").trim().toLowerCase());
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
    : String(value || "").split(",").map((item) => item.trim());
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

async function runScenarioProfile({ runId, profile, scenarios, repeats, requestConcurrency, maxTokensOverride = null, timeoutMsOverride = null, keepFullResponse = false, streamRequest = false, taskContext }) {
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

  const judgeAudit = collectForJudge
    ? await maybeRunInlineJudgeAudit({ profile, items: judgeItems, runId, taskContext })
    : null;
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

// 把外部取消信号（任务级 AbortController）接到单请求的 controller：取消时立即
// abort 在飞的 fetch，不必等当前请求超时/自然结束。返回解绑函数，在 finally 调用。
export function linkExternalAbort(controller, signal) {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

// 上游探测的统一骨架：三类探测（普通生成 / 工具调用 / 流式结构）只在
//   ① buildRequest 构造请求 ② interpret 解释成功响应 ③ computeSuccess 成功判定 三处不同；
// 其余（超时 / 外部中止 / 截断保护 / 计时 / auth-fail / finalize 落库）完全一致。
// 瞬时失败退避重试参数：限流型中转最常见的就是 429，单次不重试会整轮判 F。
const RETRY_MAX_ATTEMPTS = 3; // 含首次：最多 1 + 2 次重试
const RETRY_BASE_DELAY_MS = 600; // 指数退避基数
const RETRY_MAX_DELAY_MS = 20000; // 单次退避上限（同时钳制 Retry-After，避免被上游要求长睡）
// 本进程内记住哪些模型（baseUrl|model）拒绝自定义 temperature，后续同模型请求首发就不带，
// 省掉那次注定 400 的往返。仅内存态：模型不会中途改变是否支持，重启后从头学习即可。
const TEMPERATURE_UNSUPPORTED_MODELS = new Set();
// 同款记忆：本进程内曾因 stream_options 被 400 的模型，后续流式请求首发就不带，省掉注定失败的往返。
const STREAM_OPTIONS_UNSUPPORTED_MODELS = new Set();

// Retry-After（秒数或 HTTP 日期）→ 毫秒。无法解析 → null。
function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// 退避睡眠，可被外部取消打断。返回 true=被取消，false=正常睡完。
function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

// API key 仅请求时读取，绝不进日志/报告（finalizeTestRecord 只写脱敏元数据）。
// 429 / 5xx / 瞬时网络错误会指数退避重试；超时与用户取消止损不重试。
async function runUpstreamProbe(profile, options, { buildRequest, interpret, computeSuccess, captureFirstToken = false }) {
  const requestId = crypto.randomUUID();
  const startedAt = new Date();
  const timeoutMs = Number(profile.timeoutMs || 300000);

  // 贯穿各 finalize 分支的可变结果（含变体特有字段 toolCall / streamValidation / firstTokenMs）。
  const r = {
    firstByteMs: null,
    firstTokenMs: null,
    totalMs: null,
    statusCode: null,
    statusText: "", // HTTP reason phrase（原因短语）；HTTP/1.1 可自定义，HTTP/2 无、为空
    responseText: "",
    usage: null,
    finishReason: null,
    rawError: "",
    // 未截断的原始响应体；仅 options.keepRawResponse 时填充（见下方采集点）。
    rawResponse: "",
    rawResponsePartial: false, // 上面那份是断流残体（非完整响应），报告须如实标注
    normalizedError: "",
    toolCall: null,
    streamValidation: null,
  };
  let attempts = 0; // 实际发出的请求次数（含重试），写进记录便于诊断
  // 是否流式：取自【真正发出去的请求体】，不取调用方声明，两者不会脱节。
  // 之前没这个字段，只能拿 firstTokenMs 是否有值反推——而流式请求若一个可见 token 都没吐到
  // （空响应、上游中途死掉），它同样是 null，反推会把这类请求误判成非流式。
  let streaming = false;
  const finalize = () =>
    finalizeTestRecord({
      options,
      profile,
      requestId,
      startedAt,
      firstByteMs: r.firstByteMs,
      firstTokenMs: r.firstTokenMs,
      stream: streaming,
      totalMs: r.totalMs,
      statusCode: r.statusCode,
      statusText: r.statusText,
      responseText: r.responseText,
      usage: r.usage,
      finishReason: r.finishReason,
      rawError: r.rawError,
      rawResponse: r.rawResponse,
      rawResponsePartial: r.rawResponsePartial,
      normalizedError: r.normalizedError,
      toolCall: r.toolCall,
      streamValidation: r.streamValidation,
      attempts,
      successOverride: computeSuccess(r),
    });

  const apiKey = await readProfileApiKey(profile);
  if (!apiKey) {
    r.rawError = "API Key 未配置或无法从密钥存储读取。";
    r.normalizedError = "auth_failed";
    r.totalMs = 0;
    return finalize();
  }
  let request;
  try {
    request = buildRequest({ ...profile, apiKey });
    streaming = request.body?.stream === true;
    await assertPublicTarget(request.url); // egress 阻断等确定性失败：不重试
  } catch (error) {
    r.totalMs = 0;
    r.rawError = error instanceof Error ? error.message : String(error);
    r.normalizedError = "network_error";
    return finalize();
  }
  // 已知拒绝自定义 temperature 的模型（本进程内曾被 400 过）：首发就不带，省掉那次注定失败的往返。
  const tempKey = `${profile.baseUrl}|${profile.defaultModel}`;
  if (request.body?.temperature !== undefined && TEMPERATURE_UNSUPPORTED_MODELS.has(tempKey)) {
    delete request.body.temperature;
  }
  // 同上：已知不认 stream_options 的模型，流式请求首发就不带（拿不到上游 usage，调用方回退字符估算）。
  if (request.body?.stream_options !== undefined && STREAM_OPTIONS_UNSUPPORTED_MODELS.has(tempKey)) {
    delete request.body.stream_options;
  }

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    // 每次尝试独立的超时控制器；外部取消（options.abortSignal）贯穿所有尝试。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const unlinkAbort = linkExternalAbort(controller, options.abortSignal);
    // 重置本次尝试的瞬时字段，避免上次失败残留泄漏到下一次。
    r.firstByteMs = null;
    r.firstTokenMs = null;
    r.statusCode = null;
    r.statusText = "";
    r.responseText = "";
    r.usage = null;
    r.finishReason = null;
    r.rawError = "";
    r.rawResponse = "";
    r.rawResponsePartial = false;
    r.normalizedError = "";
    r.toolCall = null;
    r.streamValidation = null;
    let retryable = false;
    let retryAfterMs = null;
    // 确定性重配：上游拒收某个我方可选参数（temperature / stream_options），已就地删掉并原样重试。
    // 这不是负载信号、也不退避，故 noRetry（压测）也应放行——否则压测首批请求会白白判失败。
    let reconfigured = false;
    try {
      const started = performance.now();
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
        redirect: "error",
      });
      r.firstByteMs = Math.round(performance.now() - started);
      r.statusCode = response.status;
      // 原因短语：直接取上游实际返回的 statusText（HTTP/1.1 可被上游自定义），不套用标准短语。
      r.statusText = typeof response.statusText === "string" ? response.statusText : "";
      const rawResult = await readBoundedResponseText(response, MAX_UPSTREAM_RESPONSE_BYTES, controller, {
        firstTokenPattern: captureFirstToken ? firstTokenPatternFor(profile.protocol) : null,
      });
      r.totalMs = Math.round(performance.now() - started);
      // 真 TTFT：首个「可见输出 token」所在分片的到达时刻。仅流式可测；非流式 JSON 整体返回、
      // 无 token 级时序，故 captureFirstToken=false 时保持 null。
      // 刻意不退回 firstChunkAt：首帧可能是 Claude 的 message_start / 中转保活帧，
      // 用它会让 TTFT 系统性偏快且跨协议不可比——测不到就留 null（报告按「—」省略），不给假数字。
      if (captureFirstToken && rawResult.firstTokenAt != null) {
        r.firstTokenMs = Math.max(0, Math.round(rawResult.firstTokenAt - started));
      }
      if (rawResult.truncated) {
        r.rawError = `上游响应超过 ${MAX_UPSTREAM_RESPONSE_BYTES} bytes，已停止读取。`;
        r.normalizedError = "response_too_large";
        break; // finally 会清理；不重试
      }
      const raw = rawResult.text;
      if (!response.ok) {
        r.rawError = summarizeText(raw);
        r.normalizedError = normalizeHttpError(response.status, raw);
        if (response.status === 429 || response.status >= 500) {
          retryable = true; // 限流 / 上游 5xx：可重试
          retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        } else if (
          response.status === 400 &&
          request.body?.temperature !== undefined &&
          isTemperatureUnsupportedError(raw)
        ) {
          // 部分 OpenAI 系模型（o 系 / GPT-5 系）拒绝自定义 temperature：去掉后立即原样重试。
          // 就地删掉，本次调用后续尝试都不再带 temperature（guard 保证只触发一次，不会死循环）；
          // 并记住该模型，让后续请求首发就不带。
          TEMPERATURE_UNSUPPORTED_MODELS.add(tempKey);
          delete request.body.temperature;
          retryable = true;
          reconfigured = true;
          retryAfterMs = 0; // 确定性重配，不退避
        } else if (
          response.status === 400 &&
          request.body?.stream_options !== undefined &&
          isStreamOptionsUnsupportedError(raw)
        ) {
          // 同 temperature：部分中转不认 stream_options（我们只用它取 usage）。去掉后立即原样重试，
          // 否则「勾了流式」的场景题会被误判失败、压测（noRetry 之外的路径）整轮 0% 成功率。
          // 代价仅是没有上游 usage → 调用方回退按字符估算输出 token。
          STREAM_OPTIONS_UNSUPPORTED_MODELS.add(tempKey);
          delete request.body.stream_options;
          retryable = true;
          reconfigured = true;
          retryAfterMs = 0; // 确定性重配，不退避
        }
      } else {
        interpret(r, raw);
      }
      // 「在报告中完整显示返回」：没提取到文本时（空响应 / SSE 异常 / 上游错误页），rawError 已被
      // summarizeText 砍到 500 字并压平换行，恰恰是最需要看全文的情形却只剩开头。这里留一份未截断的
      // 原始响应（已受 MAX_UPSTREAM_RESPONSE_BYTES 限长）。仅调用方明确要求时保留：全文只随记录进报告，
      // 不进 requests.jsonl（同 responseText，见 finalizeTestRecord）。
      if (options.keepRawResponse && !r.responseText) r.rawResponse = raw;
    } catch (error) {
      r.totalMs = r.totalMs ?? timeoutMs;
      // undici 的 fetch reject 常是 "fetch failed"，真正的 errno 在 error.cause.code（如 ECONNRESET）。
      // 附到 rawError，供压测区分网络错误是本机侧还是上游侧。
      const errno = error?.cause?.code || error?.code || "";
      r.rawError = [error instanceof Error ? error.message : String(error), errno].filter(Boolean).join(" ");
      // 断流前已收到的半截 body（readBoundedResponseText 挂上来的）：标记为不完整，
      // 报告不得把它当完整响应体展示。
      if (options.keepRawResponse && typeof error?.partialText === "string" && error.partialText) {
        r.rawResponse = error.partialText;
        r.rawResponsePartial = true;
      }
      if (/abort|timeout|timed out/i.test(r.rawError)) {
        r.normalizedError = "timeout"; // 超时或用户取消：止损，不重试
      } else {
        r.normalizedError = "network_error";
        retryable = true; // 瞬时网络错误：可重试
      }
    } finally {
      clearTimeout(timer);
      unlinkAbort();
    }

    // options.noRetry：压测模式下每请求只测一次——重试会吞掉 429/5xx（正是要测的限流/不稳信号）、
    // 并把退避 sleep 混进延迟，污染 QPS / 尾延迟 / 错误分类。见 server/load-test.mjs。
    // 例外：确定性重配（reconfigured）是修我方请求体、零退避、totalMs 按最后一次尝试计，
    // 不会污染任何负载信号，故压测也放行——不然首批请求全因可选参数被拒而误判失败。
    if (!retryable || (options.noRetry && !reconfigured) || attempt >= RETRY_MAX_ATTEMPTS) break;
    const backoffMs =
      retryAfterMs != null
        ? Math.min(retryAfterMs, RETRY_MAX_DELAY_MS)
        : Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    if (await sleepUnlessAborted(backoffMs, options.abortSignal)) break; // 退避中被取消则立刻收手
  }

  return finalize();
}

// 普通生成探测：解析输出文本与 usage；空回复按 normalizeEmptyResponse 归一。
// options.stream=true 时改发 SSE 流式请求（贴近真实前端流量，且可测真 TTFT）。
// 解析层无需分流：coalesceSseResponse 会把 SSE 拼回非流式响应形状，下面 interpret 原样复用。
export async function executeTestRequest(profile, prompt, options = {}) {
  const streaming = options.stream === true;
  return runUpstreamProbe(profile, options, {
    captureFirstToken: streaming, // 真 TTFT 仅流式可测；非流式整体返回，保持 null
    buildRequest: (p) =>
      streaming ? buildProtocolStreamRequest(p, prompt, { includeUsage: true }) : buildProtocolRequest(p, prompt),
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
    },
    computeSuccess: () => undefined, // 走 finalize 默认：2xx + 有输出
  });
}

// 分词器指纹探针：只为读取输入 token 数。max_tokens=1、不带 temperature（Opus 4.7+ 拒绝采样参数），
// 把产出成本压到最小；不写请求日志，避免污染准入分项明细。
function buildProbeTokenRequest(profile, text) {
  const baseUrl = profile.baseUrl.replace(/\/+$/, "");
  if (profile.protocol === "claude_messages") {
    return {
      url: `${baseUrl}/v1/messages`,
      headers: { "content-type": "application/json", "x-api-key": profile.apiKey, "anthropic-version": profile.anthropicVersion || "2023-06-01" },
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
  return runUpstreamProbe(profile, { writeLog: false, ...options }, {
    buildRequest: (p) => buildProbeTokenRequest(p, text),
    interpret: (r, raw) => {
      r.usage = extractUsage(safeJson(raw) || coalesceSseResponse(profile.protocol, raw));
    },
    computeSuccess: (r) => Number(r.usage?.inputTokens) > 0,
  });
}

// 工具调用探测：要求模型返回 tool_call；缺失记 tool_call_missing。成功 = 2xx 且拿到 toolCall。
export async function executeToolCallTestRequest(profile, options = {}) {
  return runUpstreamProbe(profile, options, {
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
  return runUpstreamProbe(profile, options, {
    captureFirstToken: true,
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

// firstTokenPattern：命中即视为「首个可见输出 token 已到达」（见 protocols.firstTokenPatternFor）。
// 不传则只记 firstChunkAt，行为与旧版一致。
export async function readBoundedResponseText(response, maxBytes, controller, { firstTokenPattern = null } = {}) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    controller.abort();
    return { text: "", truncated: true, firstChunkAt: null, firstTokenAt: null };
  }

  if (!response.body?.getReader) {
    if (!contentLength) {
      controller.abort();
      return { text: "", truncated: true, firstChunkAt: null, firstTokenAt: null };
    }
    const text = await response.text();
    return {
      text: text.slice(0, maxBytes),
      truncated: Buffer.byteLength(text, "utf8") > maxBytes,
      firstChunkAt: null,
      firstTokenAt: null,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;
  let firstChunkAt = null; // 首个分片到达时刻（performance.now()）——含 message_start / 保活帧，不等于首 token
  let firstTokenAt = null; // 首个「可见输出 token」所在分片的到达时刻，才是 TTFT 的正确口径
  // 滑动窗：只留尾部若干字符 + 新分片，既能匹配跨分片被切断的标记，又不让正则开销随响应体线性增长。
  let matchWindow = "";
  const MATCH_WINDOW = 4096;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (firstChunkAt === null) firstChunkAt = performance.now();
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        controller.abort();
        return { text: chunks.join(""), truncated: true, firstChunkAt, firstTokenAt };
      }
      const piece = decoder.decode(value, { stream: true });
      chunks.push(piece);
      if (firstTokenPattern && firstTokenAt === null) {
        matchWindow = (matchWindow + piece).slice(-MATCH_WINDOW);
        if (firstTokenPattern.test(matchWindow)) firstTokenAt = performance.now();
      }
    }
    chunks.push(decoder.decode());
    return { text: chunks.join(""), truncated: false, firstChunkAt, firstTokenAt };
  } catch (error) {
    // 流中途断掉（socket 被掐断 / 超时中止）：已收到的半截 body 往往是「上游到底发出来没有」的
    // 唯一证据，不能连同异常一起丢掉。仍按原样抛出——错误归类（network_error / timeout）不变，
    // 只是把残体挂在异常上给调用方（见 runUpstreamProbe 的 catch）。
    const partial = chunks.join("");
    if (partial) error.partialText = partial;
    throw error;
  } finally {
    reader.releaseLock?.();
  }
}

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
  return [
    prompt,
    "",
    `本次是稳定性测试第 ${round}/${rounds} 轮。`,
    "请正常完成任务，不要只回复测试编号。",
  ].join("\n");
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
