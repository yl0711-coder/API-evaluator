import assert from "node:assert/strict";
import test from "node:test";

import { auditRunTokenUsage, auditTokenUsage } from "../server/token-auditor.mjs";

const longOutput = "这是一段大约几十个字的中文回答，用来产生一个非零的本地估算 token 数，方便对照上游报告。";

test("auditTokenUsage flags grossly inflated output tokens as high suspicion", () => {
  const r = auditTokenUsage({
    inputText: "你好",
    outputText: "好的",
    usage: { inputTokens: 5, outputTokens: 5000 },
  });
  assert.equal(r.suspicious, true);
  const flag = r.flags.find((f) => f.code === "output_inflated");
  assert.ok(flag);
  assert.equal(flag.level, "high");
  assert.equal(r.confidence, "low"); // 永远低置信，粗筛
});

test("auditTokenUsage stays quiet on plausible counts", () => {
  const estimateLike = auditTokenUsage({ inputText: longOutput, outputText: longOutput, usage: {} }).estimatedOutput;
  const r = auditTokenUsage({
    inputText: longOutput,
    outputText: longOutput,
    usage: { inputTokens: estimateLike, outputTokens: estimateLike },
  });
  assert.equal(r.suspicious, false);
  assert.equal(r.flags.length, 0);
});

test("auditTokenUsage flags undercount (low level)", () => {
  const r = auditTokenUsage({ inputText: longOutput, outputText: longOutput, usage: { outputTokens: 1 } });
  const flag = r.flags.find((f) => f.code === "output_undercount");
  assert.ok(flag);
  assert.equal(flag.level, "low");
});

test("auditTokenUsage flags disproportionate reasoning tokens", () => {
  const r = auditTokenUsage({
    inputText: longOutput,
    outputText: longOutput,
    usage: { outputTokens: 20, reasoningTokens: 500 },
  });
  assert.ok(r.flags.some((f) => f.code === "reasoning_disproportionate"));
});

test("auditRunTokenUsage detects systematic inflation across a run", () => {
  // 每条都把输出 token 报成估算的好几倍 → 聚合比值高
  const samples = Array.from({ length: 8 }, () => ({
    inputText: "短输入",
    outputText: longOutput,
    usage: { inputTokens: 10, outputTokens: 3000 },
  }));
  const r = auditRunTokenUsage(samples);
  assert.equal(r.suspicious, true);
  assert.ok(r.outputRatio > 1.6);
  assert.ok(r.flags.some((f) => f.code === "systematic_output_inflation"));
  assert.match(r.verdict, /疑似/);
});

test("auditRunTokenUsage stays quiet when reported ~ estimated", () => {
  const samples = Array.from({ length: 8 }, () => {
    const est = auditTokenUsage({ outputText: longOutput, usage: {} }).estimatedOutput;
    return { inputText: longOutput, outputText: longOutput, usage: { inputTokens: est, outputTokens: est } };
  });
  const r = auditRunTokenUsage(samples);
  assert.equal(r.suspicious, false);
  assert.match(r.verdict, /合理范围/);
});

test("auditRunTokenUsage reports insufficient sample on empty input", () => {
  const r = auditRunTokenUsage([]);
  assert.equal(r.n, 0);
  assert.equal(r.suspicious, false);
  assert.equal(r.verdict, "样本不足");
});

test("auditRunTokenUsage does not dilute output ratio with input-only samples", () => {
  // 1 条只报 input（无 output），其余正常报 output。旧实现会把这条的整段输出估算
  // 计入 estOut、reported 计 0，把 outputRatio 拉低、误触 undercount。
  const matched = auditTokenUsage({ outputText: longOutput, usage: {} }).estimatedOutput;
  const samples = [
    { inputText: longOutput, usage: { inputTokens: 5 } }, // 只有 input，无 output
    ...Array.from({ length: 6 }, () => ({
      inputText: "短输入",
      outputText: longOutput,
      usage: { inputTokens: 5, outputTokens: matched },
    })),
  ];
  const r = auditRunTokenUsage(samples);
  assert.equal(r.n, 7);
  assert.equal(r.outputSamples, 6); // 只统计真正报了 output 的样本
  assert.equal(r.inputSamples, 7);
  assert.ok(Math.abs(r.outputRatio - 1) < 0.2, `outputRatio 应≈1，实际 ${r.outputRatio}`);
  assert.ok(!r.flags.some((f) => f.code === "systematic_output_undercount"), "不应误报少计");
});
