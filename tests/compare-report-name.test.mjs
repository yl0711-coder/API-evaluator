// tests/compare-report-name.test.mjs
// 「模型对比报告」文件名反解析（server/report-compare.mjs 的 parseCompareReportBaseName +
// buildSubjectSlugIndex）。这条链路是「多模型比对」找出「谁和谁比过」的唯一依据——
// 比对历史没有库表，只隐式存在于文件名 `${slugA}_vs_${slugB}_compare_${date}_${time}_${hash}` 里。
//
// 为什么不能简单 split("_vs_")：渠道名/模型名本身可以含下划线，甚至可以含 `_vs_` 子串
// （渠道就叫「a_vs_b」）。所以解析器只负责列出【所有】可能的切分点，由 slug 索引判定
// 「哪个切分能让两侧都命中已知模型」。本测试把这两件事分别钉住，并覆盖那些边界名字。
import assert from "node:assert/strict";
import test from "node:test";

import { parseCompareReportBaseName, buildSubjectSlugIndex } from "../server/report-compare.mjs";
import { sanitizeReportBaseName } from "../server/report-files.mjs";

// 索引里挑出「两侧都能解析」的第一个切分——与 server.mjs handleReportsComparePeers 同一判定，
// 在此复刻一份最小实现，用来验证「解析器 + 索引」合起来能选对切分点。
function resolve(base, index) {
  const parsed = parseCompareReportBaseName(base);
  if (!parsed) return null;
  for (const [slugA, slugB] of parsed.splits) {
    const a = index.get(slugA);
    const b = index.get(slugB);
    if (a && b) return { a, b, slugA, slugB };
  }
  return null;
}

test("常规对比报告名：切出两侧 slug、日期与时刻", () => {
  const p = parseCompareReportBaseName("test_claude-opus-4-8_vs_Claude-1.3x_claude-opus-4-8_compare_20260807_141205_04b7");
  assert.ok(p, "应能解析");
  assert.equal(p.type, "compare");
  assert.equal(p.date, "20260807");
  assert.equal(p.time, "141205");
  assert.equal(p.hash, "04b7");
  assert.deepEqual(p.splits, [["test_claude-opus-4-8", "Claude-1.3x_claude-opus-4-8"]]);
});

test("扩展名（.md / .html）被剥掉，不影响解析", () => {
  for (const ext of [".md", ".html", ".MD"]) {
    const p = parseCompareReportBaseName(`a_m1_vs_b_m2_compare_20260807_141205_ab12${ext}`);
    assert.ok(p, `带 ${ext} 应能解析`);
    assert.equal(p.date, "20260807");
  }
});

test("可选短 hash 缺失时仍能解析", () => {
  const p = parseCompareReportBaseName("a_m1_vs_b_m2_compare_20260807_141205");
  assert.ok(p, "无 hash 应能解析");
  assert.equal(p.hash, null);
});

test("非对比报告名一律返回 null（不与单对象报告混淆）", () => {
  const notCompare = [
    "test_claude-opus-4-8_run_20260701", // 单对象稳定性报告
    "test_claude-opus-4-8_scenario_20260701_101803_78bf",
    "a_vs_b_compare_20260807", // 缺时刻
    "a_vs_b_compare_2026087_141205", // 日期位数不对
    "a_m1_b_m2_compare_20260807_141205_ab12", // 没有 _vs_ 分隔
    "compare_20260807_141205_ab12", // 没有 head
    "",
    null,
  ];
  for (const name of notCompare) {
    assert.equal(parseCompareReportBaseName(name), null, `「${name}」不该被当成对比报告名`);
  }
});

test("渠道名含下划线：靠 slug 索引选对切分点", () => {
  // 渠道「my_relay」+ 模型「gpt_4o」——两边 slug 里都有下划线，但只有一个 _vs_，切分唯一。
  const subjects = [
    { targetId: "t1", channel: "my_relay", model: "gpt_4o" },
    { targetId: "t2", channel: "other_relay", model: "claude_3_7" },
  ];
  const index = buildSubjectSlugIndex(subjects, sanitizeReportBaseName);
  const hit = resolve("my_relay_gpt_4o_vs_other_relay_claude_3_7_compare_20260807_141205_ab12", index);
  assert.ok(hit, "应能解析出两侧");
  assert.equal(hit.a.targetId, "t1");
  assert.equal(hit.b.targetId, "t2");
});

