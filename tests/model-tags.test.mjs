// tests/model-tags.test.mjs
// 标签词表/筛选纯逻辑（src/model-tags.js）：自定义标签归一、词表并集、列表标签去重、按标签筛选。
import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCustomTags,
  unionTagVocabulary,
  distinctTargetTags,
  hasUntaggedTarget,
  filterTargetsByTag,
  NO_TAG_FILTER,
} from "../src/model-tags.js";

test("normalizeCustomTags：trim/去空/去重/保序", () => {
  assert.deepEqual(normalizeCustomTags(["  推理 ", "推理", "", "  ", "长上下文"]), ["推理", "长上下文"]);
  assert.deepEqual(normalizeCustomTags(null), []);
  assert.deepEqual(normalizeCustomTags("x"), []); // 非数组 → []
});

test("unionTagVocabulary：场景标签 ∪ 自定义标签（去重、场景在前、保序）", () => {
  const scenarios = [{ tag: "编程" }, { tag: "推理" }, { tag: "" }, { tag: "编程" }];
  const custom = ["推理", "长上下文", "  写作 "];
  assert.deepEqual(unionTagVocabulary(scenarios, custom), ["编程", "推理", "长上下文", "写作"]);
});

test("unionTagVocabulary：任一为空/缺失都安全", () => {
  assert.deepEqual(unionTagVocabulary([{ tag: "编程" }], undefined), ["编程"]);
  assert.deepEqual(unionTagVocabulary(undefined, ["写作"]), ["写作"]);
  assert.deepEqual(unionTagVocabulary(null, null), []);
});

test("distinctTargetTags：模型目标上出现过的去重标签（排序）", () => {
  const targets = [
    { tags: ["编程", "推理"] },
    { tags: ["推理"] },
    { tags: [] },
    {},
    { tags: ["写作"] },
  ];
  const got = distinctTargetTags(targets);
  assert.deepEqual([...got].sort(), ["写作", "推理", "编程"].sort());
  assert.equal(got.length, 3, "去重");
});

test("hasUntaggedTarget：存在无标签模型", () => {
  assert.equal(hasUntaggedTarget([{ tags: ["x"] }, { tags: [] }]), true);
  assert.equal(hasUntaggedTarget([{ tags: ["x"] }, {}]), true); // 缺 tags 字段也算无标签
  assert.equal(hasUntaggedTarget([{ tags: ["x"] }]), false);
  assert.equal(hasUntaggedTarget([]), false);
});

test("filterTargetsByTag：全部/无标签/某标签", () => {
  const A = { id: "a", tags: ["编程", "推理"] };
  const B = { id: "b", tags: ["推理"] };
  const C = { id: "c", tags: [] };
  const D = { id: "d" }; // 无 tags 字段
  const all = [A, B, C, D];

  assert.deepEqual(filterTargetsByTag(all, ""), all, "空 → 不筛");
  assert.deepEqual(filterTargetsByTag(all, NO_TAG_FILTER), [C, D], "无标签");
  assert.deepEqual(filterTargetsByTag(all, "推理"), [A, B], "多标签模型也命中");
  assert.deepEqual(filterTargetsByTag(all, "编程"), [A]);
  assert.deepEqual(filterTargetsByTag(all, "不存在"), [], "无命中");
});
