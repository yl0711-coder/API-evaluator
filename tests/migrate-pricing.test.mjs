import assert from "node:assert/strict";
import test from "node:test";

import { applyPricingMigration } from "../server/migrate-pricing.mjs";

test("applyPricingMigration：把渠道现值复制到旧形状模型目标", () => {
  const channels = [
    {
      id: "c1",
      maxTokens: 1024,
      timeoutMs: 120000,
      inputPricePerMTokens: 3,
      outputPricePerMTokens: 15,
      inputSellPricePerMTokens: 5,
      outputSellPricePerMTokens: 25,
    },
    { id: "c2" }, // 渠道没配任何参数/单价
  ];
  const targets = [
    { id: "t1", channelId: "c1", model: "a" }, // 旧形状：无 maxTokens
    { id: "t2", channelId: "c2", model: "b" }, // 旧形状：渠道也没值 → 落默认
  ];
  const { migrated } = applyPricingMigration(targets, channels);
  assert.equal(migrated, 2);
  assert.deepEqual(
    {
      maxTokens: targets[0].maxTokens,
      timeoutMs: targets[0].timeoutMs,
      input: targets[0].inputPricePerMTokens,
      sellOut: targets[0].outputSellPricePerMTokens,
    },
    { maxTokens: 1024, timeoutMs: 120000, input: 3, sellOut: 25 },
  );
  // 渠道无值 → 参数落默认，单价落 null。
  assert.equal(targets[1].maxTokens, 512);
  assert.equal(targets[1].timeoutMs, 300000);
  assert.equal(targets[1].inputPricePerMTokens, null);
});

test("applyPricingMigration：幂等——已带字段的目标不再改，二次运行 migrated=0", () => {
  const channels = [{ id: "c1", maxTokens: 1024 }];
  const targets = [{ id: "t1", channelId: "c1", model: "a" }];
  const first = applyPricingMigration(targets, channels);
  assert.equal(first.migrated, 1);
  assert.equal(targets[0].maxTokens, 1024);
  // 二次运行：t.maxTokens 已是数字 → 不命中「旧形状」。
  const second = applyPricingMigration(targets, channels);
  assert.equal(second.migrated, 0);
});

test("applyPricingMigration：无旧形状目标 → migrated=0、不动数据", () => {
  const targets = [{ id: "t1", channelId: "c1", model: "a", maxTokens: 512 }];
  const { migrated } = applyPricingMigration(targets, []);
  assert.equal(migrated, 0);
});