test("渠道名本身含 `_vs_` 子串：列出全部候选切分，索引挑出正确的那个", () => {
  // 渠道就叫「a_vs_b」。文件名里于是出现两个 `_vs_`，只有第二个是真正的分隔符。
  const subjects = [
    { targetId: "t1", channel: "a_vs_b", model: "model1" },
    { targetId: "t2", channel: "c", model: "model2" },
  ];
  const index = buildSubjectSlugIndex(subjects, sanitizeReportBaseName);
  const base = "a_vs_b_model1_vs_c_model2_compare_20260807_141205_ab12";

  const parsed = parseCompareReportBaseName(base);
  assert.equal(parsed.splits.length, 2, "两个 `_vs_` → 两个候选切分点");
  assert.deepEqual(parsed.splits[0], ["a", "b_model1_vs_c_model2"], "第一个候选（错的）也要列出来");
  assert.deepEqual(parsed.splits[1], ["a_vs_b_model1", "c_model2"], "第二个候选才是对的");

  const hit = resolve(base, index);
  assert.ok(hit, "索引应能挑出正确切分");
  assert.equal(hit.a.targetId, "t1", "左侧应是渠道名含 _vs_ 的那个模型");
  assert.equal(hit.b.targetId, "t2");
  assert.equal(hit.slugA, "a_vs_b_model1");
});

test("渠道名含 `_compare_` 子串：尾部锚定，head 仍完整", () => {
  const subjects = [
    { targetId: "t1", channel: "x_compare_y", model: "m1" },
    { targetId: "t2", channel: "z", model: "m2" },
  ];
  const index = buildSubjectSlugIndex(subjects, sanitizeReportBaseName);
  const p = parseCompareReportBaseName("x_compare_y_m1_vs_z_m2_compare_20260807_141205_ab12");
  assert.ok(p, "应能解析");
  assert.equal(p.head, "x_compare_y_m1_vs_z_m2", "head 不得被 head 里的 `_compare_` 提前截断");
  const hit = resolve("x_compare_y_m1_vs_z_m2_compare_20260807_141205_ab12", index);
  assert.equal(hit?.a?.targetId, "t1");
  assert.equal(hit?.b?.targetId, "t2");
});

test("两侧都解析不出（模型已删）→ resolve 返回 null，供上层记入 unresolved", () => {
  const index = buildSubjectSlugIndex([{ targetId: "t1", channel: "known", model: "m" }], sanitizeReportBaseName);
  assert.equal(resolve("gone_a_vs_gone_b_compare_20260807_141205_ab12", index), null);
});

test("buildSubjectSlugIndex 收录曾用名，且现用名优先于别人的曾用名", () => {
  // 关键冲突：t2 的现用名 slug 恰好等于 t1 的曾用名 slug。改名后的历史报告归属必须给现用名。
  const subjects = [
    { targetId: "t1", channel: "new-relay", model: "m", channelAliases: ["old-relay"], modelAliases: [] },
    { targetId: "t2", channel: "old-relay", model: "m" },
  ];
  const index = buildSubjectSlugIndex(subjects, sanitizeReportBaseName);
  assert.equal(index.get(sanitizeReportBaseName("new-relay_m")).targetId, "t1");
  assert.equal(index.get(sanitizeReportBaseName("old-relay_m")).targetId, "t2", "现用名必须压过别人的曾用名");
});

test("buildSubjectSlugIndex 用曾用名认领改名前的历史报告", () => {
  const subjects = [
    { targetId: "t1", channel: "renamed", model: "m1", channelAliases: ["was-called-this"] },
    { targetId: "t2", channel: "peer", model: "m2", modelAliases: ["m2-old"] },
  ];
  const index = buildSubjectSlugIndex(subjects, sanitizeReportBaseName);
  // 报告是改名前生成的：两侧都是曾用名。
  const hit = resolve("was-called-this_m1_vs_peer_m2-old_compare_20260801_120000_aaaa", index);
  assert.ok(hit, "改名前的历史报告应仍能被现在的模型认领");
  assert.equal(hit.a.targetId, "t1");
  assert.equal(hit.b.targetId, "t2");
});

test("空/缺字段的 subject 不进索引（不产生 `undefined_undefined` 这类垃圾 slug）", () => {
  const index = buildSubjectSlugIndex([{ targetId: "t1", channel: "", model: "m" }, { targetId: "t2" }, null], sanitizeReportBaseName);
  assert.equal(index.size, 0);
});
