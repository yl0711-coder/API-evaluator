import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGroupIndex,
  buildSub2apiImportPlan,
  buildSub2apiNote,
  mapKeyStatus,
  platformToProtocol,
  sub2apiChannelLocalId,
} from "../server/sub2api-plan.mjs";

test("platform → 协议：只有 anthropic 走 Claude Messages", () => {
  assert.equal(platformToProtocol("anthropic"), "claude_messages");
  assert.equal(platformToProtocol("Anthropic"), "claude_messages", "大小写不敏感");
  assert.equal(platformToProtocol("openai"), "openai_compatible");
  assert.equal(platformToProtocol("gemini"), "openai_compatible");
  assert.equal(platformToProtocol(""), "openai_compatible");
  assert.equal(platformToProtocol(null), "openai_compatible");
  assert.equal(platformToProtocol(undefined), "openai_compatible");
});

test("密钥 status：active=启用，其余都算禁用", () => {
  assert.equal(mapKeyStatus("active"), "enabled");
  assert.equal(mapKeyStatus("ACTIVE"), "enabled");
  assert.equal(mapKeyStatus("inactive"), "disabled");
  assert.equal(mapKeyStatus(""), "disabled");
  assert.equal(mapKeyStatus(undefined), "disabled");
});

test("buildGroupIndex：分组索引按字符串键、模型去重保序", () => {
  const idx = buildGroupIndex({
    groups: [
      {
        id: 3,
        name: "标准组",
        platform: "anthropic",
        models: [{ name: "claude-sonnet-4-5" }, { name: "claude-opus-4" }, { name: "claude-sonnet-4-5" }, { name: "" }],
      },
      { id: 7, name: "OpenAI 组", platform: "openai", models: [{ name: "gpt-4o" }] },
    ],
  });
  assert.equal(idx.size, 2);
  assert.deepEqual(idx.get("3").models, ["claude-sonnet-4-5", "claude-opus-4"], "去重保序，空名剔除");
  assert.equal(idx.get("3").platform, "anthropic");
  assert.equal(idx.get("3").name, "标准组");
  assert.ok(idx.get("7"), "数字 id 要能用字符串键取到");
});

test("buildGroupIndex：畸形输入不崩", () => {
  assert.equal(buildGroupIndex(null).size, 0);
  assert.equal(buildGroupIndex({}).size, 0);
  assert.equal(buildGroupIndex({ groups: null }).size, 0);
  assert.equal(buildGroupIndex({ groups: [null, { name: "无 id" }] }).size, 0, "缺 id 的分组要跳过");
  const idx = buildGroupIndex({ groups: [{ id: 1, models: null }] });
  assert.deepEqual(idx.get("1").models, []);
});

test("本地渠道 id：同 base 稳定、跨 base 不撞、数字与字符串一致", () => {
  const a = sub2apiChannelLocalId("https://x.test", 5);
  assert.equal(a, sub2apiChannelLocalId("https://x.test", 5), "同输入必须稳定（幂等依赖它）");
  assert.equal(a, sub2apiChannelLocalId("https://x.test/", 5), "尾斜杠归一化");
  assert.equal(a, sub2apiChannelLocalId("https://x.test", "5"), "数字与字符串 id 必须一致，否则重导会建重复渠道");
  assert.notEqual(a, sub2apiChannelLocalId("https://y.test", 5), "密钥 id 只在单实例内唯一，跨 base 必须区分");
  assert.notEqual(a, sub2apiChannelLocalId("https://x.test", 6));
  assert.match(a, /^sub2api-key-[0-9a-f]{8}-5$/);
});

// 安全回归：id 会被前端拼进 `data-edit-channel="${channel.id}"` 且按约定不转义，
// 而 keyId 来自上游。这是 new-api 那条链路上真实踩到过的 XSS，此处同样必须防住。
test("本地渠道 id：上游异常/恶意 keyId 不能带出危险字符", () => {
  const bads = ['5" onmouseover=alert(1) x="', "5<script>", "5&amp;", "../../etc", "", null, undefined];
  for (const bad of bads) {
    const id = sub2apiChannelLocalId("https://x.test", bad);
    assert.match(id, /^[a-z0-9-]+$/, `id 只允许 [a-z0-9-]，实际: ${id}`);
  }
  assert.notEqual(
    sub2apiChannelLocalId("https://x.test", "5<a>"),
    sub2apiChannelLocalId("https://x.test", "5<b>"),
    "不同异常 id 不能塌缩成同一渠道",
  );
});

