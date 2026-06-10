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
