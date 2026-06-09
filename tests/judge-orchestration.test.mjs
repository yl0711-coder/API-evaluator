import assert from "node:assert/strict";
import test from "node:test";

import {
  assessJudgePanel,
  buildJudgePrompt,
  parseJudgeScore,
  runMultiJudge,
} from "../server/judge-orchestration.mjs";

test("buildJudgePrompt is blind and asks for a parseable score", () => {
  const p = buildJudgePrompt({ question: "Q", answer: "A", rubric: "看准确性", scale: 100 });
  assert.match(p, /不要猜测回答出自哪个模型/); // 盲测
  assert.match(p, /看准确性/);
  assert.match(p, /评分：<数字>/);
  assert.match(p, /0 到 100/);
});

test("parseJudgeScore handles labeled / fraction / bare / clamp / none", () => {
  assert.equal(parseJudgeScore("讲得不错。评分：87"), 87);
  assert.equal(parseJudgeScore("8/10", { scale: 100 }), 80);
  assert.equal(parseJudgeScore("我给 92 分"), 92);
  assert.equal(parseJudgeScore("评分：250"), 100); // 越界裁剪
  assert.equal(parseJudgeScore("无法评分"), null);
  assert.equal(parseJudgeScore("85"), 85); // 单一裸数字可采用
});

test("parseJudgeScore rejects dates and out-of-range noise instead of inventing scores", () => {
  // 旧实现 bug：分数回退把日期当分数
  assert.equal(parseJudgeScore("更新于 3/2024，质量尚可"), null); // 旧：0.148
  assert.equal(parseJudgeScore("3/2024"), null);
  // 旧实现 bug：裸数字 {1,3} 截断年份
  assert.equal(parseJudgeScore("提到 2024 年的数据，给 85 分"), 85); // 旧：202→100
  // 带上下文优先于无关数字
  assert.equal(parseJudgeScore("参考了 3 篇资料，得分 78"), 78);
  // 多个无上下文数字 → 放弃（不猜）
  assert.equal(parseJudgeScore("引用了 2023 和 2024 两年的数据"), null);
  // 合理分数式仍可用
  assert.equal(parseJudgeScore("4.5/5", { scale: 100 }), 90);
});

// mock 裁判：按 judge 名返回固定分数，零真实请求
const mockCaller = (scoreByJudge) => async (judge, _prompt) => `评分：${scoreByJudge[judge] ?? 0}`;

test("runMultiJudge aggregates eligible judges and excludes same-family", async () => {
  const r = await runMultiJudge({
    judges: ["gpt-4o", "claude-3-5-sonnet", "gemini-1.5-pro"],
    targetModel: "gpt-4-turbo", // 与 gpt-4o 同家族 → 应排除
    question: "Q",
    answer: "A",
    callJudge: mockCaller({ "claude-3-5-sonnet": 80, "gemini-1.5-pro": 90 }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.excluded, ["gpt-4o"]);
  assert.equal(r.perJudge.length, 2);
  assert.equal(r.consensus, 85);
  assert.equal(r.needsHumanReview, false);
});

test("runMultiJudge flags needsHumanReview when no eligible judge", async () => {
  const r = await runMultiJudge({
    judges: ["gpt-4o"],
    targetModel: "gpt-4o-mini",
    callJudge: mockCaller({ "gpt-4o": 90 }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_eligible_judge");
  assert.equal(r.needsHumanReview, true);
});

test("runMultiJudge marks single-judge results as needing review", async () => {
  const r = await runMultiJudge({
    judges: ["claude-3-5-sonnet"],
    targetModel: "gpt-4o",
    callJudge: mockCaller({ "claude-3-5-sonnet": 75 }),
  });
  assert.equal(r.perJudge.length, 1);
  assert.equal(r.needsHumanReview, true); // 单裁判不可信
});

test("assessJudgePanel computes consistency across items (agreement → reliable)", async () => {
  const judges = ["claude-3-5-sonnet", "gemini-1.5-pro"];
  // 两裁判对每个答案打分接近 → 高一致性
  const caller = async (judge, prompt) => {
    const base = prompt.includes("好答案") ? 90 : 40;
    const jitter = judge === "gemini-1.5-pro" ? 1 : 0;
    return `评分：${base + jitter}`;
  };
  const r = await assessJudgePanel({
    judges,
    targetModel: "gpt-4o",
    items: [
      { question: "Q1", answer: "好答案一" },
      { question: "Q2", answer: "差答案二" },
      { question: "Q3", answer: "好答案三" },
    ],
    callJudge: caller,
  });
  assert.equal(r.items.length, 3);
  assert.ok(r.consistency.alpha !== null);
  assert.equal(r.needsHumanReview, false);
});

test("assessJudgePanel flags review when judges scatter", async () => {
  const judges = ["claude-3-5-sonnet", "gemini-1.5-pro"];
  // 两裁判对同一答案严重分歧 → 低一致性
  const caller = async (judge) => `评分：${judge === "gemini-1.5-pro" ? 10 : 95}`;
  const r = await assessJudgePanel({
    judges,
    targetModel: "gpt-4o",
    items: [
      { question: "Q1", answer: "A1" },
      { question: "Q2", answer: "A2" },
      { question: "Q3", answer: "A3" },
    ],
    callJudge: caller,
  });
  assert.equal(r.needsHumanReview, true);
});
