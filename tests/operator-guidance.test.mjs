import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProfileTemplateToForm,
  buildStandardActionPlan,
  buildErrorAdviceText,
  buildStandardOperatorSummary,
  buildStandardNextStepAdvice,
  normalizeErrorKey,
  pickScenarioIdsForPack,
  PROFILE_TEMPLATES,
  validateProfileConfig,
} from "../src/operator-guidance.js";

function mockProfileForm() {
  const field = () => ({ value: "", placeholder: "" });
  return { elements: { provider: field(), protocol: field(), maxTokens: field(), timeoutMs: field(), baseUrl: field(), defaultModel: field(), notes: field() } };
}

test("profile templates cover common model families with valid shape", () => {
  const required = ["label", "provider", "protocol", "baseUrlPlaceholder", "modelPlaceholder", "maxTokens", "timeoutMs", "notes"];
  for (const [key, template] of Object.entries(PROFILE_TEMPLATES)) {
    for (const field of required) assert.ok(template[field] !== undefined, `${key} 缺字段 ${field}`);
    assert.ok(["openai_compatible", "openai_chat", "claude_messages"].includes(template.protocol), `${key} 协议非法`);
  }
  // 用户点名要能配的常见模型家族都有预设
  for (const key of ["gemini_openai_compatible", "kimi_openai_compatible", "doubao_openai_compatible", "glm_openai_compatible", "qwen_openai_compatible", "grok_openai_compatible"]) {
    assert.ok(PROFILE_TEMPLATES[key], `缺预设 ${key}`);
  }
  // 选预设能把协议/厂商自动填进表单
  const form = mockProfileForm();
  const applied = applyProfileTemplateToForm(form, "qwen_openai_compatible");
  assert.equal(applied.provider, "Alibaba");
  assert.equal(form.elements.protocol.value, "openai_compatible");
  assert.equal(form.elements.notes.value, applied.notes);
});

test("operator guidance maps common API errors to user-facing advice", () => {
  assert.equal(normalizeErrorKey("API Error: Content block not found"), "content_block_not_found");
  assert.equal(normalizeErrorKey("request timeout after 60000ms"), "timeout");
  assert.equal(normalizeErrorKey({ normalizedError: "auth_failed" }), "auth_failed");

  const advice = buildErrorAdviceText("Content block not found");
  assert.match(advice, /内容块缺失/);
  assert.match(advice, /协议/);
});

test("operator guidance selects scenario packs by category", () => {
  const scenarios = [
    { id: "a", category: "connectivity" },
    { id: "b", category: "speed" },
    { id: "c", category: "structured" },
    { id: "d", category: "coding" },
    { id: "e", category: "long_context" },
    { id: "f", category: "safety" },
  ];

  assert.deepEqual(pickScenarioIdsForPack(scenarios, "scenario-small"), ["a", "b", "c"]);
  assert.deepEqual(pickScenarioIdsForPack(scenarios, "scenario-coding"), ["d"]);
  assert.deepEqual(pickScenarioIdsForPack(scenarios, "scenario-safety"), ["f"]);
  assert.deepEqual(pickScenarioIdsForPack(scenarios, "scenario-basic"), ["a", "b", "c", "d", "e"]);
});

test("operator guidance recommends next step after standard evaluation", () => {
  const passAdvice = buildStandardNextStepAdvice({
    quick: { success: true },
    stability: { successRate: 1, p95TotalMs: 1200 },
    scenario: { results: [{ avgQualityScore: 80 }] },
  });
  assert.match(passAdvice.join("\n"), /复制交付模板/);

  const failAdvice = buildStandardNextStepAdvice({
    quick: { success: false },
    stability: null,
    scenario: null,
  });
  assert.match(failAdvice.join("\n"), /不要继续消耗 token/);
});

test("operator guidance validates API profile configuration before save", () => {
  const invalid = validateProfileConfig({
    baseUrl: "https://api.example.com/v1/chat/completions",
    protocol: "openai_compatible",
    defaultModel: "demo-model",
    apiKey: "sk-test",
    timeoutMs: "60000",
    maxTokens: "512",
  });
  assert.equal(invalid.hasBlockers, true);
  assert.ok(invalid.issues.some((issue) => /不要带/.test(issue.detail)));

  const warning = validateProfileConfig({
    baseUrl: "https://api.anthropic.com",
    protocol: "openai_compatible",
    defaultModel: "claude-sonnet-4-5",
    apiKey: "sk-test",
    timeoutMs: "10000",
    maxTokens: "64",
  });
  assert.equal(warning.hasWarnings, true);
  assert.equal(warning.hasBlockers, false);
});

test("profile config requires API key for new profiles but allows blank when editing", () => {
  const base = {
    baseUrl: "https://api.example.com",
    protocol: "openai_compatible",
    defaultModel: "demo-model",
  };
  // 新建（无 id）且无 Key → blocker
  const newNoKey = validateProfileConfig({ ...base });
  assert.equal(newNoKey.hasBlockers, true);
  assert.ok(newNoKey.issues.some((i) => /必须填 API Key/.test(i.title)));
  // 编辑（有 id）留空 Key → 不因 Key 报 blocker
  const editNoKey = validateProfileConfig({ ...base, id: "p-123" });
  assert.ok(!editNoKey.issues.some((i) => /API Key/.test(i.title)));
  assert.equal(editNoKey.hasBlockers, false);
});

test("operator guidance builds plain-language summary and action buttons", () => {
  const summary = buildStandardOperatorSummary({
    quick: { success: true },
    stability: { successRate: 1, p95TotalMs: 1000 },
    scenario: { results: [{ avgQualityScore: 85 }] },
  });
  assert.equal(summary.level, "pass");
  assert.match(summary.title, /初筛通过/);
  assert.match(summary.detail, /复制交付模板/);

  const passActions = buildStandardActionPlan({
    quick: { success: true },
    stability: { successRate: 1, p95TotalMs: 1000 },
    scenario: { results: [{ avgQualityScore: 85 }] },
  });
  assert.deepEqual(
    passActions.map((action) => action.action),
    ["handoff", "stability-basic", "scenario-basic"],
  );
  assert.equal(passActions[0].kind, "primary");

  const actions = buildStandardActionPlan({
    quick: { success: false },
    stability: null,
    scenario: null,
  });
  assert.deepEqual(
    actions.map((action) => action.action),
    ["profile-config", "quick-retry"],
  );
});