test("notes：有 platform 时写明非猜测；回落时如实说明拿不到 platform", () => {
  const declared = buildSub2apiNote({ platform: "anthropic", groupName: "标准组", viaFallback: false });
  assert.match(declared, /platform=anthropic/);
  assert.match(declared, /非猜测/);
  assert.match(declared, /标准组/);
  assert.match(declared, /404/, "始终提示中继协议可能要改");

  const fallback = buildSub2apiNote({ platform: "", groupName: "", viaFallback: true });
  assert.match(fallback, /未提供分组 platform|模型广场未启用/);
  assert.match(fallback, /v1\/models/);
});

const PLAZA = {
  groups: [
    { id: 3, name: "Claude 组", platform: "anthropic", models: [{ name: "claude-opus-4" }, { name: "claude-sonnet-4" }] },
    { id: 7, name: "OpenAI 组", platform: "openai", models: [{ name: "gpt-4o" }] },
  ],
};

test("编排：每个密钥一个渠道，协议按分组 platform 判定", () => {
  const idx = buildGroupIndex(PLAZA);
  const plan = buildSub2apiImportPlan({
    keys: [
      { id: 1, name: "测试-Claude", key: "sk-aaa", group_id: 3, status: "active" },
      { id: 2, name: "测试-OpenAI", key: "sk-bbb", group_id: 7, status: "inactive" },
    ],
    groupIndex: idx,
    base: "https://relay.test",
    existingChannels: [],
    existingTargets: [],
  });
  assert.equal(plan.channels.length, 2);
  assert.equal(plan.summary.imported, 2);
  assert.equal(plan.summary.disabled, 1, "status=inactive 算禁用");
  assert.equal(plan.summary.viaFallback, 0);

  const c1 = plan.channels[0];
  assert.equal(c1.baseUrl, "https://relay.test", "渠道指回 sub2api 自己");
  assert.equal(c1.source, "sub2api");
  assert.equal(c1.protocol, "claude_messages", "anthropic 分组 → Claude Messages（非猜模型名）");
  assert.deepEqual(c1.models, ["claude-opus-4", "claude-sonnet-4"]);
  assert.equal(c1.sub2apiKeyId, 1);
  assert.equal(c1.sub2apiGroupId, 3);
  assert.equal(c1.sub2apiGroupName, "Claude 组");

  const c2 = plan.channels[1];
  assert.equal(c2.protocol, "openai_compatible");
  assert.equal(c2.status, "disabled");

  // 明文 key 只在 keys 映射里，绝不在渠道对象上
  assert.deepEqual(plan.keys, { [c1.id]: "sk-aaa", [c2.id]: "sk-bbb" });
  for (const ch of plan.channels) {
    assert.equal(ch.key, undefined);
    assert.equal(ch.apiKey, undefined);
  }

  assert.equal(plan.targets.length, 3, "2 + 1 个模型");
  assert.equal(plan.summary.newTargets, 3);
  assert.equal(plan.targets[0].source, "sub2api");
});

test("编排：模型广场不可用时按 /v1/models 回落，协议落 OpenAI 兼容并计数", () => {
  const plan = buildSub2apiImportPlan({
    keys: [{ id: 9, name: "测试-回落", key: "sk-ccc", group_id: 3, status: "active" }],
    groupIndex: new Map(), // 广场未启用 → 索引为空
    keyModels: { 9: ["claude-opus-4", "gpt-4o"] },
    base: "https://relay.test",
    existingChannels: [],
    existingTargets: [],
  });
  const c = plan.channels[0];
  assert.deepEqual(c.models, ["claude-opus-4", "gpt-4o"]);
  assert.equal(c.protocol, "openai_compatible", "拿不到 platform 时不该假装知道，落 OpenAI 兼容");
  assert.equal(c.sub2apiGroupName, "", "回落路径拿不到分组名，如实留空");
  assert.equal(plan.summary.viaFallback, 1);
  assert.equal(plan.summary.noGroup, 1, "没有分组元信息要计数上报");
  assert.match(c.notes, /v1\/models/);
});

