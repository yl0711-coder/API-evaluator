import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPromptPresetToForm,
  BATCH_PROMPT_PRESETS,
  getPromptPreset,
  QUICK_PROMPT_PRESETS,
  readStabilityGroups,
  renderPromptPresetOptions,
  renderStabilityGroupPicker,
  STANDARD_PROMPT_PRESETS,
  STABILITY_PROMPT_PRESETS,
} from "../src/prompt-presets.js";

test("prompt presets exist for every prompt input entry", () => {
  assert.deepEqual(
    QUICK_PROMPT_PRESETS.map((preset) => preset.id),
    ["connectivity", "format", "chinese", "custom"],
  );
  assert.deepEqual(
    STANDARD_PROMPT_PRESETS.map((preset) => preset.id),
    ["default", "operator", "format", "custom"],
  );
  assert.deepEqual(
    BATCH_PROMPT_PRESETS.map((preset) => preset.id),
    ["fair-basic", "fair-json", "fair-business", "custom"],
  );
  assert.ok([...QUICK_PROMPT_PRESETS, ...STANDARD_PROMPT_PRESETS, ...BATCH_PROMPT_PRESETS].every((preset) => preset.label && preset.hint));
});

test("stability prompt presets cover representative operator scenarios", () => {
  const ids = STABILITY_PROMPT_PRESETS.map((preset) => preset.id);

  assert.deepEqual(ids, ["basic", "customer-support", "marketing", "structured-json", "coding", "long-summary", "custom"]);
  assert.ok(STABILITY_PROMPT_PRESETS.every((preset) => preset.label && preset.hint));
  assert.match(getPromptPreset("stability", "basic").prompt, /稳定性测试/);
  assert.match(getPromptPreset("stability", "structured-json").prompt, /严格 JSON/);
  assert.equal(getPromptPreset("stability", "custom").prompt, "");
});

test("prompt preset options render selected item for each test kind", () => {
  const quickHtml = renderPromptPresetOptions("quick", "format");
  const stabilityHtml = renderPromptPresetOptions("stability", "coding");
  const batchHtml = renderPromptPresetOptions("batch", "fair-json");

  assert.match(quickHtml, /格式检查/);
  assert.match(quickHtml, /value="format" selected/);
  assert.match(stabilityHtml, /编程场景/);
  assert.match(stabilityHtml, /value="coding" selected/);
  assert.match(batchHtml, /公平对比：统一 JSON/);
  assert.match(batchHtml, /value="fair-json" selected/);
  assert.match(batchHtml, /自定义/);
});

test("prompt preset application locks generated prompts and unlocks custom input", () => {
  const promptInput = {
    value: "",
    readOnly: false,
    classList: createClassList(),
    focusCalled: false,
    focus() {
      this.focusCalled = true;
    },
  };
  const form = { elements: { prompt: promptInput } };
  const hint = { textContent: "" };
  const select = { value: "connectivity" };

  applyPromptPresetToForm({ kind: "quick", form, select, hint });
  assert.equal(promptInput.readOnly, true);
  assert.equal(promptInput.classList.has("readonly-prompt"), true);
  assert.match(promptInput.value, /API 连通测试成功/);
  assert.match(hint.textContent, /自动填入/);

  select.value = "custom";
  applyPromptPresetToForm({ kind: "quick", form, select, hint });
  assert.equal(promptInput.readOnly, false);
  assert.equal(promptInput.classList.has("readonly-prompt"), false);
  assert.equal(promptInput.focusCalled, true);
  assert.match(hint.textContent, /可以编辑/);
});

test("getPromptPreset：单参形式 → 落到 stability 库", () => {
  // 一参调用 getPromptPreset(id)：kind 默认 stability。
  assert.equal(getPromptPreset("basic").id, "basic");
  assert.match(getPromptPreset("basic").prompt, /稳定性测试/);
});

