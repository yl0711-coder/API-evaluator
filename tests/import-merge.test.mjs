// tests/import-merge.test.mjs
// 重新导入时的三方合并（server/import-merge.mjs）。
//
// 钉住的核心行为：产品在渠道 notes 里建议「若测试报 404 请把协议改为 OpenAI Compatible」，
// 用户照做之后再次导入，那个修正【不能】被静默推翻。原实现是 {...prev, ...mapped} 全量覆盖，
// 用户的协议修正、改的名字、手加的模型会一起消失，而 summary 只说「更新 N 个」。
import assert from "node:assert/strict";
import test from "node:test";

import {
  MERGED_SCALAR_FIELDS,
  annotatePreservedProtocol,
  finalizeImportedNotes,
  importSnapshotOf,
  isUsableSnapshot,
  mergeImportedChannel,
  mergeModels,
  mergeScalar,
} from "../server/import-merge.mjs";
import { importedChannelName, normalizeChannel } from "../server/channel-model.mjs";

test("mergeScalar：用户没动过 → 跟随上游改名", () => {
  const r = mergeScalar({ upstream: "新名字", prev: "老名字", snapshot: "老名字", hasSnapshot: true });
  assert.equal(r.value, "新名字");
  assert.equal(r.preserved, false);
});

test("mergeScalar：用户改过 → 保留用户值并上报", () => {
  const r = mergeScalar({ upstream: "上游名", prev: "我改的名", snapshot: "上游名", hasSnapshot: true });
  assert.equal(r.value, "我改的名");
  assert.equal(r.preserved, true);
});

// 用户改过之后上游也改了：仍以用户为准。上游改名的优先级不该高于人的显式意图，
// 否则"改了又被改回"会反复发生，而用户无从知道为什么。
test("mergeScalar：用户改过且上游也变了 → 仍保留用户值", () => {
  const r = mergeScalar({ upstream: "上游又改的", prev: "我改的名", snapshot: "上游原名", hasSnapshot: true });
  assert.equal(r.value, "我改的名");
  assert.equal(r.preserved, true);
});

// 老渠道（本功能上线前导入的）没有快照，无从判断用户是否改过。
// 保守保留本地值：宁可一次上游改名同步不过来，也不要静默抹掉用户的修改（后者不可逆且无提示）。
test("mergeScalar：无快照 → 保守保留本地值，不采纳上游", () => {
  const r = mergeScalar({ upstream: "上游名", prev: "本地名", snapshot: undefined, hasSnapshot: false });
  assert.equal(r.value, "本地名");
  assert.equal(r.preserved, true);
});

test("mergeScalar：无快照且本地为空 → 用上游值填上（不算保留）", () => {
  for (const empty of ["", null, undefined]) {
    const r = mergeScalar({ upstream: "上游名", prev: empty, snapshot: undefined, hasSnapshot: false });
    assert.equal(r.value, "上游名", `prev=${JSON.stringify(empty)} 时该用上游值`);
    assert.equal(r.preserved, false);
  }
});

test("mergeModels：用户没动过 → 完全跟随上游（含上游删掉的）", () => {
  const r = mergeModels({ upstream: ["a", "c"], prev: ["a", "b"], snapshot: ["a", "b"], hasSnapshot: true });
  assert.deepEqual(r.value, ["a", "c"]);
  assert.equal(r.preserved, false);
});

test("mergeModels：用户删掉的模型不被加回来", () => {
  // 上次导入给了 a,b,c；用户删掉 b。这次上游仍给 a,b,c → b 不该回来。
  const r = mergeModels({ upstream: ["a", "b", "c"], prev: ["a", "c"], snapshot: ["a", "b", "c"], hasSnapshot: true });
  assert.deepEqual(r.value, ["a", "c"]);
  assert.equal(r.preserved, true);
});

test("mergeModels：用户手加的模型不被抹掉，上游新增的仍能进来", () => {
  // 上次导入 a；用户手加 mine。这次上游给 a,b → 结果 a,b + mine。
  const r = mergeModels({ upstream: ["a", "b"], prev: ["a", "mine"], snapshot: ["a"], hasSnapshot: true });
  assert.deepEqual(r.value, ["a", "b", "mine"], "上游顺序在前、用户追加在后");
  assert.equal(r.preserved, true);
});

