// server/test-runner.mjs
// 测试执行引擎：构造并发起对被测 API 的探测请求（普通生成 / 工具调用 / 流式结构），
// 归一化结果与错误、落库为脱敏测试记录，并编排准入 / 稳定性 / 场景 / 快检各类测试。
import crypto from "node:crypto";
import {
  buildAiAnalysisResult,
  buildAiReportAnalysisPrompt,
  isAiReportAnalysisEnabled,
} from "./ai-report-analysis.mjs";
import { TEST_SCENARIOS } from "./scenarios/index.mjs";
import { REQUEST_LOG_FILE, TEST_RUNS_FILE } from "./paths.mjs";
import { loadRunnableProfiles } from "./run-targets.mjs";
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
  extractOutputText,
  extractToolCall,
  extractUsage,
  normalizeEmptyResponse,
  normalizeHttpError,
  summarizeStreamStructure,
} from "./protocols.mjs";
import { buildRunConsumption, estimateProfileRunEconomics } from "./costing.mjs";
import { auditAbsoluteTokens, auditBillingDimensions } from "./token-auditor.mjs";
import {
  countErrors,
  formatAdmissionReport,
  formatBatchAdmissionReport,
  formatBatchReport,
  formatQuickVerifyReport,
  formatScenarioReport,
  formatStabilityReport,
  saveReportFiles,
} from "./reporting.mjs";
import { buildScenarioProfileSummary, buildScenarioSummary, buildStabilitySummary } from "./summaries.mjs";
import { buildFingerprintSnapshot, trackModelFingerprint } from "./fingerprint-tracking.mjs";
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

