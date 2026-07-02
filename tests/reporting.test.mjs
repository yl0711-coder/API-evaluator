import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("stability reports contain useful conclusions and no API key", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "evaluator-report-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;

  try {
    const reporting = await import(`../server/reporting.mjs?case=${Date.now()}`);
    const summary = {
      runId: "run-test",
      profileName: "Test API",
      provider: "Provider",
      model: "model-a",
      protocol: "openai_compatible",
      channelCode: "CH-A",
      rounds: 2,
      concurrency: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:02.000Z",
      durationMs: 2000,
      successRate: 0.5,
      successRateText: "50%",
      successCount: 1,
      avgFirstByteMs: 100,
      avgTotalMs: 200,
      p50TotalMs: 200,
      p95TotalMs: 200,
      minTotalMs: 200,
      maxTotalMs: 200,
      avgOutputChars: 20,
      inputTokens: 10,
      outputTokens: 5,
      errorCounts: { auth_failed: 1 },
      diagnostics: reporting.buildErrorDiagnostics({ auth_failed: 1 }),
      recommendation: reporting.buildRecommendation(0.5, 200, { auth_failed: 1 }),
      promptPreview: "hello with sk-should-not-be-in-report",
    };
    const markdown = reporting.formatStabilityReport(summary, [
      {
        success: true,
        statusCode: 200,
        firstByteMs: 100,
        totalMs: 200,
        outputChars: 20,
        responseSummary: "ok",
      },
      {
        success: false,
        normalizedError: "auth_failed",
        statusCode: 401,
        firstByteMs: 50,
        totalMs: 50,
        outputChars: 0,
        rawError: "Unauthorized",
      },
    ]);

    assert.match(markdown, /稳定性测试报告/);
    assert.match(markdown, /给业务人员看的结论/);
    assert.match(markdown, /关键数据解读/);
    assert.match(markdown, /阅读顺序/);
    assert.match(markdown, /专业汇总结论/);
    assert.match(markdown, /单轮明细/);
    assert.match(markdown, /认证失败/);
    assert.match(markdown, /报告不包含 API Key/);
    assert.equal(markdown.includes("sk-should-not-be-in-report"), false);
    assert.match(markdown, /\[redacted-secret\]/);

    const files = await reporting.saveReportFiles("run-test", markdown, "测试报告");
    const html = await readFile(files.htmlPath, "utf8");
    assert.match(html, /<!doctype html>/);
    assert.match(html, /模型评测平台本地生成/);
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("report filenames are sanitized before writing to report directory", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "evaluator-report-filename-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;

  try {
    const reporting = await import(`../server/reporting.mjs?case=filename-${Date.now()}`);
    const files = await reporting.saveReportFiles("../bad/name", "# Test", "测试报告");

    assert.equal(files.markdownPath.includes(".."), false);
    assert.match(files.markdownPath, /bad-name\.md$/);
    assert.match(await readFile(files.markdownPath, "utf8"), /# Test/);
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("reports can include optional AI analysis without replacing local conclusions", async () => {
  const reporting = await import(`../server/reporting.mjs?case=ai-analysis-${Date.now()}`);
  const summary = {
    runId: "run-ai",
    profileName: "AI API",
    provider: "Provider",
    model: "model-a",
    protocol: "openai_compatible",
    channelCode: "CH-A",
    rounds: 1,
    concurrency: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:02.000Z",
    durationMs: 2000,
    successRate: 1,
    successRateText: "100%",
    successCount: 1,
    failureCount: 0,
    avgFirstByteMs: 100,
    avgTotalMs: 200,
    p50TotalMs: 200,
    p95TotalMs: 200,
    minTotalMs: 200,
    maxTotalMs: 200,
    avgOutputChars: 20,
    inputTokens: 10,
    outputTokens: 5,
    errorCounts: {},
    diagnostics: [],
    recommendation: reporting.buildRecommendation(1, 200, {}),
    promptPreview: "hello",
  };
  const aiAnalysis = {
    enabled: true,
    success: true,
    text: "## AI 人话结论\n建议继续测试。",
    inputTokens: 100,
    outputTokens: 50,
  };
  const markdown = reporting.formatStabilityReport(summary, [], { aiAnalysis });

  // 主报告：只保留指引小节（标题 + 用量 + 指向单独 HTML），不再内联 AI 正文。
  assert.match(markdown, /给业务人员看的结论/);
  assert.match(markdown, /AI 辅助分析（可选）/);
  assert.match(markdown, /额外消耗：输入 100 tokens，输出 50 tokens/);
  assert.match(markdown, /-ai-analysis\.html/);
  assert.doesNotMatch(markdown, /AI 人话结论/);

  // 单独文档：承载完整 AI 分析正文与免责说明，渲染成单独 HTML。
  const aiDoc = reporting.formatAiAnalysisDocument(aiAnalysis, { title: "稳定性测试 · AI 辅助分析" });
  assert.match(aiDoc, /# 稳定性测试 · AI 辅助分析/);
  assert.match(aiDoc, /额外消耗：输入 100 tokens，输出 50 tokens/);
  assert.match(aiDoc, /最终判断仍要结合本地规则结论/);
  assert.match(aiDoc, /AI 人话结论/);
  // 未启用时不产出文档（调用方据此跳过落盘）。
  assert.equal(reporting.formatAiAnalysisDocument({ enabled: false }), "");
});

test("admission reports contain grade, evidence, and no API key", async () => {
  const reporting = await import(`../server/reporting.mjs?case=admission-${Date.now()}`);
  const markdown = reporting.formatAdmissionReport(
    {
      runId: "admission-test",
      profileName: "Candidate API",
      profileRole: "baseline",
      provider: "Provider",
      model: "claude-opus-test",
      protocol: "claude_messages",
      channelCode: "CH-A",
      packageLevel: "standard",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:08.000Z",
      durationMs: 8000,
      requestCount: 2,
      successCount: 1,
      successRateText: "50%",
      grade: "C",
      score: 72,
      avgTotalMs: 3000,
      p95TotalMs: 5000,
      inputTokens: 100,
      outputTokens: 50,
      toolCallPassed: false,
      streamPassed: true,
      jsonPassed: true,
      identityCheck: {
        status: "aligned",
        expectedFamily: "claude",
        reportedFamily: "claude",
      },
      purityAssessment: {
        title: "高可信候选",
        score: 92,
        confidence: "medium",
        expectedFamilyLabel: "Claude",
        nextAction: "进入稳定性复测。",
        evidence: [{ code: "工具调用", detail: "工具调用结构通过。" }],
        riskFlags: [],
      },
      tokenAudit: {
        usageCoverageText: "100%",
        inputTokens: 100,
        outputTokens: 50,
        avgInputTokens: 50,
        avgOutputTokens: 25,
        issues: [],
      },
      fingerprintSummary: {
        totalCount: 2,
        passedCount: 2,
        failedCount: 0,
        passRateText: "100%",
        passRate: 1,
        probes: [
          {
            id: "fingerprint_instruction_lock",
            name: "指纹探针：固定 JSON 指令",
            passed: true,
            issue: "固定 JSON 指令遵循通过。",
            signals: ["NXFP-7429"],
          },
        ],
      },
      errorCounts: { tool_call_missing: 1 },
      recommendation: {
        title: "可观察，需要复测",
        detail: "工具调用没有通过，建议复核协议。",
      },
      nextAction: "复核协议后重新测试。",
      cases: [
        {
          name: "结构化输出",
          passed: true,
          statusCode: 200,
          totalMs: 2000,
          inputTokens: 20,
          outputTokens: 10,
          issue: "结构正常。",
        },
        {
          name: "工具调用结构",
          passed: false,
          statusCode: 200,
          totalMs: 4000,
          inputTokens: 30,
          outputTokens: 5,
          issue: "缺少工具调用。",
        },
      ],
    },
    [
      {
        caseName: "结构化输出",
        success: true,
        statusCode: 200,
        firstByteMs: 200,
        totalMs: 2000,
        responseSummary: "ok sk-should-not-leak",
      },
    ],
  );

  assert.match(markdown, /模型准入评测报告/);
  assert.match(markdown, /准入等级：C/);
  assert.match(markdown, /配置角色：可信基线 API/);
  assert.match(markdown, /综合分：72\/100/);
  assert.match(markdown, /分项结果/);
  assert.match(markdown, /流式结构：通过/);
  assert.match(markdown, /标称一致性：一致/);
  assert.match(markdown, /模型纯度初判：高可信候选/);
  assert.match(markdown, /指纹探针：2\/2 通过/);
  assert.match(markdown, /模型指纹探针/);
  assert.match(markdown, /Token 审计覆盖率：100%/);
  assert.match(markdown, /模型纯度与渠道风险初判/);
  assert.match(markdown, /请求证据/);
  assert.match(markdown, /报告不包含 API Key/);
  assert.equal(markdown.includes("sk-should-not-leak"), false);
  assert.match(markdown, /\[redacted-secret\]/);
});

test("scenario reports explain content safety risks in plain language", async () => {
  const reporting = await import(`../server/reporting.mjs?case=safety-${Date.now()}`);
  const markdown = reporting.formatScenarioReport({
    runId: "scenario-test",
    profileCount: 1,
    scenarioCount: 2,
    repeats: 1,
    maxParallelProfiles: 1,
    requestConcurrency: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:02.000Z",
    durationMs: 2000,
    results: [
      {
        profileName: "Demo API",
        model: "demo-model",
        successRate: 1,
        successRateText: "100%",
        avgQualityScore: 72,
        avgTotalMs: 1000,
        p95TotalMs: 1200,
        errorCounts: {},
        diagnostics: [],
        recommendation: reporting.buildScenarioRecommendation(1, 72, 1200, {}),
        scenarios: [
          {
            scenarioName: "内容安全：色情低风险探测",
            category: "safety",
            successRateText: "100%",
            avgQualityScore: 72,
            avgTotalMs: 1000,
            p95TotalMs: 1200,
            issues: ["疑似直接满足风险请求"],
          },
          {
            scenarioName: "内容安全：暴力伤害低风险探测",
            category: "safety",
            successRateText: "100%",
            avgQualityScore: 100,
            avgTotalMs: 900,
            p95TotalMs: 900,
            issues: [],
          },
        ],
      },
    ],
  });

  assert.match(markdown, /内容安全合规结论/);
  assert.match(markdown, /关键数据解读/);
  assert.match(markdown, /场景结论/);
  assert.match(markdown, /处理建议/);
  assert.match(markdown, /高风险，必须复核/);
  assert.match(markdown, /暂不建议用于开放内容场景/);
  assert.match(markdown, /需要人工复核的场景/);
  assert.match(markdown, /成功率` 只代表 API 有返回/);
  assert.match(markdown, /重点看原始回答/);
});

test("batch reports include readable comparison data and next steps", async () => {
  const reporting = await import(`../server/reporting.mjs?case=batch-${Date.now()}`);
  const markdown = reporting.formatBatchReport({
    batchId: "batch-test",
    profileCount: 2,
    rounds: 3,
    maxParallelProfiles: 2,
    requestConcurrency: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:10.000Z",
    durationMs: 10000,
    results: [
      {
        profileName: "Fast API",
        successRate: 1,
        successRateText: "100%",
        avgTotalMs: 1000,
        p95TotalMs: 1200,
        recommendation: reporting.buildRecommendation(1, 1200, {}),
        diagnostics: [],
        reportPath: "fast.md",
      },
      {
        profileName: "Slow API",
        successRate: 0.67,
        successRateText: "67%",
        avgTotalMs: 50000,
        p95TotalMs: 60000,
        recommendation: reporting.buildRecommendation(0.67, 60000, { timeout: 1 }),
        diagnostics: reporting.buildErrorDiagnostics({ timeout: 1 }),
        reportPath: "slow.md",
      },
    ],
  });

  assert.match(markdown, /批量稳定性测试总报告/);
  assert.match(markdown, /关键数据解读/);
  assert.match(markdown, /当前最优/);
  assert.match(markdown, /失败或低成功率配置/);
  assert.match(markdown, /使用建议/);
  assert.match(markdown, /低延迟场景/);
});

test("batch admission reports summarize candidate ranking", async () => {
  const reporting = await import(`../server/reporting.mjs?case=batch-admission-${Date.now()}`);
  const markdown = reporting.formatBatchAdmissionReport({
    batchId: "admission-batch-test",
    profileCount: 2,
    packageLevel: "standard",
    maxParallelProfiles: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:10.000Z",
    durationMs: 10000,
    results: [
      {
        profileName: "Candidate A",
        model: "claude-opus-test",
        grade: "A",
        score: 92,
        successRateText: "100%",
        purityAssessment: { score: 88 },
        fingerprintSummary: { passRateText: "100%" },
        recommendation: { title: "可继续复测" },
      },
      {
        profileName: "Candidate B",
        model: "claude-opus-test",
        grade: "D",
        score: 50,
        successRateText: "60%",
        fingerprintSummary: { passRateText: "50%" },
        recommendation: { title: "先排查" },
      },
    ],
  });

  assert.match(markdown, /批量准入评测报告/);
  assert.match(markdown, /Candidate A/);
  assert.match(markdown, /综合分 92/);
  assert.match(markdown, /批量准入只负责初筛/);
});
