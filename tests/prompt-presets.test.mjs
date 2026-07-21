import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPromptPresetToForm,
  BATCH_PROMPT_PRESETS,
  getPromptPreset,
  QUICK_PROMPT_PRESETS,
  renderPromptPresetOptions,
  STANDARD_PROMPT_PRESETS,
  STABILITY_PROMPT_PRESETS,
} from "../src/prompt-presets.js";

test("prompt presets exist for every prompt input entry", () => {
  assert.deepEqual(QUICK_PROMPT_PRESETS.map((preset) => preset.id), ["connectivity", "format", "chinese", "custom"]);
  assert.deepEqual(STANDARD_PROMPT_PRESETS.map((preset) => preset.id), ["default", "operator", "format", "custom"]);
  assert.deepEqual(BATCH_PROMPT_PRESETS.map((preset) => preset.id), ["fair-basic", "fair-json", "fair-business", "custom"]);
  assert.ok([...QUICK_PROMPT_PRESETS, ...STANDARD_PROMPT_PRESETS, ...BATCH_PROMPT_PRESETS].every((preset) => preset.label && preset.hint));
});

test("stability prompt presets cover representative operator scenarios", () => {
  const ids = STABILITY_PROMPT_PRESETS.map((preset) => preset.id);

  assert.deepEqual(ids, [
    "basic",
    "customer-support",
    "marketing",
    "structured-json",
    "coding",
    "long-summary",
    "custom",
  ]);
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
