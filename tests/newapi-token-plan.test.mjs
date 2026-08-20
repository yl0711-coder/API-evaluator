import assert from "node:assert/strict";
import test from "node:test";

import {
  TEST_TOKEN_KEYWORD,
  buildProtocolNote,
  buildTokenImportPlan,
  guessProtocol,
  isTestToken,
  mapTokenStatus,
  modelsForGroup,
  newapiTokenChannelLocalId,
  resolveTokenGroup,
} from "../server/newapi-token-plan.mjs";

test("筛选口径：名称含「测试」才要", () => {
  assert.equal(TEST_TOKEN_KEYWORD, "测试");
  assert.equal(isTestToken("测试令牌"), true);
  assert.equal(isTestToken("生产-测试-A"), true);
  assert.equal(isTestToken("production"), false);
  assert.equal(isTestToken("test"), false, "口径是中文「测试」，不含英文 test（由用户确认）");
  assert.equal(isTestToken(null), false);
  assert.equal(isTestToken(undefined), false);
});

test("令牌 group 为空＝跟随用户分组，不是无分组", () => {
  assert.equal(resolveTokenGroup({ group: "vip" }, "default"), "vip");
  assert.equal(resolveTokenGroup({ group: "" }, "default"), "default", "空串必须回落到用户分组");
  assert.equal(resolveTokenGroup({ group: "   " }, "default"), "default", "纯空白同样视为空");
  assert.equal(resolveTokenGroup({}, "default"), "default");
  assert.equal(resolveTokenGroup({ group: "" }, ""), "", "用户分组也空时只能是空——调用方据此计入 noGroup");
});

test("分组 → 模型：命中该分组或 all；all 不能漏", () => {
  const pricing = [
    { model_name: "gpt-4o", enable_groups: ["default", "vip"] },
    { model_name: "claude-opus", enable_groups: ["vip"] },
    { model_name: "free-model", enable_groups: ["all"] },
    { model_name: "hidden", enable_groups: ["internal"] },
    { model_name: "", enable_groups: ["all"] },
  ];
  assert.deepEqual(modelsForGroup(pricing, "vip"), ["gpt-4o", "claude-opus", "free-model"]);
  assert.deepEqual(modelsForGroup(pricing, "default"), ["gpt-4o", "free-model"]);
  assert.deepEqual(modelsForGroup(pricing, "internal"), ["free-model", "hidden"]);
  // 分组为空时只剩 all 开放的（不能把 enable_groups 含空串的也算进来）
  assert.deepEqual(modelsForGroup(pricing, ""), ["free-model"]);
  assert.deepEqual(modelsForGroup(null, "vip"), []);
});

test("分组 → 模型：重名去重、保序", () => {
  const pricing = [
    { model_name: "gpt-4o", enable_groups: ["all"] },
    { model_name: "gpt-4o", enable_groups: ["vip"] },
    { model_name: "b", enable_groups: ["vip"] },
  ];
  assert.deepEqual(modelsForGroup(pricing, "vip"), ["gpt-4o", "b"]);
});

test("协议按模型名猜：纯 claude / 纯其他 / 混合", () => {
  assert.deepEqual(guessProtocol(["claude-opus-4", "claude-sonnet"]), {
    protocol: "claude_messages",
    claude: 2,
    other: 0,
    mixed: false,
  });
  assert.deepEqual(guessProtocol(["gpt-4o", "deepseek-v3"]), {
    protocol: "openai_compatible",
    claude: 0,
    other: 2,
    mixed: false,
  });
  // 混合按多数票；claude 少数 -> openai_compatible，且 mixed 为真
  const mix = guessProtocol(["claude-opus", "gpt-4o", "gpt-4o-mini"]);
  assert.equal(mix.protocol, "openai_compatible");
  assert.equal(mix.mixed, true);
  // claude 多数
  const mix2 = guessProtocol(["claude-a", "claude-b", "gpt-4o"]);
  assert.equal(mix2.protocol, "claude_messages");
  assert.equal(mix2.mixed, true);
  // 空清单不该崩，落到 openai_compatible
  assert.equal(guessProtocol([]).protocol, "openai_compatible");
  assert.equal(guessProtocol(null).protocol, "openai_compatible");
  // 大小写不敏感
  assert.equal(guessProtocol(["Claude-Opus"]).protocol, "claude_messages");
});