test("mergeModels：无快照 → 并集，不删任何本地已有的", () => {
  const r = mergeModels({ upstream: ["a", "b"], prev: ["a", "mine"], snapshot: undefined, hasSnapshot: false });
  assert.deepEqual(r.value, ["a", "b", "mine"]);
  assert.equal(r.preserved, true);
});

test("mergeModels：畸形输入不崩，去重去空白", () => {
  const r = mergeModels({ upstream: ["a", " a ", "", null, "b"], prev: undefined, snapshot: undefined, hasSnapshot: false });
  assert.deepEqual(r.value, ["a", "b"]);
});

test("mergeImportedChannel：首次有快照后，第二次导入能同步上游改名", () => {
  const prev = {
    id: "ch-1",
    name: "老名",
    protocol: "openai_compatible",
    models: ["a"],
    createdAt: "2026-01-01T00:00:00.000Z",
    importSnapshot: { name: "老名", protocol: "openai_compatible", models: ["a"] },
  };
  const mapped = { id: "ch-1", name: "上游新名", protocol: "openai_compatible", models: ["a", "b"], createdAt: "2026-08-01T00:00:00.000Z" };
  const { channel, preservedFields } = mergeImportedChannel(prev, mapped);
  assert.equal(channel.name, "上游新名");
  assert.deepEqual(channel.models, ["a", "b"]);
  assert.deepEqual(preservedFields, []);
  assert.equal(channel.createdAt, "2026-01-01T00:00:00.000Z", "创建时间永远沿用本地");
  assert.equal(channel.id, "ch-1", "id 永远沿用本地");
});

// 这条是 P2-1 的主回归：协议修正必须活过重新导入。
test("mergeImportedChannel：用户按 notes 指引改的协议，重新导入后仍在", () => {
  const prev = {
    id: "ch-1",
    name: "测试-Alpha",
    protocol: "openai_compatible", // 用户按 notes 从 claude_messages 改过来的
    models: ["claude-opus-4"],
    importSnapshot: { name: "测试-Alpha", protocol: "claude_messages", models: ["claude-opus-4"] },
  };
  const mapped = { id: "ch-1", name: "测试-Alpha", protocol: "claude_messages", models: ["claude-opus-4"] };
  const { channel, preservedFields } = mergeImportedChannel(prev, mapped);
  assert.equal(channel.protocol, "openai_compatible", "用户的协议修正不能被推翻");
  assert.deepEqual(preservedFields, ["protocol"]);
});

test("mergeImportedChannel：快照记的是上游本次给的值，不是合并结果", () => {
  const prev = {
    id: "ch-1",
    name: "我改的名",
    protocol: "openai_compatible",
    models: ["a"],
    importSnapshot: { name: "上游原名", protocol: "openai_compatible", models: ["a"] },
  };
  const mapped = { id: "ch-1", name: "上游原名", protocol: "openai_compatible", models: ["a"] };
  const { channel } = mergeImportedChannel(prev, mapped);
  assert.equal(channel.name, "我改的名", "本次保留用户值");
  assert.equal(
    channel.importSnapshot.name,
    "上游原名",
    "快照必须记上游值——记成合并结果会让下次比对永远判定「没改过」，三方合并退化成全量覆盖",
  );
});

// 幂等性：同样的上游数据反复导入，用户的修改必须一直稳定，不能第 N 次才被吃掉。
test("mergeImportedChannel：反复导入 5 次，用户的修改始终稳定", () => {
  let channel = {
    id: "ch-1",
    name: "我的名字",
    protocol: "openai_compatible",
    models: ["a", "mine"],
    importSnapshot: { name: "上游名", protocol: "claude_messages", models: ["a"] },
  };
  const mapped = { id: "ch-1", name: "上游名", protocol: "claude_messages", models: ["a"] };
  for (let i = 0; i < 5; i += 1) {
    const r = mergeImportedChannel(channel, mapped);
    channel = r.channel;
    assert.equal(channel.name, "我的名字", `第 ${i + 1} 次导入后名字仍是用户的`);
    assert.equal(channel.protocol, "openai_compatible", `第 ${i + 1} 次导入后协议仍是用户的`);
    assert.deepEqual(channel.models, ["a", "mine"], `第 ${i + 1} 次导入后模型清单仍含用户加的`);
    assert.deepEqual(r.preservedFields.sort(), ["models", "name", "protocol"]);
  }
});

