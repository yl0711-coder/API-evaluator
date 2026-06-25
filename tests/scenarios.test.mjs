import assert from "node:assert/strict";
import test from "node:test";
import { getTestScenarios } from "../server/scenarios/index.mjs";
import { __setSettingsForTest, __resetSettingsCacheForTest } from "../server/settings-store.mjs";

test("scenario registry excludes safety + livebench by default (settings off)", () => {
  __resetSettingsCacheForTest();
  const list = getTestScenarios();
  assert.equal(list.some((scenario) => scenario.category === "safety"), false);
  assert.equal(list.some((scenario) => String(scenario.id).startsWith("livebench")), false);
  assert.ok(list.some((scenario) => scenario.category === "coding"));
});

test("scenario registry includes safety + livebench when enabled in settings", () => {
  __setSettingsForTest({ enableSafety: true, enableLivebench: true });
  try {
    const list = getTestScenarios();
    assert.ok(list.some((scenario) => scenario.category === "safety"));
    assert.ok(list.some((scenario) => String(scenario.id).startsWith("livebench")));
    assert.ok(list.some((scenario) => scenario.category === "coding"));
  } finally {
    __resetSettingsCacheForTest();
  }
});

test("scenario registry excludes HLE by default and includes it when enabled", () => {
  __resetSettingsCacheForTest();
  assert.equal(getTestScenarios().some((scenario) => scenario.category === "hle"), false);

  __setSettingsForTest({ enableHle: true });
  try {
    const hle = getTestScenarios().filter((scenario) => scenario.category === "hle");
    assert.ok(hle.length > 0, "HLE 场景应在开启后纳入");
    const ids = new Set();
    for (const scenario of hle) {
      assert.equal(scenario.scorer, "exact");
      assert.ok(typeof scenario.expected === "string" && scenario.expected.length > 0);
      assert.ok(["逻辑推理", "知识事实"].includes(scenario.tag), `tag 应为逻辑推理/知识事实，实为 ${scenario.tag}`);
      assert.equal(ids.has(scenario.id), false, `id 应唯一：${scenario.id}`);
      ids.add(scenario.id);
    }
  } finally {
    __resetSettingsCacheForTest();
  }
});

test("scenario registry excludes HardcoreLogic by default and includes it when enabled", () => {
  __resetSettingsCacheForTest();
  assert.equal(getTestScenarios().some((scenario) => scenario.category === "hardcore-logic"), false);

  __setSettingsForTest({ enableHardcoreLogic: true });
  try {
    const pack = getTestScenarios().filter((scenario) => scenario.category === "hardcore-logic");
    assert.ok(pack.length > 0, "HardcoreLogic 场景应在开启后纳入");
    const ids = new Set();
    for (const scenario of pack) {
      assert.equal(scenario.scorer, "structured");
      assert.ok(
        scenario.expected && typeof scenario.expected === "object" && "solvable" in scenario.expected,
        `expected 应为含 solvable 的对象：${scenario.id}`,
      );
      assert.equal(scenario.tag, "逻辑推理", `tag 应为逻辑推理，实为 ${scenario.tag}`);
      assert.equal(ids.has(scenario.id), false, `id 应唯一：${scenario.id}`);
      ids.add(scenario.id);
    }
  } finally {
    __resetSettingsCacheForTest();
  }
});
