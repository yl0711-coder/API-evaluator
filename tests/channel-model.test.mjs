import assert from "node:assert/strict";
import test from "node:test";

import {
  channelDedupKey,
  deterministicModelTargetId,
  migrateProfileToChannelAndTarget,
  modelTargetDedupKey,
  normalizeChannel,
  normalizeChannelStatus,
  normalizeModelList,
  normalizeModelTarget,
  resolveTestTarget,
} from "../server/channel-model.mjs";

test("normalizeModelList：数组/逗号串都接受，去空白去重保序（含全角逗号）", () => {
  assert.deepEqual(normalizeModelList(["gpt-4o", " gpt-4o ", "claude"]), ["gpt-4o", "claude"]);
  assert.deepEqual(normalizeModelList("gpt-4o, claude，deepseek-chat"), ["gpt-4o", "claude", "deepseek-chat"]);
  assert.deepEqual(normalizeModelList(""), []);
});

test("normalizeChannelStatus 只认 enabled/disabled，其它归 enabled", () => {
  assert.equal(normalizeChannelStatus("disabled"), "disabled");
  assert.equal(normalizeChannelStatus("enabled"), "enabled");
  assert.equal(normalizeChannelStatus("weird"), "enabled");
});

test("normalizeChannel：必填名称，默认值与价格/模型清单归一", () => {
  const ch = normalizeChannel({ name: "中转A", baseUrl: "https://api.x.com/", protocol: "openai_chat", models: "gpt-4o, gpt-4o" });
  assert.ok(ch.id);
  assert.equal(ch.name, "中转A");
  assert.equal(ch.baseUrl, "https://api.x.com"); // 去尾斜杠
  assert.equal(ch.protocol, "openai_chat");
  assert.equal(ch.maxTokens, 512);
  assert.equal(ch.timeoutMs, 60000);
  assert.deepEqual(ch.models, ["gpt-4o"]);
  assert.equal(ch.status, "enabled");
  assert.equal(ch.source, "manual");
  assert.throws(() => normalizeChannel({ baseUrl: "https://x" }), /渠道名称/);
});

test("normalizeChannel：编辑时沿用 existing 的创建时间与未传字段", () => {
  const existing = { id: "c1", name: "老", provider: "P", baseUrl: "https://a", protocol: "openai_compatible", maxTokens: 1024, timeoutMs: 120000, models: ["m1"], status: "disabled", source: "newapi", newapiChannelId: 7, createdAt: "2020-01-01T00:00:00.000Z" };
  const ch = normalizeChannel({ id: "c1", name: "新名" }, existing);
  assert.equal(ch.id, "c1");
  assert.equal(ch.name, "新名");
  assert.equal(ch.maxTokens, 1024);
  assert.equal(ch.status, "disabled");
  assert.equal(ch.source, "newapi");
  assert.equal(ch.newapiChannelId, 7);
  assert.equal(ch.createdAt, "2020-01-01T00:00:00.000Z");
});

test("normalizeModelTarget：必填 channelId + model", () => {
  const t = normalizeModelTarget({ channelId: "c1", model: "gpt-4o", note: "主力" });
  assert.equal(t.channelId, "c1");
  assert.equal(t.model, "gpt-4o");
  assert.equal(t.note, "主力");
  assert.throws(() => normalizeModelTarget({ model: "x" }), /渠道/);
  assert.throws(() => normalizeModelTarget({ channelId: "c1" }), /模型名/);
});

test("normalizeModelTarget：能力标签去空白/去重/保序", () => {
  const t = normalizeModelTarget({ channelId: "c1", model: "m", tags: ["  推理 ", "推理", "", "编程"] });
  assert.deepEqual(t.tags, ["推理", "编程"]);
});

test("normalizeModelTarget：编辑(全量覆盖)未带 tags → 沿用 existing，不被清空", () => {
  // 场景测验夺标得到的标签，编辑备注等操作不应清空它们（channel-model.mjs:90 的契约）。
  const t = normalizeModelTarget({ channelId: "c1", model: "m", note: "改备注" }, { id: "x", tags: ["推理", "编程"] });
  assert.deepEqual(t.tags, ["推理", "编程"]);
});