export async function runQuickVerify(body, taskContext = {}) {
  const profiles = await loadRunnableProfiles();
  const profile = profiles.find((item) => item.id === body.profileId);
  if (!profile) {
    throw new Error("没有找到被测 API 配置。");
  }

  const runId = `quickverify-${compactDate(new Date())}-${crypto.randomUUID().slice(0, 8)}`;
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
    successCount: records.filter((r) => r.success).length,
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
  const runId = `admission-${compactDate(new Date())}-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = new Date();
  const cases = buildAdmissionCases(packageLevel, profile.defaultModel);
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
  summary.regression = await assessRunRegression(summary);
  const reportMarkdown = formatAdmissionReport(summary, records);
  const reportFiles = await saveReportFiles(runId, reportMarkdown, "模型准入评测报告");

  await persistTestRun({
    ...summary,
    type: "admission",
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown: undefined,
  });

  return {
    ...summary,
    type: "admission",
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
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
  const batchId = `admission-batch-${compactDate(new Date())}-${crypto.randomUUID().slice(0, 8)}`;
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
  const reportMarkdown = formatBatchAdmissionReport(summary);
  const reportFiles = await saveReportFiles(batchId, reportMarkdown, "批量准入评测报告");

  await persistTestRun({
    ...summary,
    type: "batch-admission",
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown: undefined,
  });

  return {
    ...summary,
    type: "batch-admission",
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown,
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

  if (testCase.kind === "tool") {
    return executeToolCallTestRequest(profile, baseOptions);
  }
  if (testCase.kind === "stream") {
    return executeStreamStructureTestRequest(profile, testCase.prompt, baseOptions);
  }
  return executeTestRequest(profile, testCase.prompt, baseOptions);
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

function buildAdmissionSummary({ runId, profile, records, packageLevel, startedAt, endedAt }) {
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
  const runId = `run-${compactDate(new Date())}-${crypto.randomUUID().slice(0, 8)}`;
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

  await persistTestRun({
    ...summary,
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown: undefined,
  });

  return {
    ...summary,
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
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

  const batchId = `batch-${compactDate(new Date())}-${crypto.randomUUID().slice(0, 8)}`;
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

  await persistTestRun({
    ...summary,
    type: "batch-stability",
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown: undefined,
  });

  return {
    ...summary,
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown,
  };
}

export async function runScenarioTest(body, taskContext = {}) {
  const profiles = await loadRunnableProfiles();
  const profileIds = normalizeProfileIds(body.profileIds);
  const scenarioIds = normalizeScenarioIds(body.scenarioIds);
  const selectedProfiles = profiles.filter((profile) => profileIds.includes(profile.id));
  const selectedScenarios = TEST_SCENARIOS.filter((scenario) => scenarioIds.includes(scenario.id));

  if (selectedProfiles.length === 0) {
    throw new Error("请至少选择一个被测 API。");
  }
  if (selectedScenarios.length === 0) {
    throw new Error("请至少选择一个测试场景。");
  }

  const runId = `scenario-${compactDate(new Date())}-${crypto.randomUUID().slice(0, 8)}`;
  const maxParallelProfiles = clampNumber(body.maxParallelProfiles, 1, 5, 2);
  const requestConcurrency = clampNumber(body.requestConcurrency || body.concurrency, 1, 3, 1);
  const repeats = clampNumber(body.repeats, 1, 5, 1);
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
  let summary = buildScenarioSummary({
    runId,
    profileResults,
    selectedScenarios,
    maxParallelProfiles,
    requestConcurrency,
    repeats,
    startedAt,
    endedAt,
  });
  summary = await attachRunArtifacts(runId, summary, { profileResults });
  summary.predictedConsumption = normalizePredicted(body.predicted);
  const aiAnalysisProfile = selectScenarioAnalysisProfile(profiles, summary, profileIds);
  const aiAnalysis = await maybeBuildAiAnalysis({
    enabled: body.useAiReportAnalysis,
    reportType: "scenario",
    profile: aiAnalysisProfile,
    summary,
    runId,
    taskContext,
  });
  const reportMarkdown = formatScenarioReport(summary, { aiAnalysis });
  const reportFiles = await saveReportFiles(runId, reportMarkdown, "场景测试报告");

  await persistTestRun({
    ...summary,
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown: undefined,
  });

  return {
    ...summary,
    reportPath: reportFiles.markdownPath,
    reportHtmlPath: reportFiles.htmlPath,
    rawJsonPath: summary.rawJsonPath,
    workspaceDir: summary.workspaceDir,
    reportMarkdown,
  };
}

export function normalizeProfileIds(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeScenarioIds(value) {
  const ids = Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  return ids.length > 0 ? ids : TEST_SCENARIOS.map((scenario) => scenario.id);
}

async function runScenarioProfile({ runId, profile, scenarios, repeats, requestConcurrency, taskContext }) {
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
        const record = await executeTestRequest(profile, buildScenarioPrompt(scenario, repeat, repeats), {
          runId,
          caseId: scenario.id,
          writeLog: true,
          abortSignal: taskContext?.task?.abortController?.signal,
        });
        const quality = evaluateScenarioOutput(scenario, record);
        if (collectForJudge && record.success && record.responseText) {
          judgeItems.push({ question: scenario.prompt, answer: record.responseText, rubric: scenario.judgeRubric || "" });
        }
        delete record.responseText;
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
// API key 仅请求时读取，绝不进日志/报告（finalizeTestRecord 只写脱敏元数据）。
async function runUpstreamProbe(profile, options, { buildRequest, interpret, computeSuccess, captureFirstToken = false }) {
  const requestId = crypto.randomUUID();
  const startedAt = new Date();
  const timeoutMs = Number(profile.timeoutMs || 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const unlinkAbort = linkExternalAbort(controller, options.abortSignal);

  // 贯穿各 finalize 分支的可变结果（含变体特有字段 toolCall / streamValidation / firstTokenMs）。
  const r = {
    firstByteMs: null,
    firstTokenMs: null,
    totalMs: null,
    statusCode: null,
    responseText: "",
    usage: null,
    rawError: "",
    normalizedError: "",
    toolCall: null,
    streamValidation: null,
  };
  const finalize = () =>
    finalizeTestRecord({
      options,
      profile,
      requestId,
      startedAt,
      firstByteMs: r.firstByteMs,
      firstTokenMs: r.firstTokenMs,
      totalMs: r.totalMs,
      statusCode: r.statusCode,
      responseText: r.responseText,
      usage: r.usage,
      rawError: r.rawError,
      normalizedError: r.normalizedError,
      toolCall: r.toolCall,
      streamValidation: r.streamValidation,
      successOverride: computeSuccess(r),
    });

  try {
    const apiKey = await readProfileApiKey(profile);
    if (!apiKey) {
      r.rawError = "API Key 未配置或无法从密钥存储读取。";
      r.normalizedError = "auth_failed";
      r.totalMs = 0;
      return await finalize();
    }

    const request = buildRequest({ ...profile, apiKey });
    const started = performance.now();
    await assertPublicTarget(request.url);
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
      redirect: "error",
    });
    r.firstByteMs = Math.round(performance.now() - started);
    r.statusCode = response.status;
    const rawResult = await readBoundedResponseText(response, MAX_UPSTREAM_RESPONSE_BYTES, controller);
    r.totalMs = Math.round(performance.now() - started);
    // 真 TTFT：首个流式分片到达时刻（≈首 token）。仅流式可测；非流式 JSON 整体返回、
    // 无 token 级时序，故 captureFirstToken=false 时保持 null。
    if (captureFirstToken && rawResult.firstChunkAt != null) {
      r.firstTokenMs = Math.max(0, Math.round(rawResult.firstChunkAt - started));
    }
    if (rawResult.truncated) {
      r.rawError = `上游响应超过 ${MAX_UPSTREAM_RESPONSE_BYTES} bytes，已停止读取。`;
      r.normalizedError = "response_too_large";
      return await finalize();
    }

    const raw = rawResult.text;
    if (!response.ok) {
      r.rawError = summarizeText(raw);
      r.normalizedError = normalizeHttpError(response.status, raw);
    } else {
      interpret(r, raw);
    }
  } catch (error) {
    r.totalMs = r.totalMs ?? timeoutMs;
    r.rawError = error instanceof Error ? error.message : String(error);
    r.normalizedError = /abort|timeout|timed out/i.test(r.rawError) ? "timeout" : "network_error";
  } finally {
    clearTimeout(timer);
    unlinkAbort();
  }

  return finalize();
}

// 普通生成探测：解析输出文本与 usage；空回复按 normalizeEmptyResponse 归一。
export async function executeTestRequest(profile, prompt, options = {}) {
  return runUpstreamProbe(profile, options, {
    buildRequest: (p) => buildProtocolRequest(p, prompt),
    interpret: (r, raw) => {
      const parsed = safeJson(raw);
      r.responseText = extractOutputText(profile.protocol, parsed);
      r.usage = extractUsage(parsed);
      if (!r.responseText) {
        r.rawError = summarizeText(raw);
        r.normalizedError = normalizeEmptyResponse(raw);
      }
    },
    computeSuccess: () => undefined, // 走 finalize 默认：2xx + 有输出
  });
}

// 工具调用探测：要求模型返回 tool_call；缺失记 tool_call_missing。成功 = 2xx 且拿到 toolCall。
export async function executeToolCallTestRequest(profile, options = {}) {
  return runUpstreamProbe(profile, options, {
    buildRequest: (p) => buildProtocolToolRequest(p),
    interpret: (r, raw) => {
      const parsed = safeJson(raw);
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

export async function readBoundedResponseText(response, maxBytes, controller) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    controller.abort();
    return { text: "", truncated: true, firstChunkAt: null };
  }

  if (!response.body?.getReader) {
    if (!contentLength) {
      controller.abort();
      return { text: "", truncated: true, firstChunkAt: null };
    }
    const text = await response.text();
    return { text: text.slice(0, maxBytes), truncated: Buffer.byteLength(text, "utf8") > maxBytes, firstChunkAt: null };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;
  let firstChunkAt = null; // 首个分片到达时刻（performance.now()），供流式 TTFT 计算

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
        return { text: chunks.join(""), truncated: true, firstChunkAt };
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return { text: chunks.join(""), truncated: false, firstChunkAt };
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
  totalMs,
  statusCode,
  responseText,
  usage,
  rawError,
  normalizedError,
  toolCall = null,
  streamValidation = null,
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
    startedAt: startedAt.toISOString(),
    firstByteMs,
    firstTokenMs,
    totalMs,
    statusCode,
    success: successOverride ?? Boolean(statusCode && statusCode >= 200 && statusCode < 300 && responseText),
    normalizedError,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheCreationTokens: usage?.cacheCreationTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    tokenSource: usage ? "upstream" : "unknown",
    outputChars: responseText.length,
    responseSummary: summarizeText(responseText),
    responseText,
    toolCall,
    streamValidation,
    rawError: summarizeText(rawError),
  };

  if (options.writeLog !== false) {
    const logRecord = { ...record };
    // Full response text can be large and user-provided; keep reports useful but
    // avoid turning request logs into a data dump.
    delete logRecord.responseText;
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
  if (!profile) {
    return {
      enabled: true,
      success: false,
      error: "没有找到可用于生成 AI 分析的 API 配置。",
    };
  }

  const prompt = buildAiReportAnalysisPrompt({ reportType, summary });
  const record = await executeTestRequest(
    {
      ...profile,
      maxTokens: Math.max(Number(profile.maxTokens || 0), 1200),
      timeoutMs: Math.max(Number(profile.timeoutMs || 0), 90000),
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

function selectScenarioAnalysisProfile(profiles, summary, fallbackProfileIds) {
  const ranked = [...(summary.results || [])]
    .filter((result) => !result.error)
    .sort(
      (a, b) =>
        b.avgQualityScore - a.avgQualityScore ||
        b.successRate - a.successRate ||
        (a.p95TotalMs ?? Infinity) - (b.p95TotalMs ?? Infinity),
    );
  const profileId = ranked[0]?.profileId || fallbackProfileIds[0];
  return profiles.find((profile) => profile.id === profileId) || null;
}
