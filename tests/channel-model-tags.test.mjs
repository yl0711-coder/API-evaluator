// tests/channel-model-tags.test.mjs
// 高强度纯函数测试：模型标签三态（黄=未推送 / 橙=已同步 / 灰=本地删待手动删）逻辑。
// 覆盖 replaceTagsFromNewapi（同步覆盖式）、applyNewapiTagsToTarget（导入并集式）、
// unifySameNameTags（同名完全统一）、normalizeModelTarget（保存时状态迁移）。
// 全部纯函数、无 I/O。范式照搬 tests/channel-model.test.mjs。
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNewapiTagsToTarget,
  normalizeModelTarget,
  syncTagsFromNewapi,
  unifySameNameTags,
} from "../server/channel-model.mjs";

// 便捷构造一个模型目标（带三态字段）。
const mkTarget = (over = {}) => ({
  id: "t1",
  channelId: "c1",
  model: "m",
  tags: [],
  pushedTags: [],
  removedTags: [],
  ...over,
});

// ===================== A. syncTagsFromNewapi（同步：橙以 new-api 为准、保留本地明黄）=====================

test("sync：空目标 + incoming → tags/pushedTags 全等 incoming、removed 空、全橙、返回 true", () => {
  const t = mkTarget();
  const changed = syncTagsFromNewapi(t, ["a", "b"]);
  assert.equal(changed, true);
  assert.deepEqual(t.tags, ["a", "b"]);
  assert.deepEqual(t.pushedTags, ["a", "b"], "全部标橙");
  assert.deepEqual(t.removedTags, []);
});

test("sync：incoming 去重/去空白/全角逗号项归一", () => {
  const t = mkTarget();
  syncTagsFromNewapi(t, [" a ", "a", "", "b", "b"]);
  assert.deepEqual(t.tags, ["a", "b"], "去空白+去重保序");
  assert.deepEqual(t.pushedTags, ["a", "b"]);
});

test("sync：橙色多余标签移除、明黄多余标签保留", () => {
  // a=橙(已推送)、orange-x=橙(已推送)、yellow-x=黄(未推送)；incoming 只含 a。
  const t = mkTarget({ tags: ["a", "orange-x", "yellow-x"], pushedTags: ["a", "orange-x"], removedTags: [] });
  syncTagsFromNewapi(t, ["a"]);
  assert.deepEqual(t.tags, ["a", "yellow-x"], "橙色 orange-x 被移除、明黄 yellow-x 保留");
  assert.deepEqual(t.pushedTags, ["a"], "只有 new-api 的 a 为橙；yellow-x 仍为黄");
});

test("sync：保留本地明黄标签（new-api 没有也不丢）", () => {
  const t = mkTarget({ tags: ["keep-yellow"], pushedTags: [], removedTags: [] });
  const changed = syncTagsFromNewapi(t, ["A", "B"]);
  assert.equal(changed, true);
  assert.deepEqual(t.tags, ["A", "B", "keep-yellow"], "new-api 标签在前、本地明黄保留在后");
  assert.deepEqual(t.pushedTags, ["A", "B"], "仅 new-api 标签为橙，keep-yellow 仍为黄");
});

test("sync：旧记录（有 tags 无 pushedTags）按橙处理 → new-api 没有的旧标签被移除", () => {
  const t = { id: "t", channelId: "c", model: "m", tags: ["legacy"] }; // 无 pushedTags
  syncTagsFromNewapi(t, ["A"]);
  assert.deepEqual(t.tags, ["A"], "旧标签视为橙、不在 new-api → 移除");
  assert.deepEqual(t.pushedTags, ["A"]);
});

test("sync：灰名单里的标签若 new-api 仍有 → 复活为橙、灰清空", () => {
  const t = mkTarget({ tags: [], pushedTags: [], removedTags: ["g"] });
  const changed = syncTagsFromNewapi(t, ["g"]);
  assert.equal(changed, true);
  assert.deepEqual(t.tags, ["g"]);
  assert.deepEqual(t.pushedTags, ["g"], "复活为橙");
  assert.deepEqual(t.removedTags, []);
});

test("sync：incoming 为空且本地皆为橙 → 全清空", () => {
  const t = mkTarget({ tags: ["a"], pushedTags: ["a"], removedTags: ["g"] });
  const changed = syncTagsFromNewapi(t, []);
  assert.equal(changed, true);
  assert.deepEqual(t.tags, []);
  assert.deepEqual(t.pushedTags, []);
  assert.deepEqual(t.removedTags, []);
});