test("normalizeModelTarget：显式传 tags → 覆盖 existing；显式空数组 → 清空", () => {
  assert.deepEqual(
    normalizeModelTarget({ channelId: "c1", model: "m", tags: ["写作"] }, { tags: ["推理"] }).tags,
    ["写作"],
    "显式数组覆盖",
  );
  // 显式 [] 与「缺省 tags」语义不同：前者主动清空，后者保留——区分点是 Array.isArray(body.tags)。
  assert.deepEqual(
    normalizeModelTarget({ channelId: "c1", model: "m", tags: [] }, { tags: ["推理"] }).tags,
    [],
    "显式空数组清空",
  );
  assert.deepEqual(normalizeModelTarget({ channelId: "c1", model: "m" }).tags, [], "无 tags 无 existing → []");
});

test("判重键：渠道按 url+keyHash；模型目标按 channelId+model", () => {
  assert.equal(channelDedupKey({ baseUrl: "https://a/", keyHash: "h1" }), "https://a|h1");
  assert.equal(channelDedupKey({ baseUrl: "https://a", keyHash: "h2" }) === channelDedupKey({ baseUrl: "https://a", keyHash: "h1" }), false);
  assert.equal(modelTargetDedupKey({ channelId: "c1", model: "gpt-4o" }), "c1|gpt-4o");
});

test("resolveTestTarget：把渠道+模型还原成 profile 形状；无渠道→null", () => {
  const channel = { id: "c1", name: "中转A", provider: "P", baseUrl: "https://a", apiKeyRef: "profile:c1:api-key", hasKey: true, protocol: "openai_chat", maxTokens: 512, timeoutMs: 60000, status: "enabled" };
  const target = { id: "t1", channelId: "c1", model: "gpt-4o" };
  const resolved = resolveTestTarget(target, channel);
  assert.equal(resolved.id, "t1");
  assert.equal(resolved.name, "中转A / gpt-4o");
  assert.equal(resolved.baseUrl, "https://a");
  assert.equal(resolved.apiKeyRef, "profile:c1:api-key");
  assert.equal(resolved.protocol, "openai_chat");
  assert.equal(resolved.defaultModel, "gpt-4o"); // test-runner 读这个字段
  assert.equal(resolved.channelId, "c1");
  assert.equal(resolved.channelStatus, "enabled");
  assert.equal(resolveTestTarget(target, null), null);
});

test("deterministicModelTargetId：同 channel+model 稳定、不同则不同", () => {
  const a = deterministicModelTargetId("c1", "gpt-4o");
  assert.equal(a, deterministicModelTargetId("c1", "gpt-4o"));
  assert.notEqual(a, deterministicModelTargetId("c1", "gpt-4.1"));
  assert.match(a, /^mt_[0-9a-f]{16}$/);
});

test("migrateProfileToChannelAndTarget：老 profile → channel + target，复用 id 与 apiKeyRef", () => {
  const profile = {
    id: "p1", name: "老渠道", provider: "OpenAI", baseUrl: "https://api.openai.com",
    apiKeyRef: "profile:p1:api-key", keyStorage: "test-memory-vault", hasKey: true, keyHash: "abc",
    protocol: "openai_chat", defaultModel: "gpt-4o", maxTokens: 1024, timeoutMs: 60000,
    notes: "n", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-02-01T00:00:00.000Z",
  };
  const { channel, target } = migrateProfileToChannelAndTarget(profile);
  assert.equal(channel.id, "p1");                  // 复用 profile.id → apiKeyRef 不变
  assert.equal(channel.apiKeyRef, "profile:p1:api-key");
  assert.equal(channel.keyHash, "abc");
  assert.deepEqual(channel.models, ["gpt-4o"]);     // defaultModel 进 models 清单
  assert.equal(channel.status, "enabled");
  assert.equal(channel.createdAt, "2024-01-01T00:00:00.000Z");
  assert.equal(target.channelId, "p1");
  assert.equal(target.model, "gpt-4o");
  assert.equal(target.id, deterministicModelTargetId("p1", "gpt-4o")); // 可重复迁移不产生重复
  // 还原后应等价于原 profile 的运行所需字段
  const resolved = resolveTestTarget(target, { ...channel });
  assert.equal(resolved.baseUrl, profile.baseUrl);
  assert.equal(resolved.defaultModel, profile.defaultModel);
  assert.equal(resolved.protocol, profile.protocol);
});
