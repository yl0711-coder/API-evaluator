import assert from "node:assert/strict";
import test from "node:test";

import {
  buildImportPlan,
  mapNewapiChannel,
  mapNewapiStatus,
  newapiChannelLocalId,
  newapiTypeToProtocol,
} from "../server/newapi-import.mjs";

test("type -> 协议：14=Claude，其余 OpenAI 兼容", () => {
  assert.equal(newapiTypeToProtocol(14), "claude_messages");
  assert.equal(newapiTypeToProtocol(1), "openai_compatible");
  assert.equal(newapiTypeToProtocol(43), "openai_compatible");
});

test("status 映射：1=enabled，2/3=disabled", () => {
  assert.equal(mapNewapiStatus(1), "enabled");
  assert.equal(mapNewapiStatus(2), "disabled");
  assert.equal(mapNewapiStatus(3), "disabled");
});

test("mapNewapiChannel：字段映射 + 空 base_url 按 type 取默认 + 不含 key", () => {
  const ch = mapNewapiChannel({ id: 7, type: 1, name: "我的OpenAI", base_url: "", models: "gpt-4o, gpt-4o-mini", status: 1, key: "sk-zzz" });
  assert.equal(ch.id, newapiChannelLocalId(7));
  assert.equal(ch.id, "newapi-7");
  assert.equal(ch.provider, "OpenAI");
  assert.equal(ch.protocol, "openai_compatible");
  assert.equal(ch.baseUrl, "https://api.openai.com"); // 空 base_url -> 默认
  assert.deepEqual(ch.models, ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(ch.status, "enabled");
  assert.equal(ch.source, "newapi");
  assert.equal(ch.newapiChannelId, 7);
  assert.equal(ch.key, undefined); // 明文 key 绝不进渠道对象

  const claude = mapNewapiChannel({ id: 9, type: 14, name: "Claude渠道", base_url: "https://relay.test/", models: "claude-sonnet-4-5", status: 2 });
  assert.equal(claude.protocol, "claude_messages");
  assert.equal(claude.baseUrl, "https://relay.test"); // 去尾斜杠
  assert.equal(claude.status, "disabled");
});

test("buildImportPlan：首次导入建渠道+模型目标，key 单独收进 keys，禁用计数", () => {
  const rows = [
    { id: 1, type: 1, name: "A", base_url: "https://a.test", models: "gpt-4o,gpt-4o-mini", status: 1, key: "sk-a" },
    { id: 2, type: 14, name: "B", base_url: "https://b.test", models: "claude-sonnet-4-5", status: 2, key: "sk-b" },
  ];
  const plan = buildImportPlan({ rows, existingChannels: [], existingTargets: [] });
  assert.equal(plan.summary.imported, 2);
  assert.equal(plan.summary.disabled, 1); // B 禁用
  assert.equal(plan.channels.length, 2);
  assert.equal(plan.targets.length, 3); // 2 + 1 个模型
  // key 在 keys 映射里、不在渠道对象里
  assert.equal(plan.keys["newapi-1"], "sk-a");
  assert.equal(plan.keys["newapi-2"], "sk-b");
  assert.equal(JSON.stringify(plan.channels).includes("sk-a"), false);
});

test("buildImportPlan：重复导入幂等 —— upsert 渠道、保留凭证、不重复建模型目标", () => {
  const rows = [{ id: 1, type: 1, name: "A", base_url: "https://a.test", models: "gpt-4o", status: 1, key: "sk-a" }];
  const first = buildImportPlan({ rows, existingChannels: [], existingTargets: [] });
  // 模拟已存渠道带凭证（端点存 key 后的样子）
  const existingChannels = first.channels.map((c) => ({ ...c, apiKeyRef: "profile:newapi-1:api-key", keyHash: "hh", hasKey: true }));
  const existingTargets = first.targets;

  // 第二次导入：名称在 new-api 改了 + status 改禁用
  const rows2 = [{ id: 1, type: 1, name: "A改名", base_url: "https://a.test", models: "gpt-4o", status: 2, key: "sk-a" }];
  const second = buildImportPlan({ rows: rows2, existingChannels, existingTargets });
  assert.equal(second.summary.imported, 0);
  assert.equal(second.summary.updated, 1);
  assert.equal(second.summary.newTargets, 0); // 模型目标不重复
  assert.equal(second.channels.length, 1);
  assert.equal(second.targets.length, 1);
  const ch = second.channels[0];
  assert.equal(ch.name, "A改名"); // 同步了新名
  assert.equal(ch.status, "disabled"); // 同步了禁用
  assert.equal(ch.apiKeyRef, "profile:newapi-1:api-key"); // 凭证保留
  assert.equal(ch.keyHash, "hh");
});

test("buildImportPlan：已推送的本地渠道（UUID id + newapiChannelId）按 newapiChannelId 命中，不再重复建", () => {
  // 模拟：本地手动渠道推送到 new-api 后，本地 id 仍是 UUID、但带 newapiChannelId=44，且其下已有模型目标。
  const localId = "11111111-2222-3333-4444-555555555555";
  const existingChannels = [
    { id: localId, name: "我的渠道", provider: "DeepSeek", baseUrl: "https://up.test", protocol: "openai_compatible", models: ["m1", "m2"], status: "enabled", source: "manual", newapiChannelId: 44, apiKeyRef: "profile:" + localId + ":api-key", hasKey: true, createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  const existingTargets = [
    { id: "t-m1", channelId: localId, model: "m1", source: "manual" },
    { id: "t-m2", channelId: localId, model: "m2", source: "manual" },
  ];
  // 导入 new-api 渠道 44（同一渠道），含一个新模型 m3。
  const rows = [{ id: 44, type: 43, name: "我的渠道", base_url: "https://up.test", models: "m1,m2,m3", status: 1 }];
  const plan = buildImportPlan({ rows, existingChannels, existingTargets });

  assert.equal(plan.summary.imported, 0, "不应新建渠道");
  assert.equal(plan.summary.updated, 1, "应 upsert 已存在渠道");
  assert.equal(plan.channels.length, 1, "渠道不重复（仍 1 个）");
  assert.equal(plan.channels[0].id, localId, "保留本地 UUID id，不改成 newapi-44");
  assert.equal(plan.channels[0].apiKeyRef, "profile:" + localId + ":api-key", "凭证保留");
  // 模型目标：m1/m2 不重复，仅新增 m3
  assert.equal(plan.summary.newTargets, 1);
  assert.equal(plan.targets.length, 3);
  assert.equal(plan.targets.filter((t) => t.model === "m1").length, 1, "m1 不重复");
  assert.equal(plan.targets.some((t) => t.model === "m3" && t.channelId === localId), true, "m3 挂在同一本地渠道下");
});

test("buildImportPlan：标签已下线——导入不带入 new-api 标签、不动本地标签、汇总无 taggedTargets", () => {
  const rows = [{ id: 1, type: 1, name: "A", base_url: "https://a.test", models: "gpt-4o,claude", status: 1 }];
  // 已有本地渠道（含夺标得到的本地标签），导入后本地标签应原样保留。
  const existingChannels = [{ id: "newapi-1", name: "A", protocol: "openai_compatible", models: ["gpt-4o"], status: "enabled", source: "newapi", newapiChannelId: 1 }];
  const existingTargets = [{ id: "tx", channelId: "newapi-1", model: "gpt-4o", tags: ["本地夺标"], source: "newapi" }];
  const plan = buildImportPlan({ rows, existingChannels, existingTargets });

  const tx = plan.targets.find((t) => t.id === "tx");
  assert.deepEqual(tx.tags, ["本地夺标"], "已有模型的本地标签原样保留");
  // 新导入的模型目标不带任何标签字段（标签纯本地、由用户/夺标产生）。
  const claude = plan.targets.find((t) => t.channelId === "newapi-1" && t.model === "claude");
  assert.equal(claude.tags, undefined, "新导入模型目标不含 new-api 标签");
  assert.equal("taggedTargets" in plan.summary, false, "汇总不再含 taggedTargets");
});