test("编排：group_id 为 null（密钥未绑分组）不崩，计入 noGroup", () => {
  const plan = buildSub2apiImportPlan({
    keys: [{ id: 4, name: "测试-无分组", key: "sk-ddd", group_id: null, status: "active" }],
    groupIndex: buildGroupIndex(PLAZA),
    base: "https://relay.test",
    existingChannels: [],
    existingTargets: [],
  });
  assert.equal(plan.channels.length, 1);
  assert.deepEqual(plan.channels[0].models, []);
  assert.equal(plan.channels[0].sub2apiGroupId, null);
  assert.equal(plan.summary.noGroup, 1);
  assert.equal(plan.summary.noModels, 1);
  assert.equal(plan.targets.length, 0);
});

test("编排：重复导入幂等——渠道与模型目标都不增长", () => {
  const args = {
    keys: [{ id: 1, name: "测试-Claude", key: "sk-aaa", group_id: 3, status: "active" }],
    groupIndex: buildGroupIndex(PLAZA),
    base: "https://relay.test",
  };
  const first = buildSub2apiImportPlan({ ...args, existingChannels: [], existingTargets: [] });
  const second = buildSub2apiImportPlan({ ...args, existingChannels: first.channels, existingTargets: first.targets });
  assert.equal(second.channels.length, 1, "同一密钥不该建出第二个渠道");
  assert.equal(second.targets.length, first.targets.length);
  assert.equal(second.summary.imported, 0);
  assert.equal(second.summary.updated, 1);
  assert.equal(second.summary.newTargets, 0);
  assert.equal(second.channels[0].createdAt, first.channels[0].createdAt, "创建时间要保留");
});

// 注意：本用例原先断言「无论如何都采纳上游的新名字」。三方合并上线后语义**刻意**改了——
// 没有 importSnapshot 的渠道（本功能之前导入的）无从判断用户是否改过名，保守保留本地值。
// 理由：若采纳上游，则修复上线后的第一次重新导入仍会静默抹掉用户已有的修改，
// 而"已经按 notes 改过协议的人"正是这个修复要保护的那批人。上游改名同步不过来是可恢复的
// （用户自行改一次即对齐），静默抹掉用户修改是不可逆的。
// 本用例原本的保护意图（id 沿用、createdAt 沿用、模型目标不成孤儿）全部保留。
test("编排：命中已存在渠道时保留其 id 与创建时间，模型目标不成孤儿", () => {
  const localId = sub2apiChannelLocalId("https://relay.test", 1);
  const existing = [{ id: localId, name: "旧名", baseUrl: "https://relay.test", createdAt: "2020-01-01T00:00:00.000Z" }];
  const plan = buildSub2apiImportPlan({
    keys: [{ id: 1, name: "测试-新名", key: "sk-aaa", group_id: 3, status: "active" }],
    groupIndex: buildGroupIndex(PLAZA),
    base: "https://relay.test",
    existingChannels: existing,
    existingTargets: [],
  });
  assert.equal(plan.channels.length, 1);
  assert.equal(plan.channels[0].id, localId);
  assert.equal(plan.channels[0].createdAt, "2020-01-01T00:00:00.000Z");
  assert.equal(plan.channels[0].name, "旧名", "无快照的老渠道：保守保留本地名，不采纳上游（见上方说明）");
  assert.ok(plan.channels[0].importSnapshot, "同时补写快照，下一次导入起三方比对生效");
  // 协议等"用户改不到的"字段仍照上游更新，元信息不会停止同步。
  assert.equal(plan.channels[0].protocol, "claude_messages", "上游 platform=anthropic 仍要生效");
  assert.equal(plan.channels[0].sub2apiGroupName, "Claude 组", "分组元信息仍要更新");
  for (const t of plan.targets) assert.equal(t.channelId, localId);
});

