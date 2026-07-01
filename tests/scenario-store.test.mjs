// tests/scenario-store.test.mjs
// 场景存储（server/scenarios/store.mjs）纯逻辑测试：设置开关纳入、显式 tag 覆盖、upsert/delete 内存效果、
// serializeBank 往返一致。一律 persist:false 或写临时目录，绝不污染 server/scenarios 源码。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getTestScenarios,
  getAllScenariosForAdmin,
  upsertScenario,
  deleteScenario,
  serializeBank,
  resolveScenarioTag,
  resolveScenarioGroup,
  renameScenarioGroup,
  clearScenarioGroup,
  __resetStoreForTest,
  __setScenarioWriteDirForTest,
} from "../server/scenarios/store.mjs";
import { __setSettingsForTest, __resetSettingsCacheForTest } from "../server/settings-store.mjs";

test.afterEach(() => {
  __resetStoreForTest();
  __resetSettingsCacheForTest();
});

test("getTestScenarios：默认仅常开 bank；开关开启后纳入受控 bank", () => {
  __resetSettingsCacheForTest(); // 缓存空 → 全部默认关
  const baseline = getTestScenarios().length;
  assert.ok(baseline > 0);
  assert.equal(getTestScenarios().some((s) => s.category === "safety"), false, "默认不含 safety");

  __setSettingsForTest({ enableSafety: true });
  const withSafety = getTestScenarios();
  assert.equal(withSafety.some((s) => s.category === "safety"), true, "开启后含 safety");
  assert.ok(withSafety.length > baseline, "数量增加");
});

test("getAllScenariosForAdmin：跨 bank 全量、含 prompt/bankKey/active", () => {
  const all = getAllScenariosForAdmin();
  assert.ok(all.length >= 60, "约 69 条");
  const sample = all.find((s) => s.bankKey === "basic");
  assert.ok(sample.prompt, "含 prompt（不脱敏）");
  assert.equal(typeof sample.active, "boolean");
  // safety 默认未启用 → active=false 但仍在全量里
  assert.equal(all.some((s) => s.bankKey === "safety" && s.active === false), true);
});

test("显式 tag 覆盖 resolveScenarioTag", async () => {
  const basic = getAllScenariosForAdmin().find((s) => s.bankKey === "basic");
  const computed = resolveScenarioTag(basic);
  const custom = computed === "自定义甲" ? "自定义乙" : "自定义甲";
  const r = await upsertScenario({ ...basic, tag: custom }, { persist: false });
  assert.equal(r.ok, true);
  const after = getTestScenarios().find((s) => s.id === basic.id);
  assert.equal(after.tag, custom, "显式 tag 生效，覆盖推断");
});

test("upsert：新 id 进 custom bank；已有 id 原地替换", async () => {
  const r1 = await upsertScenario({ id: "store-test-new", name: "新", category: "basic", difficulty: "small", prompt: "hello" }, { persist: false });
  assert.equal(r1.ok, true);
  assert.equal(r1.bankKey, "custom");
  assert.equal(getAllScenariosForAdmin().some((s) => s.id === "store-test-new" && s.bankKey === "custom"), true);

  const existing = getAllScenariosForAdmin().find((s) => s.bankKey === "basic");
  const r2 = await upsertScenario({ ...existing, prompt: "EDITED" }, { persist: false });
  assert.equal(r2.bankKey, "basic", "原 bank 内替换，不进 custom");
  assert.equal(getAllScenariosForAdmin().filter((s) => s.id === existing.id).length, 1, "不重复");
  assert.equal(getAllScenariosForAdmin().find((s) => s.id === existing.id).prompt, "EDITED");
});

test("upsert 校验：缺 id / 空 prompt → ok:false", async () => {
  assert.equal((await upsertScenario({ prompt: "x" }, { persist: false })).ok, false);
  assert.equal((await upsertScenario({ id: "z", prompt: "" }, { persist: false })).ok, false);
});

test("delete：移除场景；不存在 → found:false", async () => {
  await upsertScenario({ id: "store-test-del", category: "basic", difficulty: "small", prompt: "p" }, { persist: false });
  const r = await deleteScenario("store-test-del", { persist: false });
  assert.equal(r.ok, true);
  assert.equal(getAllScenariosForAdmin().some((s) => s.id === "store-test-del"), false);
  assert.equal((await deleteScenario("nope-id", { persist: false })).found, false);
});