// 老渠道升级路径：第一次重新导入补写快照，此后三方比对生效。
test("mergeImportedChannel：老渠道（无快照）首次导入后补上快照，第二次起能跟随上游", () => {
  const legacy = { id: "ch-1", name: "本地名", protocol: "claude_messages", models: ["a"] };
  const mapped1 = { id: "ch-1", name: "上游名", protocol: "claude_messages", models: ["a"] };
  const first = mergeImportedChannel(legacy, mapped1);
  assert.equal(first.channel.name, "本地名", "无快照时保守保留本地值");
  assert.ok(first.channel.importSnapshot, "必须补写快照");
  assert.equal(first.channel.importSnapshot.name, "上游名");

  // 第二次：本地名仍是"本地名"、快照是"上游名" → 判定用户改过 → 继续保留。
  const second = mergeImportedChannel(first.channel, mapped1);
  assert.equal(second.channel.name, "本地名");

  // 若用户把名字改回与上游一致，则此后跟随上游。
  const aligned = { ...first.channel, name: "上游名" };
  const third = mergeImportedChannel(aligned, { ...mapped1, name: "上游又改了" });
  assert.equal(third.channel.name, "上游又改了", "对齐后即可正常跟随上游改名");
});

test("annotatePreservedProtocol：保留了协议就在 notes 里说实话", () => {
  const out = annotatePreservedProtocol("协议按分组声明的 platform=anthropic 判定（非猜测）。", {
    preserved: true,
    upstreamProtocol: "claude_messages",
    actualProtocol: "openai_compatible",
  });
  assert.match(out, /已保留你的手工设置/);
  assert.match(out, /claude_messages/);
  assert.match(out, /openai_compatible/);
});

test("annotatePreservedProtocol：没保留 / 两者相同 → 原样返回，不加噪音", () => {
  const notes = "协议按分组声明的 platform=openai 判定（非猜测）。";
  assert.equal(annotatePreservedProtocol(notes, { preserved: false, upstreamProtocol: "a", actualProtocol: "b" }), notes);
  assert.equal(annotatePreservedProtocol(notes, { preserved: true, upstreamProtocol: "same", actualProtocol: "same" }), notes);
});

// —— 以下是本轮自查发现的四类新问题的回归 ——

// 问题1：字段覆盖不全。初版只保护 name/protocol，用户填的 provider 和自己写的 notes
// 每次重新导入都被静默冲掉 —— 与本模块要修的原始 bug 同一类，只是换了字段。
// 判据取「渠道表单里用户改得到的字段」（index.html #channel-form）。
test("保护字段清单覆盖用户在 UI 里能改的所有字段", () => {
  for (const field of ["name", "protocol", "provider", "notes"]) {
    assert.ok(MERGED_SCALAR_FIELDS.includes(field), `${field} 在渠道表单里可编辑，必须纳入三方合并`);
  }
  // status 刻意不保护：表单无该控件、前端无任何提交它的代码，上游是唯一权威。
  assert.ok(!MERGED_SCALAR_FIELDS.includes("status"), "status 由上游权威，纳入保护会让已停用渠道在本地一直显示启用");
  assert.ok(!MERGED_SCALAR_FIELDS.includes("baseUrl"), "baseUrl 决定渠道身份，不参与合并");
});

test("用户填的 provider 与自己写的备注都活过重新导入", () => {
  const mapped = {
    id: "c1",
    name: "上游名",
    protocol: "openai_compatible",
    provider: "OpenAI",
    notes: "协议按模型名推断。",
    models: ["a"],
  };
  const prev = { ...mapped, importSnapshot: importSnapshotOf(mapped), provider: "我填的供应商", notes: "我的备注：夜间才测" };
  const { channel, preservedFields } = mergeImportedChannel(prev, mapped);
  assert.equal(channel.provider, "我填的供应商");
  assert.equal(channel.notes, "我的备注：夜间才测");
  assert.deepEqual(preservedFields.sort(), ["notes", "provider"]);
});

