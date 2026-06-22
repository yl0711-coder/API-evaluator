import assert from "node:assert/strict";
import test from "node:test";

import { evaluateScenarioOutput } from "../server/scenario-evaluator.mjs";
import { ABILITY_SCENARIOS } from "../server/scenarios/index.mjs";
import { buildScenarioProfileSummary } from "../server/summaries.mjs";

test("needle scenario passes only when the fact is retrieved", () => {
  const scenario = { id: "x", scorer: "needle", needle: "ORION-7", minChars: 1 };
  const hit = evaluateScenarioOutput(scenario, { success: true, responseText: "项目代号是 ORION-7。" });
  assert.equal(hit.passed, true);
  assert.equal(hit.score, 100);
  assert.equal(hit.scorer, "needle");

  const miss = evaluateScenarioOutput(scenario, { success: true, responseText: "我不确定。" });
  assert.equal(miss.passed, false);
  assert.equal(miss.score, 0);
});

test("ifeval scenario scores by verifiable instructions", () => {
  const scenario = {
    id: "y",
    scorer: "ifeval",
    instructions: [
      { type: "include_keyword", keyword: "标题：" },
      { type: "include_keyword", keyword: "要点：" },
      { type: "include_keyword", keyword: "、" },
    ],
  };
  const good = evaluateScenarioOutput(scenario, {
    success: true,
    responseText: "标题：远程办公\n要点：省通勤、更灵活、专注高",
  });
  assert.equal(good.passed, true);
  assert.equal(good.score, 100);

  const partial = evaluateScenarioOutput(scenario, { success: true, responseText: "标题：远程办公" });
  assert.equal(partial.passed, false);
  assert.ok(partial.score > 0 && partial.score < 100);
  assert.ok(partial.issues.length > 0);
});

test("bfcl scenario scores tool call structurally (dormant until tool path wired)", () => {
  const scenario = { id: "z", scorer: "bfcl", expectedToolCall: { name: "get_weather", arguments: { city: "北京" } } };
  const ok = evaluateScenarioOutput(scenario, { success: true, responseText: "", toolCall: { name: "get_weather", arguments: { city: "北京" } } });
  assert.equal(ok.passed, true);
  const noTool = evaluateScenarioOutput(scenario, { success: true, responseText: "天气不错" });
  assert.equal(noTool.passed, false); // 未产生工具调用
});

test("scenarios without a scorer still use the default heuristic", () => {
  const scenario = { id: "h", minChars: 5, requiredAny: ["你好"] };
  const r = evaluateScenarioOutput(scenario, { success: true, responseText: "你好，世界，这是一段回答。" });
  assert.ok(r.score >= 70);
  assert.equal(r.scorer, undefined); // 走启发式分支
});

test("failed requests still score 0 regardless of scorer", () => {
  const scenario = { id: "n", scorer: "needle", needle: "X" };
  const r = evaluateScenarioOutput(scenario, { success: false, normalizedError: "timeout" });
  assert.equal(r.score, 0);
  assert.equal(r.passed, false);
});

test("exact scenario scores objective answers via evaluateScenarioOutput", () => {
  const scenario = { id: "lb-math", scorer: "exact", expected: "42", scorerOptions: { numeric: true } };
  const ok = evaluateScenarioOutput(scenario, { success: true, responseText: "推导若干步后，\\boxed{42}" });
  assert.equal(ok.passed, true);
  assert.equal(ok.score, 100);
  assert.equal(ok.scorer, "exact");

  const wrong = evaluateScenarioOutput(scenario, { success: true, responseText: "答案：41" });
  assert.equal(wrong.passed, false);
  assert.equal(wrong.score, 0);
});

test("structured scenario scores table/JSON output via evaluateScenarioOutput", () => {
  const scenario = { id: "lb-data", scorer: "structured", expected: { col: "age", type: "int" } };
  const ok = evaluateScenarioOutput(scenario, { success: true, responseText: '{"col":"age","type":"int"}' });
  assert.equal(ok.passed, true);
  assert.equal(ok.score, 100);
  assert.equal(ok.scorer, "structured");

  const partial = evaluateScenarioOutput(scenario, { success: true, responseText: '{"col":"age","type":"string"}' });
  assert.equal(partial.passed, false);
  assert.ok(partial.score > 0 && partial.score < 100);
});

test("set scenario scores unordered grouping via evaluateScenarioOutput", () => {
  const scenario = { id: "lb-lang", scorer: "set", expectedSet: ["红", "黄", "蓝"] };
  const ok = evaluateScenarioOutput(scenario, { success: true, responseText: "答案：蓝、红、黄" });
  assert.equal(ok.passed, true);
  assert.equal(ok.score, 100);
  assert.equal(ok.scorer, "set");
});

test("truncated responses are flagged inconclusive, not scored as a wrong answer", () => {
  const sc = { id: "lb", scorer: "exact", expected: "42" };
  // OpenAI finish_reason=length
  const r1 = evaluateScenarioOutput(sc, { success: true, responseText: '{"part', finishReason: "length" });
  assert.equal(r1.truncated, true);
  assert.equal(r1.passed, false);
  assert.match(r1.issues.join(""), /截断/);
  // Claude stop_reason=max_tokens
  assert.equal(evaluateScenarioOutput(sc, { success: true, responseText: "x", finishReason: "max_tokens" }).truncated, true);
  // 字节上限
  assert.equal(evaluateScenarioOutput(sc, { success: false, normalizedError: "response_too_large" }).truncated, true);
  // 完整正确答案不会被误标截断
  const ok = evaluateScenarioOutput(sc, { success: true, responseText: "答案：42", finishReason: "stop" });
  assert.equal(ok.truncated, undefined);
  assert.equal(ok.passed, true);
});

test("buildScenarioProfileSummary excludes truncated items from quality score", () => {
  const mk = (quality, extra = {}) => ({
    success: true,
    scenarioId: "s1",
    scenarioName: "S1",
    totalMs: 100,
    responseSummary: "ans",
    quality,
    ...extra,
  });
  const profile = { id: "p", name: "P", defaultModel: "m", protocol: "openai_compatible" };
  // 两条好题（score 100/80）+ 一条被截断（score 0, truncated）→ 均分应只算前两条 = 90，不是 60。
  const records = [
    mk({ score: 100, passed: true }),
    mk({ score: 80, passed: true }),
    mk({ score: 0, passed: false, truncated: true }),
  ];
  const summary = buildScenarioProfileSummary(profile, records);
  assert.equal(summary.avgQualityScore, 90);
  assert.equal(summary.scenarios[0].truncatedCount, 1);
  assert.match(summary.scenarios[0].sampleResponse, /^ans$/); // 样例取未截断那条，无前缀
});

test("NIAH scenario is registered with a needle scorer", () => {
  const niah = ABILITY_SCENARIOS.find((s) => s.id === "long-context-needle");
  assert.ok(niah);
  assert.equal(niah.scorer, "needle");
  assert.equal(niah.needle, "ORION-7");
  assert.ok(niah.prompt.includes("ORION-7")); // needle 确实埋在 haystack 里
});