test("serializeBank 往返：写临时文件→动态 import→深比对（纯数据安全）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scn-store-"));
  try {
    const arr = [{ id: "rt-1", name: "往返", prompt: "p1", expected: "ans", requiredAny: ["a", "b"] }];
    const file = join(dir, "custom.mjs");
    await writeFile(file, serializeBank("CUSTOM_SCENARIOS", arr), "utf8");
    const mod = await import(`file://${file.replace(/\\/g, "/")}`);
    assert.deepEqual(mod.CUSTOM_SCENARIOS, arr, "导出数组与源数组完全一致");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("upsert persist=true：改写定向到临时目录、源码不动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scn-write-"));
  try {
    __setScenarioWriteDirForTest(dir);
    const r = await upsertScenario({ id: "persist-1", category: "basic", difficulty: "small", prompt: "hi" }, { persist: true });
    assert.equal(r.persisted, true);
    assert.equal(r.persistError, null);
    const mod = await import(`file://${join(dir, "custom.mjs").replace(/\\/g, "/")}`);
    assert.equal(mod.CUSTOM_SCENARIOS.some((s) => s.id === "persist-1"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

// ===================== 分组 =====================

test("分组默认按 bank；显式 group 覆盖；admin/runtime 都带 group", () => {
  assert.equal(resolveScenarioGroup({}, "basic"), "基础");
  assert.equal(resolveScenarioGroup({}, "safety"), "安全红线");
  assert.equal(resolveScenarioGroup({}, "livebench"), "LiveBench");
  assert.equal(resolveScenarioGroup({}, "hle"), "HLE");
  assert.equal(resolveScenarioGroup({}, "hardcore-logic"), "HardcoreLogic");
  assert.equal(resolveScenarioGroup({ group: "我的组" }, "basic"), "我的组", "显式 group 优先");
  // getAllScenariosForAdmin 带 resolvedGroup
  const all = getAllScenariosForAdmin();
  assert.equal(all.find((s) => s.bankKey === "basic").resolvedGroup, "基础");
  assert.equal(all.find((s) => s.bankKey === "safety").resolvedGroup, "安全红线");
  // getTestScenarios 每条带 group
  assert.ok(getTestScenarios().every((s) => typeof s.group === "string" && s.group));
});

test("renameScenarioGroup：级联把「解析==旧名」的题（含派生）置显式 group=新名", async () => {
  const before = getAllScenariosForAdmin().filter((s) => s.resolvedGroup === "基础").length;
  assert.ok(before > 0);
  const r = await renameScenarioGroup("基础", "入门", { persist: false });
  assert.equal(r.ok, true);
  assert.equal(r.changed, before, "改动数=原「基础」组题数");
  const admin = getAllScenariosForAdmin();
  assert.equal(admin.some((s) => s.resolvedGroup === "基础"), false, "不再有解析为「基础」的题");
  assert.ok(admin.filter((s) => s.resolvedGroup === "入门").length >= before);
  // 派生题被 materialize 为显式 group
  assert.equal(admin.find((s) => s.bankKey === "basic").group, "入门");
});

test("clearScenarioGroup：清掉显式 group=该名的题，落回 bank 默认组", async () => {
  const basic = getAllScenariosForAdmin().find((s) => s.bankKey === "basic");
  await upsertScenario({ ...basic, group: "临时组" }, { persist: false });
  assert.equal(getAllScenariosForAdmin().find((s) => s.id === basic.id).resolvedGroup, "临时组");
  const r = await clearScenarioGroup("临时组", { persist: false });
  assert.equal(r.ok, true);
  assert.equal(r.changed, 1);
  assert.equal(getAllScenariosForAdmin().find((s) => s.id === basic.id).resolvedGroup, "基础", "落回 bank 默认");
});

// ===================== 分组：边界与容错 =====================

test("renameScenarioGroup：空名 → ok:false，不改动", async () => {
  assert.equal((await renameScenarioGroup("", "新", { persist: false })).ok, false);
  assert.equal((await renameScenarioGroup("基础", "  ", { persist: false })).ok, false);
});

test("renameScenarioGroup：改不存在的组 → changed:0（无副作用）", async () => {
  const r = await renameScenarioGroup("查无此组", "随便", { persist: false });
  assert.equal(r.ok, true);
  assert.equal(r.changed, 0);
  // 分组格局不变。
  assert.ok(getAllScenariosForAdmin().some((s) => s.resolvedGroup === "基础"));
});

test("renameScenarioGroup：改成已存在的组 → 两组合并（记录既有行为）", async () => {
  const admin0 = getAllScenariosForAdmin();
  const baseCount = admin0.filter((s) => s.resolvedGroup === "基础").length;
  const safetyCount = admin0.filter((s) => s.resolvedGroup === "安全红线").length;
  assert.ok(baseCount > 0 && safetyCount > 0);

  const r = await renameScenarioGroup("基础", "安全红线", { persist: false });
  assert.equal(r.ok, true);
  assert.equal(r.changed, baseCount, "只改动原「基础」组，安全组本已==目标不重复计");

  const admin1 = getAllScenariosForAdmin();
  assert.equal(admin1.some((s) => s.resolvedGroup === "基础"), false, "「基础」组消失");
  assert.equal(admin1.filter((s) => s.resolvedGroup === "安全红线").length, baseCount + safetyCount, "两组并入");
});

test("renameScenarioGroup：改成同名 → 分组解析不变（幂等效果）", async () => {
  const before = getAllScenariosForAdmin().filter((s) => s.resolvedGroup === "基础").map((s) => s.id).sort();
  const r = await renameScenarioGroup("基础", "基础", { persist: false });
  assert.equal(r.ok, true);
  const after = getAllScenariosForAdmin().filter((s) => s.resolvedGroup === "基础").map((s) => s.id).sort();
  assert.deepEqual(after, before, "同名重命名后仍是同一批题解析为「基础」，无题丢失/迁移");
});

test("clearScenarioGroup：空名 → ok:false；清默认派生组名 → changed:0", async () => {
  assert.equal((await clearScenarioGroup("", { persist: false })).ok, false);
  // 「基础」是 bank 默认派生组，成员并无显式 group 字段 → 无可清，changed:0，且分组不变。
  const r = await clearScenarioGroup("基础", { persist: false });
  assert.equal(r.ok, true);
  assert.equal(r.changed, 0);
  assert.ok(getAllScenariosForAdmin().some((s) => s.resolvedGroup === "基础"), "默认组不受影响");
});

// ===================== upsert 校验：prompt 形态 =====================

test("upsert 校验：数组 prompt 合法；空数组/纯空白 → 非法", async () => {
  const base = { id: "prompt-shape", name: "多行", category: "basic", difficulty: "small" };
  assert.equal((await upsertScenario({ ...base, prompt: ["第一行", "第二行"] }, { persist: false })).ok, true, "数组多行 prompt 合法");
  assert.equal((await upsertScenario({ ...base, prompt: [] }, { persist: false })).ok, false, "空数组非法");
  assert.equal((await upsertScenario({ ...base, prompt: "   " }, { persist: false })).ok, false, "纯空白字符串非法");
});

// ===================== 写盘失败容错 =====================

test("upsert persist=true：写盘失败 → ok:true 但 persisted:false + persistError，内存改动仍生效", async () => {
  // 指向不存在的深层目录（rewriteBank 用 writeFile 不建目录）→ 必抛 ENOENT。绝不落真源码。
  __setScenarioWriteDirForTest(join(tmpdir(), "scn-store-nonexistent-xyz", "nested"));
  const r = await upsertScenario({ id: "persist-fail-1", category: "basic", difficulty: "small", prompt: "hi" }, { persist: true });
  assert.equal(r.ok, true, "校验通过仍返回 ok");
  assert.equal(r.persisted, false, "写盘失败");
  assert.ok(r.persistError, "带 persistError 供上层提示");
  // 内存改动不因写盘失败而回滚——运行态立即可见。
  assert.equal(getAllScenariosForAdmin().some((s) => s.id === "persist-fail-1"), true, "内存里仍加入了该场景");
});