test("notes 写清协议来源；混合时给出告警，且始终提示中继协议问题", () => {
  const pure = buildProtocolNote(guessProtocol(["gpt-4o"]));
  assert.match(pure, /claude 0 个 \/ 其他 1 个/);
  assert.doesNotMatch(pure, /协议不一致/);
  assert.match(pure, /404/, "始终要提示走 /v1 中继时协议可能要改");
  const mixed = buildProtocolNote(guessProtocol(["claude-a", "gpt-4o"]));
  assert.match(mixed, /协议不一致/);
});

test("本地渠道 id：同 base 稳定、跨 base 不撞", () => {
  const a = newapiTokenChannelLocalId("https://x.test", 3);
  assert.equal(a, newapiTokenChannelLocalId("https://x.test", 3), "同输入必须稳定（幂等依赖它）");
  assert.equal(a, newapiTokenChannelLocalId("https://x.test/", 3), "尾斜杠归一化");
  assert.notEqual(a, newapiTokenChannelLocalId("https://y.test", 3), "令牌 id 只在单实例内唯一，跨 base 必须区分");
  assert.notEqual(a, newapiTokenChannelLocalId("https://x.test", 4));
  assert.match(a, /^newapi-token-[0-9a-f]{8}-3$/);
  assert.equal(a, newapiTokenChannelLocalId("https://x.test", "3"), "数字与字符串 id 必须一致，否则重导会建重复渠道");
});

// 安全回归：id 会被前端拼进 `data-edit-channel="${channel.id}"` 且按约定不转义，
// 而 tokenId 来自上游。恶意上游给 `7" onmouseover=...` 曾能打破属性（XSS）。
test("本地渠道 id：上游异常/恶意 tokenId 不能带出危险字符", () => {
  const bads = ['7" onmouseover=alert(1) x="', "7<script>", "7&amp;", "../../etc", "", null, undefined];
  const seen = new Set();
  for (const bad of bads) {
    const id = newapiTokenChannelLocalId("https://x.test", bad);
    assert.match(id, /^[a-z0-9-]+$/, `id 只允许 [a-z0-9-]，实际: ${id}`);
    seen.add(id);
  }
  // 两个不同的异常 id 不该被清洗成同一个渠道
  assert.notEqual(
    newapiTokenChannelLocalId("https://x.test", "7<a>"),
    newapiTokenChannelLocalId("https://x.test", "7<b>"),
    "不同异常 id 不能塌缩成同一渠道",
  );
});

test("令牌 status：1=启用，其余都算禁用", () => {
  assert.equal(mapTokenStatus(1), "enabled");
  assert.equal(mapTokenStatus(2), "disabled");
  assert.equal(mapTokenStatus(3), "disabled");
  assert.equal(mapTokenStatus(4), "disabled");
});

const PRICING = [
  { model_name: "gpt-4o", enable_groups: ["default"] },
  { model_name: "claude-opus", enable_groups: ["vip"] },
  { model_name: "shared", enable_groups: ["all"] },
];

test("编排：每个令牌一个渠道 + 其分组下的模型目标", () => {
  const plan = buildTokenImportPlan({
    tokens: [
      { id: 1, name: "测试-默认", group: "default", status: 1 },
      { id: 2, name: "测试-VIP", group: "vip", status: 2 },
    ],
    keys: { 1: "sk-aaa", 2: "sk-bbb" },
    pricing: PRICING,
    userGroup: "default",
    base: "https://relay.test",
    existingChannels: [],
    existingTargets: [],
  });
  assert.equal(plan.channels.length, 2);
  assert.equal(plan.summary.imported, 2);
  assert.equal(plan.summary.disabled, 1, "status=2 的令牌算禁用");

  const c1 = plan.channels[0];
  assert.equal(c1.baseUrl, "https://relay.test", "渠道指回 new-api 自己，不是上游厂商");
  assert.equal(c1.source, "newapi-token");
  assert.equal(c1.newapiTokenId, 1);
  assert.equal(c1.newapiTokenGroup, "default");
  assert.deepEqual(c1.models, ["gpt-4o", "shared"]);
  assert.equal(c1.protocol, "openai_compatible");
  assert.equal(c1.status, "enabled");

  const c2 = plan.channels[1];
  assert.deepEqual(c2.models, ["claude-opus", "shared"]);
  assert.equal(c2.status, "disabled");
  // claude 1 个 vs shared 1 个 -> 非多数，落 openai_compatible，且 mixed
  assert.equal(c2.protocol, "openai_compatible");
  assert.match(c2.notes, /协议不一致/);

  // 明文 key 只出现在 keys 映射里，绝不在渠道对象上
  assert.deepEqual(plan.keys, { [c1.id]: "sk-aaa", [c2.id]: "sk-bbb" });
  for (const ch of plan.channels) {
    assert.equal(ch.key, undefined);
    assert.equal(ch.apiKey, undefined);
  }

  // 模型目标：每个渠道 2 个
  assert.equal(plan.targets.length, 4);
  assert.equal(plan.summary.newTargets, 4);
  assert.equal(plan.targets[0].channelId, c1.id);
  assert.equal(plan.targets[0].source, "newapi-token");
});

