import assert from "node:assert/strict";
import test from "node:test";
import { evaluateScenarioOutput } from "../server/scenario-evaluator.mjs";
import { getTestScenarios } from "../server/scenarios/index.mjs";
import { __setSettingsForTest, __resetSettingsCacheForTest } from "../server/settings-store.mjs";

test("scenario registry excludes safety + livebench by default (settings off)", () => {
  __resetSettingsCacheForTest();
  const list = getTestScenarios();
  assert.equal(
    list.some((scenario) => scenario.category === "safety"),
    false,
  );
  assert.equal(
    list.some((scenario) => String(scenario.id).startsWith("livebench")),
    false,
  );
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
  assert.equal(
    getTestScenarios().some((scenario) => scenario.category === "hle"),
    false,
  );

  __setSettingsForTest({ enableHle: true });
  try {
    const hle = getTestScenarios().filter((scenario) => scenario.category === "hle");
    assert.ok(hle.length > 0, "HLE 场景应在开启后纳入");
    const ids = new Set();
    for (const scenario of hle) {
      assert.equal(scenario.scorer, "exact");
      // expected 允许「单一字符串」或「可接受形式数组」（数学等价的多种写法，见 scripts/hle-import.mjs 的 ANSWER_ALIASES）。
      // 两种形态都要求非空、且数组元素全为非空字符串——空元素会被 scoreExactAnswer 静默过滤，等于悄悄少了一种可接受写法。
      if (Array.isArray(scenario.expected)) {
        assert.ok(scenario.expected.length > 0, `expected 数组不应为空：${scenario.id}`);
        for (const form of scenario.expected) {
          assert.ok(typeof form === "string" && form.length > 0, `expected 数组元素应为非空字符串：${scenario.id}`);
        }
      } else {
        assert.ok(typeof scenario.expected === "string" && scenario.expected.length > 0);
      }
      assert.ok(["逻辑推理", "知识事实"].includes(scenario.tag), `tag 应为逻辑推理/知识事实，实为 ${scenario.tag}`);
      assert.equal(ids.has(scenario.id), false, `id 应唯一：${scenario.id}`);
      ids.add(scenario.id);
    }
  } finally {
    __resetSettingsCacheForTest();
  }
});

test("HLE 物理 #16 接受加法交换律等价写法（-X + d == d - X）", () => {
  // 回归：镜像 ground truth 只有 "-((d - 2k)^2) + d" 一种写法，模型写 "d - (d - 2k)^2"
  // 是同一表达式（加法交换），exact 判分器看不见数学等价 → 假阴性。
  // HLE 用于档位降级判别，假阴性会凭空制造「硬题崩」的证据，故用可接受形式数组兜住。
  // 可接受形式在 scripts/hle-import.mjs 的 ANSWER_ALIASES 里，重跑导入脚本不会丢。
  __setSettingsForTest({ enableHle: true });
  try {
    const q16 = getTestScenarios().find((scenario) => scenario.id === "hle-physics-16");
    assert.ok(q16, "hle-physics-16 应存在");
    assert.ok(Array.isArray(q16.expected), "expected 应为可接受形式数组");
    // 镜像原答案必须留在首位（覆盖表只增不减）
    assert.equal(q16.expected[0], "\\(-((d - 2k)^2) + d\\)");

    const answered = (text) => evaluateScenarioOutput(q16, { success: true, responseText: `推导若干步。<solution>${text}</solution>` });
    // 原形式与交换后形式都要判过，定界符有无、^2/^{2}、(d-2k)/(2k-d) 均等价
    for (const form of [
      "\\(-((d - 2k)^2) + d\\)",
      "\\(d - (d - 2k)^2\\)",
      "d - (d - 2k)^2",
      "d-(d-2k)^2",
      "\\(d - (d - 2k)^{2}\\)",
      "\\(d - (2k - d)^2\\)",
    ]) {
      const r = answered(form);
      assert.equal(r.passed, true, `应判过：${form}（实得 ${r.score} 分，issues=${JSON.stringify(r.issues)}）`);
      assert.equal(r.score, 100);
    }
    // 真答错仍判错（别把闸门开成恒真）
    assert.equal(answered("\\(d + (d - 2k)^2\\)").passed, false);
    assert.equal(answered("\\(2d - (d - 2k)^2\\)").passed, false);
    assert.equal(answered("42").passed, false);
  } finally {
    __resetSettingsCacheForTest();
  }
});

test("scenario registry excludes HardcoreLogic by default and includes it when enabled", () => {
  __resetSettingsCacheForTest();
  assert.equal(
    getTestScenarios().some((scenario) => scenario.category === "hardcore-logic"),
    false,
  );

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
