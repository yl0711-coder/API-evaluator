import assert from "node:assert/strict";
import test from "node:test";

import {
  charsPerToken,
  countCharClasses,
  estimateTokens,
  fingerprintTokenizer,
  observeFamilyCpt,
} from "../server/tokenizer-fingerprint.mjs";

test("countCharClasses splits CJK / ascii / whitespace / punct", () => {
  const c = countCharClasses("你好 world!");
  assert.equal(c.cjk, 2);
  assert.equal(c.ascii, 5); // w o r l d
  assert.equal(c.whitespace, 1);
  assert.equal(c.punct, 1); // !
});

test("estimateTokens grows with length and is higher per-char for CJK than English", () => {
  const english = estimateTokens("the quick brown fox jumps over the lazy dog");
  const cjk = estimateTokens("你好世界这是一段中文文本用于估算");
  assert.ok(english > 0);
  assert.ok(cjk > 0);
  // 13 CJK chars at ~1 token/char should exceed ~43 English chars at ~4 chars/token
  assert.ok(cjk > english / 2, "CJK should not be drastically under-estimated");
  assert.equal(estimateTokens(""), 0);
});

test("charsPerToken guards against zero/invalid token counts", () => {
  assert.equal(charsPerToken("hello", 0), null);
  assert.equal(charsPerToken("hello", null), null);
  assert.equal(charsPerToken("", 5), null);
  assert.equal(charsPerToken("hello", 5), 1);
});

test("fingerprintTokenizer flags grossly inflated token counts", () => {
  const text = "the quick brown fox"; // ~5 estimated tokens
  const r = fingerprintTokenizer({ text, reportedTokens: 500 });
  assert.equal(r.plausibility, "疑似计数偏高");
  assert.ok(r.ratio > 2.5);
  assert.match(r.note, /灌水|多计|审计/);
});

test("fingerprintTokenizer flags grossly deflated token counts", () => {
  const text = "你好世界这是一段比较长的中文文本用来测试少计的情况和缓存命中";
  const r = fingerprintTokenizer({ text, reportedTokens: 1 });
  assert.equal(r.plausibility, "疑似计数偏低");
  assert.ok(r.ratio < 0.4);
});

test("fingerprintTokenizer accepts plausible counts without crying fraud", () => {
  const text = "the quick brown fox jumps over the lazy dog"; // ~11 est tokens
  const r = fingerprintTokenizer({ text, reportedTokens: 10, declaredModel: "gpt-4o" });
  assert.equal(r.plausibility, "计数合理范围（粗筛）");
  assert.equal(r.declaredFamily, "openai");
  assert.equal(r.confidence, "low"); // 永远低置信，粗筛
});

test("fingerprintTokenizer is honest when data is missing", () => {
  const r = fingerprintTokenizer({ text: "hello", reportedTokens: null });
  assert.equal(r.plausibility, "无法判断");
  assert.deepEqual(r.suspectedFamilies, []);
});

test("observeFamilyCpt computes calibration observation without inventing data", () => {
  const obs = observeFamilyCpt({ family: "claude-3-5-sonnet", text: "hello world", tokens: 3 });
  assert.equal(obs.family, "claude");
  approxEqual(obs.charsPerToken, 11 / 3, 1e-9);
  assert.equal(obs.observedAt, null); // 不臆造时间戳
});

function approxEqual(actual, expected, tol) {
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected} ± ${tol}, got ${actual}`);
}
