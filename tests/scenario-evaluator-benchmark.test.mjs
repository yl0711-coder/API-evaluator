import assert from "node:assert/strict";
import test from "node:test";

import { evaluateScenarioOutput } from "../server/scenario-evaluator.mjs";
import { ABILITY_SCENARIOS } from "../server/scenarios/index.mjs";

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

test("NIAH scenario is registered with a needle scorer", () => {
  const niah = ABILITY_SCENARIOS.find((s) => s.id === "long-context-needle");
  assert.ok(niah);
  assert.equal(niah.scorer, "needle");
  assert.equal(niah.needle, "ORION-7");
  assert.ok(niah.prompt.includes("ORION-7")); // needle 确实埋在 haystack 里
});
