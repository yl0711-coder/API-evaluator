import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHaystack,
  ifevalCheck,
  passAtK,
  scoreBfclToolCall,
  scoreExactAnswer,
  scoreNeedleRetrieval,
  scoreSetMatch,
  scoreStructuredMatch,
  scoreTableReformat,
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

// --- LiveBench: scoreExactAnswer ---
test("scoreExactAnswer extracts boxed/marker/last-line answers", () => {
  assert.equal(scoreExactAnswer("推理...\\boxed{42}", "42").passed, true);
  assert.equal(scoreExactAnswer("一通分析。最终答案：北京", "北京").passed, true);
  assert.equal(scoreExactAnswer("Reasoning here.\nThe answer is 7", "7").passed, true);
  assert.equal(scoreExactAnswer("blah\nblah\n结论是这样", "结论是这样").passed, true);
});

test("scoreExactAnswer unwraps LiveBench <solution></solution> tags", () => {
  const out = "Chef is position 2...\n<solution>architect, skiing, musical, 2</solution>";
  assert.equal(scoreExactAnswer(out, "architect, skiing, musical, 2").passed, true);
  assert.equal(scoreExactAnswer(out, "chef, skiing, musical, 1").passed, false);
  // 取最后一处，忽略题面里的示例标签
  const withExample = "示例：<solution>a, b</solution>\n推理...\n<solution>c, d</solution>";
  assert.equal(scoreExactAnswer(withExample, "c, d").passed, true);
});

test("scoreExactAnswer strips a leading Answer label inside <solution> (奥赛填空)", () => {
  // 题面要求 "Answer: <...>"，模型把整行（含标签）塞进 <solution>，期望只比逗号序列
  assert.equal(scoreExactAnswer("<solution>Answer: 4, 1, 2, 3</solution>", "4,1,2,3").passed, true);
  assert.equal(scoreExactAnswer("<solution>Answer is 4,1,2,3</solution>", "4,1,2,3").passed, true);
  assert.equal(scoreExactAnswer("<solution>The answer is 4, 1, 2, 3.</solution>", "4,1,2,3").passed, true);
  assert.equal(scoreExactAnswer("<solution>答案：1,6,7,2,3,4,5</solution>", "1,6,7,2,3,4,5").passed, true);
  // 不误伤：内含 "answer" 子串的普通答案、纯字母答案
  assert.equal(scoreExactAnswer("<solution>answered the call</solution>", "answered the call").passed, true);
  assert.equal(scoreExactAnswer("<solution>B</solution>", "B").passed, true);
  // 错误答案仍判错
  assert.equal(scoreExactAnswer("<solution>Answer: 9, 9</solution>", "1,2").passed, false);
});

test("scoreExactAnswer normalizes width/case/punctuation and numbers", () => {
  assert.equal(scoreExactAnswer("答案：４２。", "42").passed, true); // 全角 + 句号
  assert.equal(scoreExactAnswer("ANSWER: Hello", "hello").passed, true); // 大小写
  assert.equal(scoreExactAnswer("答案是 1,000", "1000").passed, true); // 千分位
  assert.equal(scoreExactAnswer("答案：3.0", "3", { numeric: true }).passed, true);
  const tol = scoreExactAnswer("答案：3.14", "3.1416", { numeric: true, tolerance: 0.01 });
  assert.equal(tol.passed, true);
});

test("scoreExactAnswer accepts an array of acceptable answers and rejects wrong ones", () => {
  assert.equal(scoreExactAnswer("答案：yes", ["yes", "是", "正确"]).passed, true);
  const wrong = scoreExactAnswer("答案：完全不同", "正确答案");
  assert.equal(wrong.passed, false);
  assert.equal(wrong.score, 0);
  assert.ok(wrong.issues.length > 0);
});