test("getPromptPreset：未知 kind → 回落 STABILITY；未知 id → 回落 presets[0]", () => {
  // 未知 kind 两参：kind 查不到 → STABILITY 库，再按 id 取。
  assert.equal(getPromptPreset("不存在kind", "coding").id, "coding", "回落 STABILITY 后仍按 id 命中");
  // 未知 id：find 落空 → 返回该库首项（stability 的 basic）。
  assert.equal(getPromptPreset("stability", "不存在id").id, STABILITY_PROMPT_PRESETS[0].id);
  assert.equal(getPromptPreset("quick", "不存在id").id, QUICK_PROMPT_PRESETS[0].id, "quick 库回落其首项");
});

test("renderPromptPresetOptions：单参形式渲染 stability 且选中该 id", () => {
  const html = renderPromptPresetOptions("coding"); // 首参非 kind → 视为 selectedId，库回落 stability
  assert.match(html, /编程场景/, "渲染 stability 选项");
  assert.match(html, /value="coding" selected/);
});

test("renderPromptPresetOptions：未知 kind 不抛错，回落 STABILITY 渲染", () => {
  const html = renderPromptPresetOptions("不存在kind", "coding");
  assert.match(html, /基础稳定性/, "回落 STABILITY 库");
  assert.equal(/ selected/.test(html), false, "无匹配项 → 无 selected（首参被当作 selectedId）");
});

function createClassList() {
  const values = new Set();
  return {
    toggle(name, enabled) {
      if (enabled) values.add(name);
      else values.delete(name);
    },
    has(name) {
      return values.has(name);
    },
  };
}

// ── 分组选择器（多组×重复次数改造新增）──

test("renderStabilityGroupPicker：每个预设一行，默认 basic 类=3、custom=1，custom 行含 textarea", () => {
  const html = renderStabilityGroupPicker();
  assert.equal((html.match(/stability-group-row/g) || []).length, STABILITY_PROMPT_PRESETS.length);
  assert.match(html, /data-preset-id="basic"[\s\S]*?value="3"/);
  assert.match(html, /data-preset-id="custom"[\s\S]*?value="1"/);
  assert.match(html, /<textarea id="stability-prompt" name="prompt"/);
});

test("renderStabilityGroupPicker：传入 selectedRepeats 覆盖默认值", () => {
  const html = renderStabilityGroupPicker({ basic: 0, coding: 5 });
  assert.match(html, /data-preset-id="basic"[\s\S]*?value="0"/);
  assert.match(html, /data-preset-id="coding"[\s\S]*?value="5"/);
});

function makeStabilityForm(repeatsByPresetId, customPromptValue = "") {
  return {
    querySelector(selector) {
      const match = selector.match(/data-preset-id="([^"]+)"/);
      const presetId = match?.[1];
      if (!presetId || !(presetId in repeatsByPresetId)) return null;
      return { value: String(repeatsByPresetId[presetId]) };
    },
    elements: { prompt: { value: customPromptValue } },
  };
}

test("readStabilityGroups：数量为 0 的预设不入选", () => {
  const form = makeStabilityForm({ basic: 3, coding: 0 });
  const groups = readStabilityGroups(form);
  assert.deepEqual(
    groups.map((g) => g.presetId),
    ["basic"],
  );
  assert.equal(groups[0].repeats, 3);
  assert.equal(groups[0].prompt, getPromptPreset("stability", "basic").prompt);
});

test("readStabilityGroups：custom 数量>0 但文案为空 → 跳过该组", () => {
  const form = makeStabilityForm({ basic: 0, custom: 2 }, "   ");
  assert.deepEqual(readStabilityGroups(form), []);
});

test("readStabilityGroups：custom 数量>0 且文案非空 → 入选，携带用户文案", () => {
  const form = makeStabilityForm({ custom: 2 }, "我的自定义测试文案");
  const groups = readStabilityGroups(form);
  assert.deepEqual(groups, [{ presetId: "custom", prompt: "我的自定义测试文案", repeats: 2 }]);
});

test("readStabilityGroups：数量框超出 [0,20] 被夹紧", () => {
  const form = makeStabilityForm({ basic: 999, coding: -5 });
  const groups = readStabilityGroups(form);
  const basic = groups.find((g) => g.presetId === "basic");
  assert.equal(basic.repeats, 20);
  assert.equal(
    groups.some((g) => g.presetId === "coding"),
    false,
  );
});
