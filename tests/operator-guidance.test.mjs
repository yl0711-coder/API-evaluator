import assert from "node:assert/strict";
import test from "node:test";
import { P95_LATENCY_OK_MS, P95_LATENCY_SLOW_MS } from "../shared/thresholds.mjs";
import {
  applyProfileTemplateToForm,
  buildStandardActionPlan,
  buildErrorAdviceText,
  buildStandardOperatorSummary,
  buildStandardNextStepAdvice,
  normalizeErrorKey,
  PROFILE_TEMPLATES,
  validateProfileConfig,
} from "../src/operator-guidance.js";

function mockProfileForm() {
  const field = () => ({ value: "", placeholder: "" });
  return {
    elements: {
      provider: field(),
      protocol: field(),
      maxTokens: field(),
      timeoutMs: field(),
      baseUrl: field(),
      defaultModel: field(),
      notes: field(),
    },
  };
}

test("profile templates cover common model families with valid shape", () => {
  const required = ["label", "provider", "protocol", "baseUrlPlaceholder", "modelPlaceholder", "maxTokens", "timeoutMs", "notes"];
  for (const [key, template] of Object.entries(PROFILE_TEMPLATES)) {
    for (const field of required) assert.ok(template[field] !== undefined, `${key} 缺字段 ${field}`);
    assert.ok(["openai_compatible", "openai_chat", "claude_messages"].includes(template.protocol), `${key} 协议非法`);
  }
  // 用户点名要能配的常见模型家族都有预设
  for (const key of [
    "gemini_openai_compatible",
    "kimi_openai_compatible",
    "doubao_openai_compatible",
    "glm_openai_compatible",
    "qwen_openai_compatible",
    "grok_openai_compatible",
  ]) {
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

test("operator guidance recommends next step after standard evaluation", () => {
  const passAdvice = buildStandardNextStepAdvice({
    quick: { success: true },
    stability: { successRate: 1, p95TotalMs: 1200 },
    admission: { grade: "A" },
  });
  assert.match(passAdvice.join("\n"), /复制交付模板/);

  const failAdvice = buildStandardNextStepAdvice({
    quick: { success: false },
    stability: null,
    admission: null,
  });
  assert.match(failAdvice.join("\n"), /不要继续消耗 token/);

  const gradeFailAdvice = buildStandardNextStepAdvice({
    quick: { success: true },
    stability: { successRate: 1, p95TotalMs: 1200 },
    admission: { grade: "D" },
  });
  assert.match(gradeFailAdvice.join("\n"), /标准准入等级为 D/);
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
    admission: { grade: "A" },
  });
  assert.equal(summary.level, "pass");
  assert.match(summary.title, /初筛通过/);
  assert.match(summary.detail, /复制交付模板/);

  const passActions = buildStandardActionPlan({
    quick: { success: true },
    stability: { successRate: 1, p95TotalMs: 1000 },
    admission: { grade: "A" },
  });
  assert.deepEqual(
    passActions.map((action) => action.action),
    ["handoff", "stability-candidate", "admission-deep"],
  );
  assert.equal(passActions[0].kind, "primary");

  const actions = buildStandardActionPlan({
    quick: { success: false },
    stability: null,
    admission: null,
  });
  assert.deepEqual(
    actions.map((action) => action.action),
    ["profile-config", "quick-retry"],
  );

  const gradeFailSummary = buildStandardOperatorSummary({
    quick: { success: true },
    stability: { successRate: 1, p95TotalMs: 1000 },
    admission: { grade: "E" },
  });
  assert.equal(gradeFailSummary.level, "fail");
  assert.match(gradeFailSummary.title, /标准准入等级为 E/);
});

// —— 以下为 ADM-011（阈值口径不一致）的回归锁 ——
//
// 为什么原有 6 条测试没能发现这个 bug：它们的 p95 一律取 1000~1200 ms，全都落在
// 「怎么算都算快」的区间里，永远碰不到阈值边界。于是前端硬编码的 30000 与服务端的
// 15000/45000 冲突了很久也没被任何断言照到。下面的用例专打边界。

test("ADM-011: 前端初筛延迟分档与服务端 15s/45s 对齐，不再自带 30s 口径", () => {
  const at = (p95TotalMs) =>
    buildStandardOperatorSummary({ quick: { success: true }, stability: { successRate: 1, p95TotalMs }, admission: { grade: "A" } });

  // 边界内侧：恰好等于 OK 阈值仍算通过（用 <= 而非 <）。
  assert.equal(at(P95_LATENCY_OK_MS).level, "pass");

  // 15s~45s 之间：服务端 evaluateStability 判 warning（有条件通过），前端必须是 watch 而非 pass。
  // 旧代码这里返回 pass —— 因为它拿 30000 比，20s 被当成快。这是本次修复的核心。
  const conditional = at(20000);
  assert.equal(conditional.level, "watch");
  assert.match(conditional.detail, new RegExp(String(P95_LATENCY_OK_MS)));

  // 恰好等于 SLOW 阈值：仍属有条件，不算过慢（服务端也是 > 才 NOT_PASSED）。
  assert.equal(at(P95_LATENCY_SLOW_MS).level, "watch");

  // 超过 45s：服务端判 NOT_PASSED，前端必须同为 fail。
  // 旧代码这里只降级到 watch「能用，但速度偏慢」—— 一条服务端判不通过的渠道，
  // 在人话面板上仍显示能用，这是最容易误导用户的一档。
  const tooSlow = at(P95_LATENCY_SLOW_MS + 1);
  assert.equal(tooSlow.level, "fail");
  assert.match(tooSlow.title, /过慢/);
});

test("ADM-011: 两个消费者共用同一判定阶梯，不会互相漂移", () => {
  // buildStandardNextStepAdvice 与 buildStandardOperatorSummary 曾各自抄一套 if-else。
  // 现在同源，故对同一输入必须给出同向结论。取 20s（旧代码两处都会误判成通过的值）。
  const input = { quick: { success: true }, stability: { successRate: 1, p95TotalMs: 20000 }, admission: { grade: "A" } };
  const summary = buildStandardOperatorSummary(input);
  const advice = buildStandardNextStepAdvice(input).join("\n");

  assert.equal(summary.level, "watch");
  assert.match(advice, /偏慢/);
  // 按钮方案跟着同一判定走：非 pass 就不该出现「跑深度准入」那套推进动作。
  const actions = buildStandardActionPlan(input).map((a) => a.action);
  assert.deepEqual(actions, ["reports", "stability-smoke", "handoff"]);
});

test("ADM-011: 缺失 p95 不得当成快，成功率中间带给人工复核", () => {
  // p95 为 0 / null 表示「没测到延迟」。刻意放行（不阻断），但不得因此判成 pass 以外的档位错乱。
  const noP95 = buildStandardOperatorSummary({
    quick: { success: true },
    stability: { successRate: 1, p95TotalMs: null },
    admission: { grade: "A" },
  });
  assert.equal(noP95.level, "pass");

  // 0.9~0.95 之间是刻意留的带：既不够好也不够差，必须是 watch「需人工复核」，
  // 不能硬掰成通过或失败。合并阈值会让这条带消失。
  const midBand = buildStandardOperatorSummary({
    quick: { success: true },
    stability: { successRate: 0.92, p95TotalMs: 1000 },
    admission: { grade: "A" },
  });
  assert.equal(midBand.level, "watch");
  assert.match(midBand.title, /人工复核/);

  // 低于 0.9 仍是 fail。
  const low = buildStandardOperatorSummary({
    quick: { success: true },
    stability: { successRate: 0.5, p95TotalMs: 1000 },
    admission: { grade: "A" },
  });
  assert.equal(low.level, "fail");
});