// 问题2：快照形状未校验。{} 和 [] 都是 object，若当成「有快照」，逐字段比对
// undefined !== 本地值 会把每个字段判成"用户改过"→ 永久保留 → 上游改名再也同步不过来。
// normalizeChannel 不校验该字段形状、原样收下请求体里的值，故 {} 是可达的。
test("isUsableSnapshot：按形状判，空对象/数组/非对象都不算可用快照", () => {
  assert.equal(isUsableSnapshot({ name: "x" }), true);
  assert.equal(isUsableSnapshot({ models: [] }), true, "只有 models 键也算（快照必带该键）");
  assert.equal(isUsableSnapshot({}), false, "空对象不能当成有快照");
  assert.equal(isUsableSnapshot([]), false, "数组也是 object，同样不算");
  for (const bad of [null, undefined, "x", 0, 42, true]) {
    assert.equal(isUsableSnapshot(bad), false, `${JSON.stringify(bad)} 不算可用快照`);
  }
  assert.equal(isUsableSnapshot({ unrelated: 1 }), false, "只有无关键名也不算");
});

// 空快照的**行为级**差异（只断言 isUsableSnapshot 不够：把 {} 当成有快照时，
// 逐字段比对 `本地值 !== undefined` 会把每个字段都判成"用户改过"，于是 preserved 虚增、
// 前端会谎报「保留了你对名称/协议/供应商/备注的修改」而用户其实只改了一个字段）。
test("空快照下 preserved 只含真正与上游不同的字段，不虚报", () => {
  const mapped = { id: "c1", name: "上游名", protocol: "openai_compatible", provider: "", notes: "n", models: ["a"] };
  const prev = { ...mapped, importSnapshot: {}, name: "本地名" }; // 只有 name 与上游不同
  const { preservedFields } = mergeImportedChannel(prev, mapped);
  assert.deepEqual(preservedFields, ["name"], `空快照时只有 name 该进 preserved，实际 ${JSON.stringify(preservedFields)}`);
});

test("空快照不会让上游改名永久卡住（回落到保守保留，但下次即恢复同步）", () => {
  const mapped = { id: "c1", name: "上游名", protocol: "openai_compatible", provider: "", notes: "n", models: ["a"] };
  for (const bad of [{}, [], null, "x", 0]) {
    const first = mergeImportedChannel({ ...mapped, importSnapshot: bad, name: "本地名" }, mapped);
    assert.equal(first.channel.name, "本地名", `importSnapshot=${JSON.stringify(bad)} 时保守保留本地值`);
    assert.ok(isUsableSnapshot(first.channel.importSnapshot), "必须补写成可用快照");
    // 第二次：快照已可用，用户把名字改回与上游一致后即能跟随上游
    const aligned = { ...first.channel, name: "上游名" };
    const second = mergeImportedChannel(aligned, { ...mapped, name: "上游又改了" });
    assert.equal(second.channel.name, "上游又改了", "下一次导入起同步恢复，不是永久卡住");
  }
});

// 问题3：notes 的自指循环。程序往 notes 追加「已保留你的手工设置」后，落库值就不等于
// 快照里的 notes，下次导入会把这段【自己追加的文字】误判成"用户改过 notes"，
// 从此 notes 永久保留、再也不跟随上游 —— 且会连带虚增 preserved 计数。
test("finalizeImportedNotes：追加协议说明后同步快照，下次不误判成用户改过", () => {
  const mapped = { id: "c1", name: "N", protocol: "claude_messages", provider: "", notes: "协议按 platform 判定。", models: ["a"] };
  // 用户只改了协议，没碰 notes
  const prev = { ...mapped, importSnapshot: importSnapshotOf(mapped), protocol: "openai_compatible" };
  const first = mergeImportedChannel(prev, mapped);
  finalizeImportedNotes(first.channel, first.preservedFields, { upstreamNotes: mapped.notes, upstreamProtocol: mapped.protocol });
  assert.match(first.channel.notes, /已保留你的手工设置/);
  assert.equal(first.channel.importSnapshot.notes, first.channel.notes, "快照要同步成实际产出的 notes");

  // 第二次导入：notes 不该被判成"用户改过"
  const second = mergeImportedChannel(first.channel, mapped);
  assert.ok(
    !second.preservedFields.includes("notes"),
    `notes 不该被误判成用户改过，实际 preserved=${JSON.stringify(second.preservedFields)}`,
  );
  assert.deepEqual(second.preservedFields, ["protocol"], "只有协议是用户真改过的");
});

