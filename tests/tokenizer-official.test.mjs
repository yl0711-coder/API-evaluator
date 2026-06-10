import assert from "node:assert/strict";
import test from "node:test";

import { resolveOpenAiEncoding, countExactTokens, getModelEncodingInfo } from "../server/tokenizer-official.mjs";
import { auditAbsoluteTokens } from "../server/token-auditor.mjs";

test("resolveOpenAiEncoding 把模型名映射到正确编码", () => {
  assert.equal(resolveOpenAiEncoding("gpt-4o"), "o200k_base");
  assert.equal(resolveOpenAiEncoding("gpt-4o-mini"), "o200k_base");
  assert.equal(resolveOpenAiEncoding("o3-mini"), "o200k_base");
  assert.equal(resolveOpenAiEncoding("gpt-5"), "o200k_base");
  assert.equal(resolveOpenAiEncoding("gpt-5-codex"), "o200k_base");
  assert.equal(resolveOpenAiEncoding("codex-mini-latest"), "o200k_base");
  assert.equal(resolveOpenAiEncoding("gpt-4-turbo"), "cl100k_base");
  assert.equal(resolveOpenAiEncoding("gpt-3.5-turbo"), "cl100k_base");
  assert.equal(resolveOpenAiEncoding("claude-sonnet-4-5"), null); // 非 OpenAI → null（回退）
  assert.equal(resolveOpenAiEncoding(""), null);
  assert.equal(getModelEncodingInfo("gpt-4o").supported, true);
  assert.equal(getModelEncodingInfo("claude-x").supported, false);
});

test("EVALUATOR_OFFLINE_TOKENIZER=off 一键关闭（内存紧张机器回退横向对照）", async () => {
  process.env.EVALUATOR_OFFLINE_TOKENIZER = "off";
  try {
    assert.equal(resolveOpenAiEncoding("gpt-4o"), null); // 关闭后即使 OpenAI 也不走官方分词器
    assert.equal(await countExactTokens("hello", "gpt-4o"), null);
    const r = await auditAbsoluteTokens({ probes: [{ id: "a", text: "x", reportedTokens: 10 }, { id: "b", text: "yy", reportedTokens: 20 }], model: "gpt-4o" });
    assert.equal(r.applicable, false);
  } finally {
    delete process.env.EVALUATOR_OFFLINE_TOKENIZER;
  }
});

test("countExactTokens 给出精确正整数；不同文本不同；非 OpenAI 返回 null", async () => {
  const short = await countExactTokens("hello", "gpt-4o");
  const long = await countExactTokens("hello world, this is a longer tokenizer test string", "gpt-4o");
  assert.ok(Number.isInteger(short) && short > 0);
  assert.ok(long > short);
  assert.equal(await countExactTokens("anything", "claude-sonnet"), null);
});

test("auditAbsoluteTokens：诚实计费（reported=exact+固定开销）→ slope≈1，无虚报", async () => {
  const texts = {
    a: "short probe",
    b: "a somewhat longer probe with more words to tokenize",
    c: "an even longer probe: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod",
    d: "the longest probe here repeats words words words words words words words words words words",
  };
  const OVERHEAD = 7;
  const probes = [];
  for (const [id, text] of Object.entries(texts)) {
    const exact = await countExactTokens(text, "gpt-4o");
    probes.push({ id, text, reportedTokens: exact + OVERHEAD }); // 诚实：仅加固定模板开销
  }
  const r = await auditAbsoluteTokens({ probes, model: "gpt-4o" });
  assert.equal(r.applicable, true);
  assert.equal(r.encoding, "o200k_base");
  assert.ok(Math.abs(r.slope - 1) < 0.06, `slope=${r.slope}`);
  assert.equal(r.status, "consistent");
  assert.ok(r.intercept >= 5 && r.intercept <= 9, `intercept=${r.intercept}`);
});

test("auditAbsoluteTokens：比例性灌水（reported=exact×1.3+开销）→ 量化虚报≈30%", async () => {
  const texts = {
    a: "short probe",
    b: "a somewhat longer probe with more words to tokenize",
    c: "an even longer probe: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod",
    d: "the longest probe here repeats words words words words words words words words words words",
  };
  const probes = [];
  for (const [id, text] of Object.entries(texts)) {
    const exact = await countExactTokens(text, "gpt-4o");
    probes.push({ id, text, reportedTokens: Math.round(exact * 1.3) + 6 });
  }
  const r = await auditAbsoluteTokens({ probes, model: "gpt-4o" });
  assert.equal(r.status, "inflation");
  assert.ok(r.estimatedInflationPct >= 25 && r.estimatedInflationPct <= 35, `pct=${r.estimatedInflationPct}`);
  assert.ok(r.flags.some((f) => f.code === "absolute_token_inflation"));
});

test("auditAbsoluteTokens：非 OpenAI 模型 → applicable:false（回退）", async () => {
  const r = await auditAbsoluteTokens({ probes: [{ id: "a", text: "x", reportedTokens: 10 }], model: "claude-sonnet-4-5" });
  assert.equal(r.applicable, false);
  assert.equal(r.reason, "no_official_tokenizer");
});

test("auditAbsoluteTokens：点数不足 → applicable:false", async () => {
  const r = await auditAbsoluteTokens({ probes: [{ id: "a", text: "hello", reportedTokens: 10 }], model: "gpt-4o" });
  assert.equal(r.applicable, false);
  assert.equal(r.reason, "insufficient_points");
});
