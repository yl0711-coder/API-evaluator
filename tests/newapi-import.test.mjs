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
  const ch = mapNewapiChannel({
    id: 7,
    type: 1,
    name: "我的OpenAI",
    base_url: "",
    models: "gpt-4o, gpt-4o-mini",
    status: 1,
    key: "sk-zzz",
  });
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

  const claude = mapNewapiChannel({
    id: 9,
    type: 14,
    name: "Claude渠道",
    base_url: "https://relay.test/",
    models: "claude-sonnet-4-5",
    status: 2,
  });
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
    {
      id: localId,
      name: "我的渠道",
      provider: "DeepSeek",
      baseUrl: "https://up.test",
      protocol: "openai_compatible",
      models: ["m1", "m2"],
      status: "enabled",
      source: "manual",
      newapiChannelId: 44,
      apiKeyRef: "profile:" + localId + ":api-key",
      hasKey: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
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
  assert.equal(
    plan.targets.some((t) => t.model === "m3" && t.channelId === localId),
    true,
    "m3 挂在同一本地渠道下",
  );
});

test("buildImportPlan：标签已下线——导入不带入 new-api 标签、不动本地标签、汇总无 taggedTargets", () => {
  const rows = [{ id: 1, type: 1, name: "A", base_url: "https://a.test", models: "gpt-4o,claude", status: 1 }];
  // 已有本地渠道（含夺标得到的本地标签），导入后本地标签应原样保留。
  const existingChannels = [
    {
      id: "newapi-1",
      name: "A",
      protocol: "openai_compatible",
      models: ["gpt-4o"],
      status: "enabled",
      source: "newapi",
      newapiChannelId: 1,
    },
  ];
  const existingTargets = [{ id: "tx", channelId: "newapi-1", model: "gpt-4o", tags: ["本地夺标"], source: "newapi" }];
  const plan = buildImportPlan({ rows, existingChannels, existingTargets });

  const tx = plan.targets.find((t) => t.id === "tx");
  assert.deepEqual(tx.tags, ["本地夺标"], "已有模型的本地标签原样保留");
  // 新导入的模型目标不带任何标签字段（标签纯本地、由用户/夺标产生）。
  const claude = plan.targets.find((t) => t.channelId === "newapi-1" && t.model === "claude");
  assert.equal(claude.tags, undefined, "新导入模型目标不含 new-api 标签");
  assert.equal("taggedTargets" in plan.summary, false, "汇总不再含 taggedTargets");
});

// —— 本轮自查发现：这条链路（读 new-api channels 表、直连上游厂商）原本也是
// {...prev, ...mapped} 全量覆盖，与另两条导入链路同一个 bug。它由 POST /api/channels/import
// 和 POST /api/channels/:id/sync-models 两个端点使用，是三条链路里最老、用得最多的一条。
// 实测过的症状：用户改的渠道名、协议、手加的模型、填的 provider、写的备注，每次重新导入全被冲掉。
const ROW = {
  id: 11,
  name: "上游渠道A",
  base_url: "https://api.upstream.test",
  key: "sk-up-1",
  models: "gpt-4o,gpt-4o-mini",
  status: 1,
  type: 1,
};

test("重新导入：用户改过的名称/协议/模型/供应商/备注都不被推翻，summary 报 preserved", () => {
  const first = buildImportPlan({ rows: [ROW], existingChannels: [], existingTargets: [], syncModels: true });
  const ch = first.channels[0];
  assert.ok(ch.importSnapshot, "首次导入就要落快照，否则第二次会被当成老渠道走保守保留");

  const edited = {
    ...ch,
    name: "我改的名字",
    protocol: "claude_messages",
    models: [...ch.models, "我加的模型"],
    provider: "我填的供应商",
    notes: "我的备注：夜间才测",
  };
  const second = buildImportPlan({ rows: [ROW], existingChannels: [edited], existingTargets: [], syncModels: true });
  const s = second.channels[0];
  assert.equal(s.name, "我改的名字");
  assert.equal(s.protocol, "claude_messages");
  assert.ok(s.models.includes("我加的模型"), "手加的模型不能被抹掉");
  assert.equal(s.provider, "我填的供应商");
  assert.equal(s.notes, "我的备注：夜间才测");
  assert.equal(second.summary.preserved, 1, "要如实上报保留了几个渠道的手工修改");
});

test("重新导入：用户没改过时仍完全跟随上游（合并不能变成永不更新）", () => {
  const first = buildImportPlan({ rows: [ROW], existingChannels: [], existingTargets: [], syncModels: true });
  const renamed = { ...ROW, name: "上游改名了", models: "gpt-4o,gpt-4o-mini,gpt-5" };
  const second = buildImportPlan({ rows: [renamed], existingChannels: first.channels, existingTargets: first.targets, syncModels: true });
  const s = second.channels[0];
  assert.equal(s.name, "上游改名了", "上游改名要能同步");
  assert.ok(s.models.includes("gpt-5"), "上游新增的模型要能进来");
  assert.equal(second.summary.preserved, 0, "没有用户修改就不该报 preserved");
});

test("重新导入：模型目标按合并后的清单建，不把用户删掉的模型加回来", () => {
  const first = buildImportPlan({ rows: [ROW], existingChannels: [], existingTargets: [], syncModels: true });
  assert.equal(first.targets.length, 2);
  const edited = { ...first.channels[0], models: ["gpt-4o"] }; // 用户删掉 gpt-4o-mini
  const second = buildImportPlan({ rows: [ROW], existingChannels: [edited], existingTargets: [], syncModels: true });
  assert.deepEqual(
    second.targets.map((t) => t.model),
    ["gpt-4o"],
    "被用户删掉的模型不该重新长出模型目标",
  );
});

// syncModels=false 是 sync-models 端点之外的调用形态（只同步渠道、不动模型目标）。
// 此时仍要保护用户改过的模型清单，只是不建新目标。
test("syncModels=false 时仍保护用户改过的模型清单，且不建模型目标", () => {
  const first = buildImportPlan({ rows: [ROW], existingChannels: [], existingTargets: [], syncModels: true });
  const edited = { ...first.channels[0], models: ["gpt-4o", "我加的模型"] };
  const second = buildImportPlan({ rows: [ROW], existingChannels: [edited], existingTargets: [], syncModels: false });
  assert.ok(second.channels[0].models.includes("我加的模型"), "模型清单仍要走三方合并");
  assert.equal(second.summary.newTargets, 0, "syncModels=false 不建模型目标");
});