test("finalizeImportedNotes：用户写了备注就完全不碰它", () => {
  const mapped = { id: "c1", name: "N", protocol: "claude_messages", provider: "", notes: "上游生成的说明。", models: ["a"] };
  const prev = { ...mapped, importSnapshot: importSnapshotOf(mapped), protocol: "openai_compatible", notes: "我的备注" };
  const r = mergeImportedChannel(prev, mapped);
  finalizeImportedNotes(r.channel, r.preservedFields, { upstreamNotes: mapped.notes, upstreamProtocol: mapped.protocol });
  assert.equal(r.channel.notes, "我的备注", "用户备注优先于程序生成的说明");
  assert.ok(!/已保留你的手工设置/.test(r.channel.notes), "不该往用户的备注里塞程序文字");
});

// 反复导入的稳定性：preserved 计数不能随导入次数虚增（notes 自指循环的可观测症状）。
test("反复导入 5 次，preservedFields 恒定不虚增", () => {
  const mapped = { id: "c1", name: "N", protocol: "claude_messages", provider: "", notes: "上游说明。", models: ["a"] };
  let channel = { ...mapped, importSnapshot: importSnapshotOf(mapped), protocol: "openai_compatible" };
  for (let i = 0; i < 5; i += 1) {
    const r = mergeImportedChannel(channel, mapped);
    finalizeImportedNotes(r.channel, r.preservedFields, { upstreamNotes: mapped.notes, upstreamProtocol: mapped.protocol });
    channel = r.channel;
    assert.deepEqual(r.preservedFields, ["protocol"], `第 ${i + 1} 次导入：只有协议被保留`);
  }
});

// —— 快照口径必须与 normalizeChannel 一致（P3 回归）——
// 三条导入链路都走 importedChannelName 生成渠道名。它存在的唯一理由是：
// normalizeChannel 对 name 走 requiredString（trim），而 saveChannels 不归一化、导入原样落库；
// 两边口径不一致会让三方合并退化。下面两个用例分别钉住那两个实测复现过的后果。
// 变异验证：把三条链路里的 importedChannelName 换回 String(x || fallback) 即两条同时变红。

test("上游名带首尾空格：UI 保存过一次后，上游改名仍能同步过来", () => {
  // 模拟三条链路的映射（都用 importedChannelName），上游名带尾随空格
  const mappedOf = (upstreamName) => ({
    id: "c1",
    name: importedChannelName(upstreamName, "兜底名"),
    protocol: "claude_messages",
    provider: "",
    notes: "上游说明。",
    models: ["m1"],
  });

  const first = mappedOf("测试密钥 ");
  let channel = { ...first, importSnapshot: importSnapshotOf(first) };

  // 用户在 UI 里保存一次（什么都没改）——normalizeChannel 会 trim name
  channel = normalizeChannel({ ...channel }, channel);
  assert.equal(channel.name, "测试密钥", "normalizeChannel 会 trim（这是 UI 保存的既有行为）");
  assert.ok(channel.importSnapshot, "importSnapshot 在白名单里，UI 编辑后要留存");

  // 再次导入，上游数据没变 → 不该判成「用户改过」
  const second = mergeImportedChannel(channel, mappedOf("测试密钥 "));
  assert.deepEqual(second.preservedFields, [], "用户没改过 name，不能计入 preserved");

  // 上游真改名 → 必须同步过来
  const third = mergeImportedChannel(second.channel, mappedOf("上游改的新名字"));
  assert.equal(third.channel.name, "上游改的新名字", "上游改名必须能同步（退化时会卡在旧名）");
});

test("上游名是全空白：回落兜底名，渠道在 UI 里存得下来", () => {
  const name = importedChannelName("   ", "sub2api 密钥 5");
  assert.equal(name, "sub2api 密钥 5", "trim 后为空视同没给名字，用兜底名");
  // 落库的名字必须能通过 normalizeChannel——否则该渠道永远存不了任何修改（400 渠道名称不能为空）
  const channel = normalizeChannel({ name, baseUrl: "https://relay.test", protocol: "openai_compatible" }, null);
  assert.equal(channel.name, "sub2api 密钥 5");
});