// 有快照的渠道（正常路径）：上游改名必须能同步过来，合并不能变成"永不更新"。
test("编排：有快照且用户没改过时，上游改名照常同步", () => {
  const first = buildSub2apiImportPlan({
    keys: [{ id: 1, name: "测试-原名", key: "sk-aaa", group_id: 3, status: "active" }],
    groupIndex: buildGroupIndex(PLAZA),
    base: "https://relay.test",
    existingChannels: [],
    existingTargets: [],
  });
  const second = buildSub2apiImportPlan({
    keys: [{ id: 1, name: "测试-上游改名", key: "sk-aaa", group_id: 3, status: "active" }],
    groupIndex: buildGroupIndex(PLAZA),
    base: "https://relay.test",
    existingChannels: first.channels,
    existingTargets: first.targets,
  });
  assert.equal(second.channels[0].name, "测试-上游改名", "元信息要更新");
  assert.equal(second.summary.preserved, 0);
});

test("编排：keys 映射按字符串键也能取到明文（后端 JSON 解析回来是字符串键）", () => {
  const plan = buildSub2apiImportPlan({
    keys: [{ id: 7, name: "测试", key: "sk-eee", group_id: 7, status: "active" }],
    groupIndex: buildGroupIndex(PLAZA),
    keyModels: { 7: ["x"] },
    base: "https://relay.test",
    existingChannels: [],
    existingTargets: [],
  });
  assert.equal(Object.values(plan.keys)[0], "sk-eee");
});

test("编排：无密钥时返回空计划而非崩", () => {
  const plan = buildSub2apiImportPlan({});
  assert.deepEqual(plan.channels, []);
  assert.deepEqual(plan.targets, []);
  assert.deepEqual(plan.keys, {});
  assert.equal(plan.summary.total, 0);
});

// —— P2-1 回归：重新导入不得推翻用户的手工修改（三方合并，见 server/import-merge.mjs）——
// 原实现是 {...prev, ...mapped} 全量覆盖：产品在 notes 里让用户「若报 404 就把协议改成
// OpenAI Compatible」，用户照做，下次导入被静默改回，改的名字和手加的模型一并消失。
const S2A_KEY = { id: 1, name: "测试-Alpha", key: "sk-a", group_id: 3, status: "active" };

function s2aPlanWith(existingChannels) {
  return buildSub2apiImportPlan({
    keys: [S2A_KEY],
    groupIndex: buildGroupIndex(PLAZA),
    base: "https://relay.test",
    existingChannels,
    existingTargets: [],
  });
}

test("重新导入：用户按 notes 指引改的协议不被推翻，且 summary 上报 preserved", () => {
  const first = s2aPlanWith([]);
  const ch = first.channels[0];
  assert.equal(ch.protocol, "claude_messages", "上游 platform=anthropic");
  assert.ok(ch.importSnapshot, "首次导入就要落快照，否则下次无从比对");

  // 用户照 notes 把协议改成 OpenAI 兼容（模拟 UI 编辑：只改这一个字段）
  const edited = { ...ch, protocol: "openai_compatible" };
  const second = s2aPlanWith([edited]);
  assert.equal(second.channels[0].protocol, "openai_compatible", "用户的协议修正必须活过重新导入");
  assert.equal(second.summary.preserved, 1, "要如实上报保留了几个渠道的手工修改");
  assert.match(second.channels[0].notes, /已保留你的手工设置/, "notes 不能还声称协议是按 platform 判定的");
});

test("重新导入：用户改的名字与手加的模型都保住，上游新增的模型仍能进来", () => {
  const first = s2aPlanWith([]);
  const edited = { ...first.channels[0], name: "我改的名字", models: ["claude-opus-4", "我加的模型"] };
  // 上游这次多给一个模型
  const plaza2 = {
    groups: [
      {
        id: 3,
        name: "Claude 组",
        platform: "anthropic",
        models: [{ name: "claude-opus-4" }, { name: "claude-sonnet-4" }, { name: "claude-haiku-4" }],
      },
    ],
  };
  const second = buildSub2apiImportPlan({
    keys: [S2A_KEY],
    groupIndex: buildGroupIndex(plaza2),
    base: "https://relay.test",
    existingChannels: [edited],
    existingTargets: [],
  });
  const ch = second.channels[0];
  assert.equal(ch.name, "我改的名字");
  assert.ok(ch.models.includes("我加的模型"), "用户手加的模型不能被抹掉");
  assert.ok(ch.models.includes("claude-haiku-4"), "上游新增的模型仍要能进来");
  assert.ok(!ch.models.includes("claude-sonnet-4"), "用户上次删掉的模型不该被加回来");
});

