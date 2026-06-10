import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "run-targets-test-"));
process.env.EVALUATOR_DATA_DIR = dataDir;
process.env.EVALUATOR_SECRET_STORE = "memory";

const db = await import("../server/db.mjs");
const sqliteOk = await db.isSqliteAvailable();
const channelStore = await import("../server/channel-store.mjs");
const targetStore = await import("../server/model-target-store.mjs");
const profileStore = await import("../server/profile-store.mjs");
const { loadRunnableProfiles } = await import("../server/run-targets.mjs");

test("loadRunnableProfiles：模型目标解析 + 跳过已迁移老 profile + 保留孤儿老 profile", async () => {
  if (!sqliteOk) return;
  const channel = {
    id: "chA", name: "渠道A", provider: "P", baseUrl: "https://a.test",
    apiKeyRef: "profile:chA:api-key", hasKey: true, protocol: "openai_chat",
    maxTokens: 512, timeoutMs: 60000, status: "enabled",
  };
  await channelStore.saveChannels([channel]);
  await targetStore.saveModelTargets([{ id: "t1", channelId: "chA", model: "gpt-4o" }]);
  // 老 profile：一个 id 与渠道相同（模拟已迁移，应被跳过），一个孤儿（应保留）
  await profileStore.saveProfiles([
    { id: "chA", name: "老A", role: "target", baseUrl: "https://a.test", protocol: "openai_chat", defaultModel: "gpt-4o", apiKeyRef: "profile:chA:api-key", hasKey: true },
    { id: "orphan", name: "孤儿渠道", role: "target", baseUrl: "https://o.test", protocol: "openai_compatible", defaultModel: "m-x", apiKeyRef: "profile:orphan:api-key", hasKey: true },
  ]);

  const list = await loadRunnableProfiles();
  const ids = list.map((x) => x.id).sort();
  // 期望：模型目标 t1（解析）+ 孤儿 profile；老 profile "chA" 被跳过（已被渠道覆盖），无重复
  assert.deepEqual(ids, ["orphan", "t1"]);
  const resolved = list.find((x) => x.id === "t1");
  assert.equal(resolved.defaultModel, "gpt-4o");
  assert.equal(resolved.name, "渠道A / gpt-4o");
  assert.equal(resolved.baseUrl, "https://a.test");
});

test("loadRunnableProfiles：渠道缺失的模型目标被过滤", async () => {
  if (!sqliteOk) return;
  await channelStore.saveChannels([]);
  await targetStore.saveModelTargets([{ id: "t2", channelId: "ghost", model: "m" }]);
  await profileStore.saveProfiles([]);
  const list = await loadRunnableProfiles();
  assert.equal(list.find((x) => x.id === "t2"), undefined); // 渠道不存在 -> 不可运行
});