test("sync：incoming 为空但有本地明黄 → 明黄保留", () => {
  const t = mkTarget({ tags: ["y"], pushedTags: [], removedTags: [] });
  syncTagsFromNewapi(t, []);
  assert.deepEqual(t.tags, ["y"], "明黄保留");
  assert.deepEqual(t.pushedTags, []);
});

test("sync：状态已一致 → 返回 false 且不动 updatedAt", () => {
  const t = mkTarget({ tags: ["a"], pushedTags: ["a"], removedTags: [], updatedAt: "KEEP" });
  const changed = syncTagsFromNewapi(t, ["a"]);
  assert.equal(changed, false);
  assert.equal(t.updatedAt, "KEEP", "无变化不应刷新 updatedAt");
});

test("sync：tags 与 pushedTags 为独立数组实例（互不影响）", () => {
  const t = mkTarget();
  syncTagsFromNewapi(t, ["a", "b"]);
  assert.notEqual(t.tags, t.pushedTags, "应是两个不同的数组引用");
  t.tags.push("z");
  assert.deepEqual(t.pushedTags, ["a", "b"], "改 tags 不影响 pushedTags");
});

// ===================== B. applyNewapiTagsToTarget（导入=并集式）=====================

test("apply：本地黄标签保留为黄、incoming 并入标橙", () => {
  const t = mkTarget({ tags: ["y"], pushedTags: [], removedTags: [] });
  const changed = applyNewapiTagsToTarget(t, ["a"]);
  assert.equal(changed, true);
  assert.deepEqual(t.tags, ["y", "a"], "并集保序");
  assert.deepEqual(t.pushedTags, ["a"], "y 仍黄、a 标橙");
});

test("apply：黄标签若也在 incoming → 转橙", () => {
  const t = mkTarget({ tags: ["y"], pushedTags: [], removedTags: [] });
  applyNewapiTagsToTarget(t, ["y"]);
  assert.deepEqual(t.tags, ["y"]);
  assert.deepEqual(t.pushedTags, ["y"], "y 由黄转橙");
});

test("apply：灰名单对账 —— incoming 不含该灰标签 → 清灰", () => {
  const t = mkTarget({ tags: ["a"], pushedTags: ["a"], removedTags: ["g"] });
  const changed = applyNewapiTagsToTarget(t, ["a"]);
  assert.equal(changed, true);
  assert.deepEqual(t.removedTags, [], "new-api 已无 g → 清灰");
  assert.deepEqual(t.tags, ["a"]);
});

test("apply：灰标签仍在 incoming → 不复活（保持灰、不进 tags）", () => {
  const t = mkTarget({ tags: ["a"], pushedTags: ["a"], removedTags: ["g"] });
  const changed = applyNewapiTagsToTarget(t, ["a", "g"]);
  assert.equal(changed, false, "无实际变化");
  assert.deepEqual(t.tags, ["a"], "g 不被复活进 tags");
  assert.deepEqual(t.removedTags, ["g"], "g 仍灰");
});

test("apply：旧记录无 pushedTags → 既有标签判为橙 + incoming 标橙", () => {
  const t = { id: "t", channelId: "c", model: "m", tags: ["a"] }; // 无 pushedTags/removedTags
  const changed = applyNewapiTagsToTarget(t, ["b"]);
  assert.equal(changed, true);
  assert.deepEqual(t.tags, ["a", "b"]);
  assert.deepEqual(t.pushedTags, ["a", "b"], "旧 a 视为已推送、b 新并入，皆橙");
});

test("apply：incoming 已全含 → 无变化返回 false", () => {
  const t = mkTarget({ tags: ["a", "b"], pushedTags: ["a", "b"], removedTags: [] });
  const changed = applyNewapiTagsToTarget(t, ["a"]);
  assert.equal(changed, false);
  assert.deepEqual(t.tags, ["a", "b"]);
});

// ===================== C. unifySameNameTags（同名完全统一）=====================

test("unify：同名目标镜像成 canonical 三态、不同名不动、返回 true", () => {
  const targets = [
    mkTarget({ id: "1", model: "m", tags: ["a"], pushedTags: ["a"], removedTags: ["g"] }),
    mkTarget({ id: "2", channelId: "c2", model: "m", tags: ["x"], pushedTags: [], removedTags: [] }),
    mkTarget({ id: "3", channelId: "c3", model: "other", tags: ["z"], pushedTags: [], removedTags: [] }),
  ];
  const changedOthers = unifySameNameTags(targets, targets[0]);
  assert.equal(changedOthers, true);
  assert.deepEqual(targets[1].tags, ["a"]);
  assert.deepEqual(targets[1].pushedTags, ["a"]);
  assert.deepEqual(targets[1].removedTags, ["g"], "三态全镜像");
  assert.deepEqual(targets[2].tags, ["z"], "不同名模型不受影响");
});