// --- LiveBench: scoreStructuredMatch ---
test("scoreStructuredMatch deep-compares JSON with partial credit", () => {
  const expected = { name: "a", values: [1, 2, 3] };
  const full = scoreStructuredMatch('{"name":"a","values":[1,2,3]}', expected);
  assert.equal(full.passed, true);
  assert.equal(full.score, 1);

  // key order irrelevant; numeric tolerance ("3" == 3)
  const reordered = scoreStructuredMatch('{"values":[1,2,"3"],"name":"a"}', expected);
  assert.equal(reordered.passed, true);

  const partial = scoreStructuredMatch('{"name":"a","values":[1,2,9]}', expected);
  assert.equal(partial.passed, false);
  assert.ok(partial.score > 0 && partial.score < 1);
});

test("scoreStructuredMatch handles JSONL (one object per line, e.g. table reformat)", () => {
  const expected = '{"id":1,"v":"a"}\n{"id":2,"v":"b"}';
  const ok = scoreStructuredMatch('{"id":1,"v":"a"}\n{"id":2,"v":"b"}', expected);
  assert.equal(ok.passed, true);
  assert.equal(ok.score, 1);
  const bad = scoreStructuredMatch('{"id":1,"v":"a"}\n{"id":2,"v":"X"}', expected);
  assert.equal(bad.passed, false);
});

test("scoreStructuredMatch flags extra fields and unparseable output", () => {
  const extra = scoreStructuredMatch('{"a":1,"b":2}', { a: 1 });
  assert.equal(extra.passed, false); // 多余字段 b
  const bad = scoreStructuredMatch("这不是 JSON", { a: 1 });
  assert.equal(bad.passed, false);
  assert.equal(bad.score, 0);
});

// --- LiveBench: scoreTableReformat（表格重排：忽略不可复现的行号键、列名容差、行序无关）---
test("scoreTableReformat ignores non-reproducible row-index keys (orient=index)", () => {
  // ground truth 以原始 dataframe 行号为顶层键（题面不展示，模型无从复现）
  const expected = '{"69":{"a":1,"b":2},"88":{"a":3,"b":4}}';
  // 模型按行对象数组输出（records）——没有行号，应判过
  const asArray = scoreTableReformat('[{"a":1,"b":2},{"a":3,"b":4}]', expected);
  assert.equal(asArray.passed, true);
  assert.equal(asArray.score, 1);
  // 模型用顺序行号（0/1）输出，也应判过
  assert.equal(scoreTableReformat('{"0":{"a":1,"b":2},"1":{"a":3,"b":4}}', expected).passed, true);
  // 行序无关
  assert.equal(scoreTableReformat('[{"a":3,"b":4},{"a":1,"b":2}]', expected).passed, true);
});

test("scoreTableReformat tolerates trailing-space column names; catches real errors", () => {
  // TSV 表头带尾空格 "Accident "，模型自然 trim 成 "Accident"——应判过
  const expected = '{"Calendar Year":2008,"Accident ":506.0}\n{"Calendar Year":1988,"Accident ":1080.0}';
  assert.equal(scoreTableReformat('{"Calendar Year":2008,"Accident":506}\n{"Calendar Year":1988,"Accident":1080}', expected).passed, true);
  // 少一行 / 错值 / 缺列 应判错
  assert.equal(scoreTableReformat('{"Calendar Year":2008,"Accident":506}', expected).passed, false);
  assert.equal(scoreTableReformat('{"Calendar Year":2008,"Accident":999}\n{"Calendar Year":1988,"Accident":1080}', expected).passed, false);
  assert.equal(scoreTableReformat('{"Calendar Year":2008}\n{"Calendar Year":1988}', expected).passed, false);
});

// --- LiveBench: scoreSetMatch ---
test("scoreSetMatch requires all expected members, with partial score", () => {
  const all = scoreSetMatch("苹果、香蕉、橙子", ["苹果", "香蕉", "橙子"]);
  assert.equal(all.passed, true);
  assert.equal(all.score, 1);

  const some = scoreSetMatch("苹果, 香蕉", ["苹果", "香蕉", "橙子"]);
  assert.equal(some.passed, false);
  approx(some.score, 2 / 3, 1e-3, "set partial"); // 判分器保留 3 位小数
  assert.ok(some.issues.length > 0);
});
