import assert from "node:assert/strict";
import test from "node:test";

import { CHINESE_SCENARIOS } from "../server/scenarios/chinese.mjs";
import { ABILITY_SCENARIOS } from "../server/scenarios/index.mjs";
import { evaluateScenarioOutput } from "../server/scenario-evaluator.mjs";

test("chinese scenarios are wired into ABILITY_SCENARIOS", () => {
  assert.ok(CHINESE_SCENARIOS.length >= 5);
  for (const s of CHINESE_SCENARIOS) {
    assert.ok(ABILITY_SCENARIOS.some((a) => a.id === s.id), `${s.id} 应在 ABILITY_SCENARIOS 中`);
  }
});

test("every chinese scenario has the required fields and unique ids", () => {
  const ids = new Set();
  for (const s of CHINESE_SCENARIOS) {
    assert.ok(s.id && !ids.has(s.id), `id 唯一: ${s.id}`);
    ids.add(s.id);
    assert.equal(s.category, "chinese");
    assert.ok(typeof s.prompt === "string" && s.prompt.length > 0);
    assert.ok(Number.isFinite(s.minChars));
    assert.ok(Array.isArray(s.requiredAny) && s.requiredAny.length > 0);
  }
});

test("evaluator passes a good chinese answer and zeroes a failed request", () => {
  const idiom = CHINESE_SCENARIOS.find((s) => s.id === "chinese-language-idiom");
  const goodText =
    "“画蛇添足”比喻做了多余的事，反而弄巧成拙、把事情办坏。本来已经完成，却画蛇加上脚。" +
    "例句：报告已经写得很清楚了，他又硬塞进一堆无关数据，纯属画蛇添足。";
  const good = evaluateScenarioOutput(idiom, { success: true, responseText: goodText });
  assert.equal(good.passed, true);
  assert.ok(good.score >= 70);
  assert.ok(good.matchedKeywords.length > 0);

  const failed = evaluateScenarioOutput(idiom, { success: false, normalizedError: "timeout" });
  assert.equal(failed.score, 0);
  assert.equal(failed.passed, false);
});

test("chinese JSON scenario expects parseable JSON", () => {
  const jsonScenario = CHINESE_SCENARIOS.find((s) => s.id === "chinese-structured-json");
  assert.equal(jsonScenario.expectsJson, true);
  const jsonText = JSON.stringify({
    模型表现: "总体可用，中文流畅",
    主要风险: ["偶发延迟", "长文截断"],
    是否推荐: true,
    理由: "成功率高且中文表达自然",
  });
  const result = evaluateScenarioOutput(jsonScenario, { success: true, responseText: jsonText });
  assert.ok(result.passed);
  assert.ok(!result.issues.includes("未输出可解析 JSON"));
});
