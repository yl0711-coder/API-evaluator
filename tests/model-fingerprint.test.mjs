import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFingerprintProbeCases,
  buildFingerprintProbeSummary,
  buildPurityAssessment,
  buildTokenAudit,
  evaluateFingerprintProbe,
  getFingerprintLibraryMetadata,
  inferModelFamily,
  normalizeModelFamily,
} from "../server/model-fingerprint.mjs";

test("model family helpers infer common model families", () => {
  assert.equal(inferModelFamily("claude-opus-4-7"), "claude");
  assert.equal(inferModelFamily("gpt-4.1"), "openai");
  assert.equal(inferModelFamily("gemini-2.5-pro"), "gemini");
  assert.equal(normalizeModelFamily("Anthropic Claude"), "claude");
  assert.equal(normalizeModelFamily("I cannot confirm"), "unknown");
});

test("token audit reports usage coverage and suspicious zero output", () => {
  const audit = buildTokenAudit([
    { success: true, inputTokens: 100, outputTokens: 20 },
    { success: true, inputTokens: 80, outputTokens: 0 },
    { success: false, inputTokens: null, outputTokens: null },
  ]);

  assert.equal(audit.recordsWithUsage, 2);
  assert.equal(audit.inputTokens, 180);
  assert.equal(audit.outputTokens, 20);
  assert.equal(audit.tokenReliability, "medium");
  assert.equal(audit.issues.some((item) => item.code === "zero_output_success"), true);
});

test("purity assessment flags identity conflict as model mismatch", () => {
  const tokenAudit = buildTokenAudit([{ success: true, inputTokens: 100, outputTokens: 20 }]);
  const assessment = buildPurityAssessment({
    modelName: "claude-opus-4-7",
    protocol: "claude_messages",
    successRate: 1,
    p95TotalMs: 3000,
    identityCheck: {
      status: "conflict",
      expectedFamily: "claude",
      reportedFamily: "openai",
    },
    jsonPassed: true,
    toolCallPassed: true,
    streamPassed: true,
    errorCounts: {},
    tokenAudit,
  });

  assert.equal(assessment.classification, "suspected_model_mismatch");
  assert.equal(assessment.riskFlags.some((item) => item.code === "identity_conflict"), true);
  assert.equal(assessment.score < 85, true);
});

test("purity assessment marks clean evidence as high confidence candidate", () => {
  const tokenAudit = buildTokenAudit([{ success: true, inputTokens: 100, outputTokens: 20 }]);
  const assessment = buildPurityAssessment({
    modelName: "claude-opus-4-7",
    protocol: "claude_messages",
    successRate: 1,
    p95TotalMs: 3000,
    identityCheck: {
      status: "aligned",
      expectedFamily: "claude",
      reportedFamily: "claude",
    },
    jsonPassed: true,
    toolCallPassed: true,
    streamPassed: true,
    errorCounts: {},
    tokenAudit,
  });

  assert.equal(assessment.classification, "high_confidence_candidate");
  assert.equal(assessment.score, 100);
});

test("fingerprint probe cases evaluate deterministic model behavior", () => {
  const cases = buildFingerprintProbeCases();
  assert.equal(cases.length, 4);

  const instruction = evaluateFingerprintProbe(
    cases.find((item) => item.id === "fingerprint_instruction_lock"),
    '{"marker":"NXFP-7429","answer":"blue-17","count":3}',
  );
  const logic = evaluateFingerprintProbe(
    cases.find((item) => item.id === "fingerprint_logic_anchor"),
    "8",
  );
  const context = evaluateFingerprintProbe(
    cases.find((item) => item.id === "fingerprint_context_recall"),
    "matrix/lantern",
  );

  assert.equal(instruction.passed, true);
  assert.equal(logic.passed, true);
  assert.equal(context.passed, true);
});

test("fingerprint probe cases add model family probes when model name is known", () => {
  const claudeCases = buildFingerprintProbeCases({ modelName: "claude-opus-4-7" });
  const openaiCases = buildFingerprintProbeCases({ modelName: "gpt-4.1" });
  const unknownCases = buildFingerprintProbeCases({ modelName: "unknown-model" });

  assert.equal(claudeCases.some((item) => item.id === "fingerprint_family_claude_messages"), true);
  assert.equal(openaiCases.some((item) => item.id === "fingerprint_family_openai_chat"), true);
  assert.equal(unknownCases.length, 4);

  const familyResult = evaluateFingerprintProbe(
    claudeCases.find((item) => item.id === "fingerprint_family_claude_messages"),
    '{"family":"claude","events":["content_block_delta","message_stop"]}',
  );
  assert.equal(familyResult.passed, true);
  assert.equal(familyResult.family, "claude");
});

test("fingerprint library exposes version and coverage metadata", () => {
  const metadata = getFingerprintLibraryMetadata("claude-opus-4-7");
  const cases = buildFingerprintProbeCases({ modelName: "claude-opus-4-7" });

  assert.match(metadata.version, /^\d{4}\.\d{2}\.\d{2}$/);
  assert.equal(metadata.expectedFamily, "claude");
  assert.equal(metadata.totalProbeCount, cases.length);
  assert.equal(cases.every((item) => item.libraryVersion === metadata.version), true);
});

test("family fingerprint probes fail when expected signals are missing", () => {
  const cases = buildFingerprintProbeCases({ modelName: "gemini-2.5-pro" });
  const result = evaluateFingerprintProbe(
    cases.find((item) => item.id === "fingerprint_family_gemini_candidates"),
    '{"family":"openai","fields":["choices","message","content"]}',
  );

  assert.equal(result.passed, false);
  assert.equal(result.signals.includes("candidates"), false);
});

test("fingerprint summary reports pass rate and failed probe names", () => {
  const summary = buildFingerprintProbeSummary([
    {
      caseId: "fingerprint_instruction_lock",
      caseName: "指纹探针：固定 JSON 指令",
      admission: { probe: true, passed: true },
    },
    {
      caseId: "fingerprint_logic_anchor",
      caseName: "指纹探针：基础逻辑锚点",
      admission: { probe: true, passed: false, issue: "未返回 8" },
    },
  ]);

  assert.equal(summary.totalCount, 2);
  assert.equal(summary.passedCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.passRateText, "50%");
  assert.match(summary.libraryVersion, /^\d{4}\.\d{2}\.\d{2}$/);
  assert.deepEqual(summary.failedNames, ["指纹探针：基础逻辑锚点"]);
});
