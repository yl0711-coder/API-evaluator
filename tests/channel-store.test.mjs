import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 先设 env 再动态 import：让 paths/db 用临时数据目录 + 内存密钥库（node --test 文件级进程隔离）。
const dataDir = mkdtempSync(join(tmpdir(), "channel-store-test-"));
process.env.EVALUATOR_DATA_DIR = dataDir;
process.env.EVALUATOR_SECRET_STORE = "memory";

const db = await import("../server/db.mjs");
const sqliteOk = await db.isSqliteAvailable();
const channelStore = await import("../server/channel-store.mjs");
const targetStore = await import("../server/model-target-store.mjs");
const profileStore = await import("../server/profile-store.mjs");
const secretStore = await import("../server/secret-store.mjs");
const { normalizeChannel, normalizeModelTarget, resolveTestTarget } = await import("../server/channel-model.mjs");

test("渠道存储往返 + 密钥进加密库 + mask 抹掉机密", async () => {
  if (!sqliteOk) return;
  let channel = normalizeChannel({ id: "c-rt", name: "中转A", baseUrl: "https://api.x.com", protocol: "openai_chat", models: "gpt-4o" });
  channel = await channelStore.attachChannelKey(channel, "sk-secret-xyz");
  await channelStore.saveChannels([channel]);

  const loaded = await channelStore.loadChannels();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "c-rt");
  assert.equal(loaded[0].apiKeyRef, secretStore.buildApiKeyRef("c-rt"));
  assert.ok(loaded[0].keyHash); // 单向指纹已存（判重用）

  // 明文 key 在加密库里能读回，但绝不在渠道记录里
  assert.equal(await channelStore.readChannelApiKey(loaded[0]), "sk-secret-xyz");
  assert.equal(JSON.stringify(loaded[0]).includes("sk-secret-xyz"), false);

  // 浏览器视图：抹掉 ref/hash，只给 hasKey + 占位
  const masked = channelStore.maskChannel(loaded[0]);
  assert.equal(masked.apiKeyRef, undefined);
  assert.equal(masked.keyHash, undefined);
  assert.equal(masked.hasKey, true);
  assert.equal(masked.apiKey, "已安全保存");
});

test("模型目标存储往返", async () => {
  if (!sqliteOk) return;
  const t1 = normalizeModelTarget({ channelId: "c-rt", model: "gpt-4o", note: "主力" });
  const t2 = normalizeModelTarget({ channelId: "c-rt", model: "gpt-4o-mini" });
  await targetStore.saveModelTargets([t1, t2]);
  const loaded = await targetStore.loadModelTargets();
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded.map((x) => x.model).sort(), ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(loaded.find((x) => x.model === "gpt-4o").note, "主力");
});

test("findDuplicateChannel：同 url+keyHash 判重", async () => {
  if (!sqliteOk) return;
  const existing = [{ id: "a", baseUrl: "https://api.x.com", keyHash: "h1" }];
  assert.equal((await channelStore.findDuplicateChannel(existing, { id: "b", baseUrl: "https://api.x.com/", keyHash: "h1" }))?.id, "a");
  assert.equal(await channelStore.findDuplicateChannel(existing, { id: "b", baseUrl: "https://api.x.com", keyHash: "h2" }), null);
});

test("一次性迁移：老 profile → 渠道+模型目标，复用 id 与密钥，可重复执行", async () => {
  if (!sqliteOk) return;
  // 清空渠道/目标（前面测试写过），制造“渠道为空”的迁移前置条件
  await channelStore.saveChannels([]);
  await targetStore.saveModelTargets([]);
  // 播一个带密钥的老 profile
  await secretStore.saveProfileApiKey("pmig", "sk-mig-123");
  await profileStore.saveProfiles([{
    id: "pmig", name: "老渠道", provider: "OpenAI", baseUrl: "https://api.openai.com",
    apiKeyRef: secretStore.buildApiKeyRef("pmig"), keyStorage: "test-memory-vault", hasKey: true,
    protocol: "openai_chat", defaultModel: "gpt-4o", maxTokens: 512, timeoutMs: 60000,
  }]);

  const result = await channelStore.migrateProfilesToChannelsIfEmpty();
  assert.equal(result.migrated, 1);

  const channels = await channelStore.loadChannels();
  const targets = await targetStore.loadModelTargets();
  const ch = channels.find((c) => c.id === "pmig");
  assert.ok(ch);
  assert.deepEqual(ch.models, ["gpt-4o"]);
  // 复用 id → 密钥 ref 不变，仍能读回明文
  assert.equal(await channelStore.readChannelApiKey(ch), "sk-mig-123");
  const tg = targets.find((t) => t.channelId === "pmig");
  assert.equal(tg.model, "gpt-4o");
  // 还原成 profile 形状可直接喂 test-runner
  const resolved = resolveTestTarget(tg, ch);
  assert.equal(resolved.baseUrl, "https://api.openai.com");
  assert.equal(resolved.defaultModel, "gpt-4o");

  // 再次迁移：渠道已存在 → 跳过，不重复
  const again = await channelStore.migrateProfilesToChannelsIfEmpty();
  assert.equal(again.migrated, 0);
  assert.equal(again.reason, "channels-exist");
});
