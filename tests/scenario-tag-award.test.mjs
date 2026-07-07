// tests/scenario-tag-award.test.mjs
// 场景测验「夺标」纯逻辑：从 summary 推导应得标签 + 合并进模型目标（并集去重、只增不撤）。
import assert from "node:assert/strict";
import test from "node:test";

import {
  computeEarnedTags,
  applyEarnedTags,
  TAG_AWARD_MIN_SCORE,
} from "../server/scenario-tag-award.mjs";

const scenarios = [
  { id: "s-code", tag: "编程" },
  { id: "s-reason", tag: "推理" },
  { id: "s-notag", tag: "" }, // 无 tag 的场景永不授标
];

test("阈值常量 = 90", () => {
  assert.equal(TAG_AWARD_MIN_SCORE, 90);
});

test("computeEarnedTags：>=90 且场景有 tag 才入；<90 不入；无 tag 场景不入", () => {
  const summary = {
    results: [
      {
        profileId: "p1",
        scenarios: [
          { scenarioId: "s-code", avgQualityScore: 90 }, // 边界含 → 入
          { scenarioId: "s-reason", avgQualityScore: 89 }, // 差一分 → 不入
          { scenarioId: "s-notag", avgQualityScore: 100 }, // 满分但无 tag → 不入
        ],
      },
    ],
  };
  const got = computeEarnedTags(summary, scenarios);
  assert.deepEqual([...got.get("p1")], ["编程"]);
});

test("computeEarnedTags：多场景达标 → 并集；无 profileId 跳过；无所得不入表", () => {
  const summary = {
    results: [
      { profileId: "p1", scenarios: [
        { scenarioId: "s-code", avgQualityScore: 95 },
        { scenarioId: "s-reason", avgQualityScore: 99 },
      ] },
      { profileId: "p2", scenarios: [{ scenarioId: "s-code", avgQualityScore: 10 }] }, // 全不达标 → 不入表
      { scenarios: [{ scenarioId: "s-code", avgQualityScore: 100 }] }, // 无 profileId → 跳过
    ],
  };
  const got = computeEarnedTags(summary, scenarios);
  assert.deepEqual([...got.get("p1")].sort(), ["推理", "编程"].sort());
  assert.equal(got.has("p2"), false, "全不达标的 profile 不入表");
  assert.equal(got.size, 1);
});

test("computeEarnedTags：字符串分数也按数值比较（Number 归一）", () => {
  const summary = { results: [{ profileId: "p1", scenarios: [{ scenarioId: "s-code", avgQualityScore: "92" }] }] };
  assert.deepEqual([...computeEarnedTags(summary, scenarios).get("p1")], ["编程"]);
});

test("computeEarnedTags：summary/字段缺失都安全 → 空表", () => {
  assert.equal(computeEarnedTags(undefined, scenarios).size, 0);
  assert.equal(computeEarnedTags({}, scenarios).size, 0);
  assert.equal(computeEarnedTags({ results: [] }, scenarios).size, 0);
  assert.equal(computeEarnedTags({ results: [{ profileId: "p1" }] }, scenarios).size, 0, "无 scenarios 字段");
});

test("computeEarnedTags：自定义 minScore", () => {
  const summary = { results: [{ profileId: "p1", scenarios: [{ scenarioId: "s-code", avgQualityScore: 70 }] }] };
  assert.equal(computeEarnedTags(summary, scenarios, 90).size, 0, "默认 90 不达");
  assert.deepEqual([...computeEarnedTags(summary, scenarios, 70).get("p1")], ["编程"], "降到 70 达标");
});

test("applyEarnedTags：按 target.id===profileId 命中，并集去重、刷新 updatedAt", () => {
  const NOW = "2026-06-30T00:00:00.000Z";
  const targets = [
    { id: "p1", tags: ["编程"], updatedAt: "old" }, // 已有「编程」，新增「推理」
    { id: "p2", updatedAt: "old" }, // 无 tags 字段
    { id: "p3", tags: ["写作"], updatedAt: "old" }, // 不在 earned → 不动
  ];
  const earned = new Map([
    ["p1", new Set(["编程", "推理"])],
    ["p2", new Set(["编程"])],
  ]);
  const changed = applyEarnedTags(targets, earned, NOW);
  assert.equal(changed, true);
  assert.deepEqual([...targets[0].tags].sort(), ["推理", "编程"].sort());
  assert.equal(targets[0].updatedAt, NOW, "有新增 → 刷新时间");
  assert.deepEqual(targets[1].tags, ["编程"]);
  assert.equal(targets[1].updatedAt, NOW);
  assert.deepEqual(targets[2].tags, ["写作"], "未命中 target 标签不变");
  assert.equal(targets[2].updatedAt, "old", "未命中 target 不刷新时间");
});

test("applyEarnedTags：只增不撤——已含全部应得标签 → 不改动、不刷新时间", () => {
  const targets = [{ id: "p1", tags: ["编程", "推理"], updatedAt: "old" }];
  const earned = new Map([["p1", new Set(["编程"])]]); // 已是子集
  const changed = applyEarnedTags(targets, earned, "2026-06-30T00:00:00.000Z");
  assert.equal(changed, false, "无新增 → 不算改动");
  assert.deepEqual(targets[0].tags, ["编程", "推理"], "原标签一个不少、不撤");
  assert.equal(targets[0].updatedAt, "old", "无谓回写应避免");
});

test("applyEarnedTags：空目标/空 earned 安全", () => {
  assert.equal(applyEarnedTags([], new Map([["p1", new Set(["x"])]]), "t"), false);
  assert.equal(applyEarnedTags([{ id: "p1", tags: ["a"] }], new Map(), "t"), false);
  assert.equal(applyEarnedTags(undefined, new Map(), "t"), false);
});