test("编排：重复导入幂等——渠道 upsert 不重复建，模型目标不重复加", () => {
  const args = {
    tokens: [{ id: 1, name: "测试-默认", group: "default", status: 1 }],
    keys: { 1: "sk-aaa" },
    pricing: PRICING,
    userGroup: "default",
    base: "https://relay.test",
  };
  const first = buildTokenImportPlan({ ...args, existingChannels: [], existingTargets: [] });
  const second = buildTokenImportPlan({
    ...args,
    existingChannels: first.channels,
    existingTargets: first.targets,
  });
  assert.equal(second.channels.length, 1, "同一令牌不该建出第二个渠道");
  assert.equal(second.targets.length, first.targets.length, "模型目标不该重复追加");
  assert.equal(second.summary.imported, 0);
  assert.equal(second.summary.updated, 1);
  assert.equal(second.summary.newTargets, 0);
  assert.equal(second.channels[0].createdAt, first.channels[0].createdAt, "创建时间要保留");
});

test("编排：命中已存在渠道时保留其 id，模型目标不会成孤儿", () => {
  const localId = newapiTokenChannelLocalId("https://relay.test", 1);
  const existing = [{ id: localId, name: "旧名", baseUrl: "https://relay.test", createdAt: "2020-01-01T00:00:00.000Z" }];
  const plan = buildTokenImportPlan({
    tokens: [{ id: 1, name: "测试-新名", group: "default", status: 1 }],
    keys: {},
    pricing: PRICING,
    userGroup: "default",
    base: "https://relay.test",
    existingChannels: existing,
    existingTargets: [],
  });
  assert.equal(plan.channels.length, 1);
  assert.equal(plan.channels[0].id, localId);
  assert.equal(plan.channels[0].name, "测试-新名", "元信息要更新");
  assert.equal(plan.channels[0].createdAt, "2020-01-01T00:00:00.000Z");
  for (const t of plan.targets) assert.equal(t.channelId, localId);
});

test("编排：无分组 / 分组下无模型 / 协议混合都要计数上报", () => {
  const plan = buildTokenImportPlan({
    tokens: [
      { id: 1, name: "测试-无分组", group: "", status: 1 },
      { id: 2, name: "测试-空分组", group: "nonexistent", status: 1 },
      { id: 3, name: "测试-混合", group: "vip", status: 1 },
    ],
    keys: {},
    pricing: [
      { model_name: "claude-a", enable_groups: ["vip"] },
      { model_name: "gpt-4o", enable_groups: ["vip"] },
    ],
    userGroup: "", // 用户分组也空 -> 令牌 1 真的没分组
    base: "https://relay.test",
    existingChannels: [],
    existingTargets: [],
  });
  assert.equal(plan.summary.noGroup, 1);
  assert.equal(plan.summary.noModels, 2, "无分组的和分组下没模型的都算");
  assert.equal(plan.summary.mixedProtocol, 1);
});

test("编排：keys 映射按数字或字符串键都能取到明文", () => {
  const plan = buildTokenImportPlan({
    tokens: [{ id: 7, name: "测试", group: "default", status: 1 }],
    keys: { 7: "sk-str" }, // 后端 JSON 解析回来是字符串键
    pricing: PRICING,
    userGroup: "default",
    base: "https://relay.test",
    existingChannels: [],
    existingTargets: [],
  });
  assert.equal(Object.values(plan.keys)[0], "sk-str");
});

test("编排：无令牌时返回空计划而非崩", () => {
  const plan = buildTokenImportPlan({});
  assert.deepEqual(plan.channels, []);
  assert.deepEqual(plan.targets, []);
  assert.deepEqual(plan.keys, {});
  assert.equal(plan.summary.total, 0);
});
