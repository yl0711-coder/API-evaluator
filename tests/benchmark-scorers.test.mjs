import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHaystack,
  ifevalCheck,
  passAtK,
  scoreBfclToolCall,
  scoreNeedleRetrieval,
} from "../server/benchmark-scorers.mjs";

const approx = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m}: expected ${b}±${tol}, got ${a}`);

// --- BFCL ---
test("scoreBfclToolCall: exact structural match scores 1", () => {
  const r = scoreBfclToolCall(
    { name: "get_weather", arguments: { city: "北京" } },
    { name: "get_weather", arguments: { city: "北京" } },
  );
  assert.equal(r.match, true);
  assert.equal(r.score, 1);
});

test("scoreBfclToolCall: wrong function name scores 0", () => {
  const r = scoreBfclToolCall({ name: "get_weather", arguments: {} }, { name: "get_news", arguments: {} });
  assert.equal(r.nameMatch, false);
  assert.equal(r.score, 0);
});

test("scoreBfclToolCall: missing/extra args are penalized but name match keeps partial credit", () => {
  const missing = scoreBfclToolCall(
    { name: "f", arguments: { a: 1, b: 2 } },
    { name: "f", arguments: { a: 1 } },
  );
  assert.equal(missing.match, false);
  assert.ok(missing.score > 0 && missing.score < 1);
  assert.deepEqual(missing.missingArgs, ["b"]);

  const extra = scoreBfclToolCall({ name: "f", arguments: { a: 1 } }, { name: "f", arguments: { a: 1, z: 9 } });
  assert.deepEqual(extra.extraArgs, ["z"]);
  assert.equal(extra.match, false);
});

test("scoreBfclToolCall: numeric/string value tolerance", () => {
  const r = scoreBfclToolCall({ name: "f", arguments: { n: 3 } }, { name: "f", arguments: { n: "3" } });
  assert.equal(r.match, true); // 3 == "3" 数值容差
});

// --- NIAH / RULER ---
test("buildHaystack inserts the needle and scoreNeedleRetrieval finds it", () => {
  const hay = buildHaystack({ filler: "无关文本", needle: "密钥是 42。", depthRatio: 0.5, repeats: 20 });
  assert.ok(hay.includes("密钥是 42。"));
  assert.ok(hay.length > 50);

  assert.equal(scoreNeedleRetrieval("答案：密钥是 42。", "密钥是 42").score, 1);
  assert.equal(scoreNeedleRetrieval("我不知道", "密钥是 42").score, 0);
});

// --- IFEval ---
test("ifevalCheck verifies multiple instructions and requires all to pass", () => {
  const text = "- 第一点\n- 第二点\n- 第三点";
  const ok = ifevalCheck(text, [
    { type: "exact_bullets", count: 3 },
    { type: "forbidden_keyword", keyword: "抱歉" },
  ]);
  assert.equal(ok.passed, true);
  assert.equal(ok.passRate, 1);

  const bad = ifevalCheck(text, [
    { type: "exact_bullets", count: 5 },
    { type: "include_keyword", keyword: "第一点" },
  ]);
  assert.equal(bad.passed, false);
  assert.equal(bad.passedCount, 1); // include_keyword passes, bullets fail
});

test("ifevalCheck json_only and word/char limits", () => {
  assert.equal(ifevalCheck('{"a":1}', [{ type: "json_only" }]).passed, true);
  assert.equal(ifevalCheck("not json", [{ type: "json_only" }]).passed, false);
  assert.equal(ifevalCheck("one two three", [{ type: "max_words", count: 3 }]).passed, true);
  assert.equal(ifevalCheck("one two three four", [{ type: "max_words", count: 3 }]).passed, false);
  assert.equal(ifevalCheck("a, b", [{ type: "no_commas" }]).passed, false);
});

test("ifevalCheck flags unknown instruction types as failed", () => {
  const r = ifevalCheck("x", [{ type: "made_up_check" }]);
  assert.equal(r.passed, false);
  assert.equal(r.results[0].note, "未知指令类型");
});

// --- pass@k ---
test("passAtK matches Codex unbiased estimator on known cases", () => {
  assert.equal(passAtK(10, 0, 1), 0); // never correct
  assert.equal(passAtK(10, 10, 1), 1); // always correct
  // n=5, c=1, k=1 -> 1/5 = 0.2
  approx(passAtK(5, 1, 1), 0.2, 1e-6, "pass@1");
  // n=5, c=1, k=5 -> n-c<k -> 1
  assert.equal(passAtK(5, 1, 5), 1);
  // n=4, c=2, k=2 -> 1 - C(2,2)/C(4,2) = 1 - 1/6 = 0.8333
  approx(passAtK(4, 2, 2), 0.833333, 1e-5, "pass@2");
});

test("passAtK guards invalid inputs", () => {
  assert.equal(passAtK(0, 0, 1), null);
  assert.equal(passAtK(5, 6, 1), null); // c>n
  assert.equal(passAtK(5, 2, 0), null);
});