test("重新导入：模型目标按合并后的清单建，不把用户删掉的模型加回来", () => {
  const first = s2aPlanWith([]);
  assert.equal(first.targets.length, 2, "上游给了 2 个模型");
  // 用户删掉一个模型（连同它的模型目标）
  const edited = { ...first.channels[0], models: ["claude-opus-4"] };
  const second = buildSub2apiImportPlan({
    keys: [S2A_KEY],
    groupIndex: buildGroupIndex(PLAZA),
    base: "https://relay.test",
    existingChannels: [edited],
    existingTargets: [],
  });
  assert.deepEqual(
    second.targets.map((t) => t.model),
    ["claude-opus-4"],
    "被用户删掉的模型不该重新长出模型目标",
  );
});

test("重新导入：用户没动过时仍完全跟随上游（合并不能变成「永不更新」）", () => {
  const first = s2aPlanWith([]);
  const plaza2 = { groups: [{ id: 3, name: "Claude 组", platform: "openai", models: [{ name: "gpt-4o" }] }] };
  const second = buildSub2apiImportPlan({
    keys: [{ ...S2A_KEY, name: "测试-上游改名了" }],
    groupIndex: buildGroupIndex(plaza2),
    base: "https://relay.test",
    existingChannels: [first.channels[0]],
    existingTargets: [],
  });
  const ch = second.channels[0];
  assert.equal(ch.name, "测试-上游改名了", "上游改名要能同步");
  assert.equal(ch.protocol, "openai_compatible", "上游换 platform 要能同步");
  assert.deepEqual(ch.models, ["gpt-4o"]);
  assert.equal(second.summary.preserved, 0, "没有用户修改就不该报 preserved");
});

// 本轮自查发现：noModels 原按【上游口径】计，于是"上游给 0 个模型、但用户本地手加过模型"时
// 会误报「N 个密钥没查到可用模型」，而渠道其实是有模型可测的。该计数驱动前端提示，
// 说的应是「这个渠道最终有没有模型」，故改到合并之后再计。
test("noModels 按合并后的最终清单计，不因上游给空而误报", () => {
  const emptyPlaza = { groups: [{ id: 3, name: "G", platform: "anthropic", models: [] }] };
  const key = { id: 1, name: "测试-A", key: "sk-1", group_id: 3, status: "active" };
  const seeded = buildSub2apiImportPlan({
    keys: [key],
    groupIndex: buildGroupIndex(PLAZA),
    base: "https://relay.test",
    existingChannels: [],
    existingTargets: [],
  });
  // 用户手加了一个模型；这次上游一个模型都不给
  const userHas = { ...seeded.channels[0], models: ["我加的模型"] };
  const plan = buildSub2apiImportPlan({
    keys: [key],
    groupIndex: buildGroupIndex(emptyPlaza),
    base: "https://relay.test",
    existingChannels: [userHas],
    existingTargets: [],
  });
  assert.deepEqual(plan.channels[0].models, ["我加的模型"], "用户手加的模型要保住");
  assert.equal(plan.summary.noModels, 0, "渠道最终有模型可测，不该报「没查到模型」");
});

test("noModels：渠道最终确实没有模型时照常上报", () => {
  const emptyPlaza = { groups: [{ id: 3, name: "G", platform: "anthropic", models: [] }] };
  const plan = buildSub2apiImportPlan({
    keys: [{ id: 9, name: "测试-空", key: "sk-9", group_id: 3, status: "active" }],
    groupIndex: buildGroupIndex(emptyPlaza),
    base: "https://relay.test",
    existingChannels: [],
    existingTargets: [],
  });
  assert.deepEqual(plan.channels[0].models, []);
  assert.equal(plan.summary.noModels, 1, "真的没有模型就要报出来");
});
