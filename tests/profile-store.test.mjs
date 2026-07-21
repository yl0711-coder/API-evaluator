import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("profiles never persist or export real API keys", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "evaluator-profile-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  process.env.EVALUATOR_SECRET_STORE = "memory";

  try {
    const paths = await import(`../server/paths.mjs?case=${Date.now()}`);
    const profileStore = await import(`../server/profile-store.mjs?case=${Date.now()}`);
    const secretStore = await import("../server/secret-store.mjs");
    const realKey = "sk-test-secret-123456";
    const profile = await profileStore.normalizeProfile({
      id: "profile-a",
      role: "target",
      name: "Test API",
      provider: "ExampleVendor",
      baseUrl: "https://api.example.com/",
      apiKey: realKey,
      protocol: "openai_compatible",
      defaultModel: "gpt-test",
    });

    await profileStore.saveProfiles([profile]);
    // 配置存 SQLite model_configs 共享目录（不再是 profiles.json）
    const reloaded = await profileStore.loadProfiles();
    const saved = reloaded.find((item) => item.id === "profile-a");
    assert.ok(saved, "保存后应能从共享目录读回配置");
    assert.equal(Object.hasOwn(saved, "apiKey"), false);
    assert.equal(saved.apiKeyRef, "profile:profile-a:api-key");
    assert.equal(saved.hasKey, true);
    // 持久化层绝不含明文 Key（读底层 db 文件二进制断言）
    const dbBuf = await readFile(join(dataDir, "evaluator.db")).catch(() => Buffer.from(""));
    assert.equal(dbBuf.includes(realKey), false);

    assert.equal(await secretStore.readProfileApiKey(profile), realKey);

    const masked = profileStore.maskProfile(saved);
    assert.equal(masked.apiKey, "已安全保存");

    const exported = profileStore.exportProfile(saved);
    assert.equal(exported.apiKey, "");
    assert.equal(Object.hasOwn(exported, "apiKeyRef"), false);
    assert.equal(Object.hasOwn(exported, "keyStorage"), false);
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    delete process.env.EVALUATOR_SECRET_STORE;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("imported profiles do not trust external api key references", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "evaluator-profile-import-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  process.env.EVALUATOR_SECRET_STORE = "memory";

  try {
    const profileStore = await import(`../server/profile-store.mjs?case=import-${Date.now()}`);
    const imported = await profileStore.normalizeImportedProfiles({
      profiles: [
        {
          id: "external-profile",
          role: "target",
          name: "External API",
          provider: "Vendor",
          baseUrl: "https://api.example.com",
          apiKeyRef: "profile:external-profile:api-key",
          keyStorage: "macos-keychain",
          hasKey: true,
          protocol: "openai_compatible",
          defaultModel: "model-a",
        },
      ],
    });

    assert.equal(imported[0].apiKeyRef, "");
    assert.equal(imported[0].keyStorage, "");
    assert.equal(imported[0].hasKey, false);

    const existing = {
      id: "external-profile",
      apiKeyRef: "profile:external-profile:api-key",
      keyStorage: "test-memory-vault",
      hasKey: true,
    };
    const importedExisting = await profileStore.normalizeImportedProfiles(
      {
        profiles: [
          {
            id: "external-profile",
            role: "target",
            name: "External API",
            provider: "Vendor",
            baseUrl: "https://api.example.com",
            apiKeyRef: "attacker-ref",
            keyStorage: "macos-keychain",
            hasKey: true,
            protocol: "openai_compatible",
            defaultModel: "model-a",
          },
        ],
      },
      [existing],
    );

    assert.equal(importedExisting[0].apiKeyRef, existing.apiKeyRef);
    assert.equal(importedExisting[0].keyStorage, existing.keyStorage);
    assert.equal(importedExisting[0].hasKey, true);
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    delete process.env.EVALUATOR_SECRET_STORE;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("profiles support trusted baseline role", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "evaluator-profile-baseline-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  process.env.EVALUATOR_SECRET_STORE = "memory";

  try {
    const profileStore = await import(`../server/profile-store.mjs?case=baseline-${Date.now()}`);
    const profile = await profileStore.normalizeProfile({
      id: "baseline-api",
      role: "baseline",
      name: "Official Baseline",
      provider: "Official",
      baseUrl: "https://api.example.com",
      apiKey: "sk-test-secret-123456",
      protocol: "openai_compatible",
      defaultModel: "model-a",
    });

    assert.equal(profile.role, "baseline");
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    delete process.env.EVALUATOR_SECRET_STORE;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("profiles keep optional token unit prices for cost reports", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "evaluator-profile-cost-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  process.env.EVALUATOR_SECRET_STORE = "memory";

  try {
    const profileStore = await import(`../server/profile-store.mjs?case=cost-${Date.now()}`);
    const costing = await import(`../server/costing.mjs?case=cost-${Date.now()}`);
    const profile = await profileStore.normalizeProfile({
      id: "priced-api",
      role: "target",
      name: "Priced API",
      provider: "ExampleVendor",
      baseUrl: "https://api.example.com",
      apiKey: "sk-test-secret-123456",
      protocol: "openai_compatible",
      defaultModel: "model-a",
      inputPricePerMTokens: "4.5",
      outputPricePerMTokens: "22.5",
      inputSellPricePerMTokens: "5",
      outputSellPricePerMTokens: "25",
    });

    assert.equal(profile.inputPricePerMTokens, 4.5);
    assert.equal(profile.outputPricePerMTokens, 22.5);
    assert.equal(profile.inputSellPricePerMTokens, 5);
    assert.equal(profile.outputSellPricePerMTokens, 25);
    assert.equal(
      costing.estimateProfileRunCost(profile, {
        inputTokens: 1000,
        outputTokens: 2000,
      }),
      0.0495,
    );
    assert.deepEqual(
      costing.estimateProfileRunEconomics(profile, {
        inputTokens: 1000,
        outputTokens: 2000,
      }),
      {
        estimatedCost: 0.0495,
        estimatedRevenue: 0.055,
        estimatedGrossProfit: 0.0055,
        estimatedGrossMargin: 0.1,
      },
    );
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    delete process.env.EVALUATOR_SECRET_STORE;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});