test("unify：无其它同名目标 → 返回 false", () => {
  const targets = [mkTarget({ id: "1", model: "solo", tags: ["a"], pushedTags: ["a"] })];
  assert.equal(unifySameNameTags(targets, targets[0]), false);
});

test("unify：同名但已一致 → 返回 false（幂等）", () => {
  const a = mkTarget({ id: "1", model: "m", tags: ["a"], pushedTags: ["a"], removedTags: [] });
  const b = mkTarget({ id: "2", channelId: "c2", model: "m", tags: ["a"], pushedTags: ["a"], removedTags: [] });
  assert.equal(unifySameNameTags([a, b], a), false);
});

test("unify：镜像为独立副本（改 canonical 不影响兄弟）", () => {
  const a = mkTarget({ id: "1", model: "m", tags: ["a"], pushedTags: ["a"], removedTags: [] });
  const b = mkTarget({ id: "2", channelId: "c2", model: "m", tags: ["x"], pushedTags: [], removedTags: [] });
  unifySameNameTags([a, b], a);
  a.tags.push("q");
  assert.deepEqual(b.tags, ["a"], "兄弟标签不应被 canonical 后续改动牵连");
});

// ===================== D. normalizeModelTarget 状态迁移 =====================

test("normalize：新建勾选标签 → 全黄（pushedTags 空）", () => {
  const t = normalizeModelTarget({ channelId: "c", model: "m", tags: ["a", "b"] }, null);
  assert.deepEqual(t.tags, ["a", "b"]);
  assert.deepEqual(t.pushedTags, [], "新增未推送 → 全黄");
  assert.deepEqual(t.removedTags, []);
});

test("normalize：编辑保留已推送标签为橙、新增的为黄", () => {
  const existing = { id: "x", channelId: "c", model: "m", tags: ["a"], pushedTags: ["a"], removedTags: [] };
  const t = normalizeModelTarget({ id: "x", channelId: "c", model: "m", tags: ["a", "c"] }, existing);
  assert.deepEqual(t.tags, ["a", "c"]);
  assert.deepEqual(t.pushedTags, ["a"], "a 仍橙、c 黄");
});

test("normalize：旧记录（有 tags 无 pushedTags）→ 既有标签判为橙", () => {
  const existing = { id: "x", channelId: "c", model: "m", tags: ["a"] };
  const t = normalizeModelTarget({ id: "x", channelId: "c", model: "m", tags: ["a"] }, existing);
  assert.deepEqual(t.pushedTags, ["a"], "旧标签升级后视为已同步（橙）");
});

test("normalize：重勾灰标签 → 出灰、回 tags 且橙", () => {
  const existing = { id: "x", channelId: "c", model: "m", tags: [], pushedTags: [], removedTags: ["g"] };
  const t = normalizeModelTarget({ id: "x", channelId: "c", model: "m", tags: ["g"] }, existing);
  assert.deepEqual(t.tags, ["g"]);
  assert.deepEqual(t.pushedTags, ["g"], "灰标签重勾回来 → 橙");
  assert.deepEqual(t.removedTags, [], "出灰名单");
});

test("normalize：未重勾的灰标签保留；新增的别的标签为黄", () => {
  const existing = { id: "x", channelId: "c", model: "m", tags: [], pushedTags: [], removedTags: ["g"] };
  const t = normalizeModelTarget({ id: "x", channelId: "c", model: "m", tags: ["a"] }, existing);
  assert.deepEqual(t.tags, ["a"]);
  assert.deepEqual(t.pushedTags, [], "a 为新增 → 黄");
  assert.deepEqual(t.removedTags, ["g"], "g 仍灰");
});

test("normalize：编辑未传 tags 时沿用 existing 标签（不被清空）", () => {
  const existing = { id: "x", channelId: "c", model: "m", tags: ["a"], pushedTags: ["a"], removedTags: [] };
  const t = normalizeModelTarget({ id: "x", channelId: "c", model: "m" }, existing);
  assert.deepEqual(t.tags, ["a"], "未传 tags → 保留");
  assert.deepEqual(t.pushedTags, ["a"]);
});
