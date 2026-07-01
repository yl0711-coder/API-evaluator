// tests/scenario-grouping.test.mjs
// 场景分组筛选纯逻辑（src/scenario-grouping.js）：去重分组、按组筛选、筛选保值、
// 全选/清空范围（防误勾隐藏分组）、跨组已选。
import assert from "node:assert/strict";
import test from "node:test";

import {
  distinctGroups,
  filterRowsByGroup,
  resolveGroupFilterValue,
  visibleSelectableIds,
  selectedRows,
} from "../src/scenario-grouping.js";

// 模拟 picker 从隐藏 select 读出的 rows：基础组两条、HLE 组一条、无分组一条。
const rows = () => [
  { id: "b1", name: "基础一", group: "基础", selected: false },
  { id: "b2", name: "基础二", group: "基础", selected: true },
  { id: "h1", name: "HLE 难题", group: "HLE", selected: false },
  { id: "x1", name: "散题", group: "", selected: false }, // 无分组
];

test("distinctGroups：去重、保序、丢空串/假值", () => {
  assert.deepEqual(distinctGroups(rows()), ["基础", "HLE"]);
  assert.deepEqual(distinctGroups([{ group: "a" }, { group: "a" }, { group: "" }, {}, { group: "b" }]), ["a", "b"]);
  assert.deepEqual(distinctGroups([]), []);
  assert.deepEqual(distinctGroups(undefined), []);
});

test("filterRowsByGroup：空＝全部；命中组＝子集；不存在组＝空", () => {
  const all = rows();
  assert.deepEqual(filterRowsByGroup(all, ""), all, "空 → 不筛");
  assert.deepEqual(filterRowsByGroup(all, "基础").map((r) => r.id), ["b1", "b2"]);
  assert.deepEqual(filterRowsByGroup(all, "HLE").map((r) => r.id), ["h1"]);
  assert.deepEqual(filterRowsByGroup(all, "不存在"), [], "无命中");
  assert.deepEqual(filterRowsByGroup(undefined, "基础"), []);
});

test("resolveGroupFilterValue：当前值仍在→保留；已消失→回落全部分组", () => {
  assert.equal(resolveGroupFilterValue(["基础", "HLE"], "HLE"), "HLE", "仍在则保留");
  assert.equal(resolveGroupFilterValue(["基础"], "HLE"), "", "消失则回落 ''");
  assert.equal(resolveGroupFilterValue(["基础"], ""), "", "本就全部");
  assert.equal(resolveGroupFilterValue([], "基础"), "", "无分组时回落");
});

test("visibleSelectableIds：全选/清空只作用于当前可见分组——绝不波及隐藏分组", () => {
  const all = rows();
  // 关键防呆：筛到「基础」时，全选范围只含基础的 id，绝不含昂贵的 HLE(h1)。
  const basicIds = visibleSelectableIds(all, "基础");
  assert.deepEqual([...basicIds].sort(), ["b1", "b2"].sort());
  assert.equal(basicIds.has("h1"), false, "全选『基础』绝不能勾上 HLE");
  assert.equal(basicIds.has("x1"), false, "也不能勾上无分组散题");

  // 「全部分组」下全选＝所有 id。
  assert.deepEqual([...visibleSelectableIds(all, "")].sort(), ["b1", "b2", "h1", "x1"].sort());
  // 空组 → 空集合（对应「暂无测试场景」时全选无副作用）。
  assert.equal(visibleSelectableIds(all, "不存在").size, 0);
});

test("selectedRows：跨分组返回全部已选（不受当前筛选影响，对齐 chips 语义）", () => {
  const all = rows();
  all[2].selected = true; // 再选中 HLE 的 h1（与已选的 b2 不同组）
  const sel = selectedRows(all);
  assert.deepEqual(sel.map((r) => r.id).sort(), ["b2", "h1"].sort(), "chips 显示跨组全部已选");
  assert.deepEqual(selectedRows(rows()).map((r) => r.id), ["b2"], "默认仅 b2 已选");
  assert.deepEqual(selectedRows([]), []);
});
