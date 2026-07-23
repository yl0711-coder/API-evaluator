// tests/alert-rules-evaluator.test.mjs
// evaluateAlertRules：六种运行结果形状的指标提取、范围匹配、阈值命中、冷却期抑制。
// 未配置 SMTP 时 sendAlertMail 静默早退（不发信、不抛错），但仍会 markFired ——
// 这一特性让我们能在不碰真实网络/nodemailer 的前提下，验证匹配/命中/冷却这条主链路。
// 真实发信路径（sendMail 参数拼装）已在 tests/mailer.test.mjs 用注入的 transportFactory 单独覆盖。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateAlertRules } from "../server/alert-rules-evaluator.mjs";
import { updateRules, __setRulesFileForTest, __resetWriteChainForTest } from "../server/alert-rules-store.mjs";
import { getLastFiredAt, __setRuleStateFileForTest, __resetRuleStateWriteChainForTest } from "../server/alert-rule-state.mjs";
import { __resetNotifyConfigCacheForTest } from "../server/notify-config.mjs";

test.afterEach(() => {
  __resetWriteChainForTest();
  __resetRuleStateWriteChainForTest();
  __resetNotifyConfigCacheForTest();
});

function withTempStores(fn) {
  const dir = mkdtempSync(join(tmpdir(), "are-"));
  __setRulesFileForTest(join(dir, "alert-rules.json"));
  __setRuleStateFileForTest(join(dir, "alert-rule-state.json"));
  return Promise.resolve(fn()).finally(() => {
    __setRulesFileForTest(null);
    __setRuleStateFileForTest(null);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
}

async function addRule(patch) {
  return updateRules((rules) => {
    const rule = {
      id: `alr_${rules.length}`,
      name: patch.name || "测试规则",
      enabled: patch.enabled !== false,
      scope: patch.scope || { type: "all" },
      metric: patch.metric,
      comparator: patch.comparator,
      threshold: patch.threshold,
      cooldownHours: patch.cooldownHours ?? 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    rules.push(rule);
    return rule;
  });
}

// scope=all 的规则冷却状态永远记在 "all" 桶（无论哪个渠道触发），不是按 entry.targetId 分桶——
// 全局规则的冷却是「全局共享」的，这是刻意设计而非疏漏，测试统一按 "all" 断言。
test("result 为空/非对象 → 不抛错、无副作用", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    await evaluateAlertRules(null);
    await evaluateAlertRules(undefined);
    await evaluateAlertRules("not an object");
    assert.equal(await getLastFiredAt("alr_0", "all"), null);
  });
});

test("无启用规则 → 不评估、不报错", async () => {
  await withTempStores(async () => {
    await evaluateAlertRules({ type: "admission", successRate: 0.1, profileId: "p1" });
    // 没有规则可命中，理应啥都没发生；断言不抛异常即通过。
    assert.ok(true);
  });
});

test("单结果类型（admission）：命中阈值 → markFired；未命中 → 不记账", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    await evaluateAlertRules({ type: "admission", successRate: 0.5, profileId: "p1" });
    assert.ok(await getLastFiredAt("alr_0", "all"), "0.5 < 0.8 应命中");

    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    await evaluateAlertRules({ type: "admission", successRate: 0.95, profileId: "p2" });
    assert.equal(await getLastFiredAt("alr_1", "all"), null, "0.95 不小于 0.8，不应命中");
  });
});

test("无 profileId 的单结果 → collectEntries 返回空，不评估", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    await evaluateAlertRules({ type: "admission", successRate: 0.1 });
    assert.equal(await getLastFiredAt("alr_0", "all"), null);
  });
});

test("stability（无 type 无 batchId）：走单结果分支", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    await evaluateAlertRules({ successRate: 0.3, profileId: "p1" });
    assert.ok(await getLastFiredAt("alr_0", "all"));
  });
});

test("batch-admission/batch-stability：逐 results[] 条目分别评估", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "grade", comparator: "eq", threshold: "F" });
    await evaluateAlertRules({
      batchId: "batch1",
      results: [
        { profileId: "p1", grade: "F" },
        { profileId: "p2", grade: "A" },
      ],
    });
    assert.ok(await getLastFiredAt("alr_0", "all"), "p1 是 F 级应命中");
  });
});

test("scenario：results[] 里每个 profileId 条目独立评估——只要有一条命中，全局规则的冷却桶即被标记", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "avgQualityScore", comparator: "lt", threshold: 60 });
    await evaluateAlertRules({
      type: "scenario",
      results: [
        { profileId: "p1", avgQualityScore: 45 },
        { profileId: "p2", avgQualityScore: 88 },
      ],
    });
    assert.ok(await getLastFiredAt("alr_0", "all"), "p1 触发应记入 all 桶");
  });
});

test("scenario：全部条目都不命中 → 完全不触发", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "avgQualityScore", comparator: "lt", threshold: 60 });
    await evaluateAlertRules({
      type: "scenario",
      results: [
        { profileId: "p1", avgQualityScore: 88 },
        { profileId: "p2", avgQualityScore: 90 },
      ],
    });
    assert.equal(await getLastFiredAt("alr_0", "all"), null);
  });
});

test("quick-verify：verdictLevel 等级序数比较", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "verdictLevel", comparator: "eq", threshold: "suspect" });
    await evaluateAlertRules({ type: "quick-verify", verdict: { level: "suspect" }, profileId: "p1" });
    assert.ok(await getLastFiredAt("alr_0", "all"));
  });
});

test("scope=target：只对指定 targetId 命中，其它渠道不触发", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, scope: { type: "target", targetId: "p1" } });
    await evaluateAlertRules({ successRate: 0.1, profileId: "p2" });
    assert.equal(await getLastFiredAt("alr_0", "p2"), null, "规则只盯 p1，p2 不应命中");
    await evaluateAlertRules({ successRate: 0.1, profileId: "p1" });
    assert.ok(await getLastFiredAt("alr_0", "p1"));
  });
});

test("scope=target 命中时 targetKey 用 targetId 而不是 'all'（与全局规则的冷却状态互不干扰）", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, scope: { type: "target", targetId: "p1" } });
    await evaluateAlertRules({ successRate: 0.1, profileId: "p1" });
    assert.equal(await getLastFiredAt("alr_0", "all"), null, "targetKey 应是 p1，不应写进 all 桶");
    assert.ok(await getLastFiredAt("alr_0", "p1"));
  });
});

test("禁用规则（enabled:false）不参与评估", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, enabled: false });
    await evaluateAlertRules({ successRate: 0.1, profileId: "p1" });
    assert.equal(await getLastFiredAt("alr_0", "p1"), null);
  });
});

test("冷却期内不重复触发；冷却期过后可再次触发", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, cooldownHours: 1 });
    await evaluateAlertRules({ successRate: 0.1, profileId: "p1" });
    const firstFiredAt = await getLastFiredAt("alr_0", "all");
    assert.ok(firstFiredAt);

    // 冷却期内（1 小时）再次命中 → 不应更新触发时间。
    await evaluateAlertRules({ successRate: 0.05, profileId: "p1" });
    assert.equal(await getLastFiredAt("alr_0", "all"), firstFiredAt, "冷却期内不应刷新触发时间");
  });
});

test("指标值缺失（undefined/null）→ 视为不满足，不误报", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "avgQualityScore", comparator: "lt", threshold: 60 });
    await evaluateAlertRules({ type: "admission", profileId: "p1", successRate: 0.99 }); // 没有 avgQualityScore 字段
    assert.equal(await getLastFiredAt("alr_0", "p1"), null);
  });
});
