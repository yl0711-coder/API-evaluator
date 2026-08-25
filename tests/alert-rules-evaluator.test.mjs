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
import { updateRules, JITTER_KIND, DECLINE_KIND, __setRulesFileForTest, __resetWriteChainForTest } from "../server/alert-rules-store.mjs";
import {
  getLastFiredAt,
  markFired,
  __setRuleStateFileForTest,
  __resetRuleStateWriteChainForTest,
  __writeStateForTest,
} from "../server/alert-rule-state.mjs";
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
      kind: patch.kind || "threshold",
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
    if (patch.params) rule.params = patch.params;
    rules.push(rule);
    return rule;
  });
}

// 稳定性抖动规则。注意 addRule 走 updateRules → loadRules 会跑 normalizeRule，
// 未列出的子阈值会被规范化成 null（= 不检查该项），这正是我们要断言的行为。
async function addJitterRule(params, extra = {}) {
  return addRule({ kind: JITTER_KIND, name: "稳定性抖动", params, ...extra });
}

// 稳定性运行汇总的最小形状（只含抖动判定要用到的字段）。
function stabilityResult(fields) {
  return { profileId: "p1", profileName: "渠道A", model: "claude-sonnet-5", ...fields };
}

// 稳定性退化规则。窗口尺寸给默认值，判定阈值按需覆盖。
async function addDeclineRule(params, extra = {}) {
  return addRule({
    kind: DECLINE_KIND,
    name: "稳定性退化",
    params: { recentRuns: 3, baselineRuns: 20, ...params },
    ...extra,
  });
}

// 造一条历史 raw summary（注意：稳定性运行落库时【不带 type】，这正是 testTypeOf 要推断的形态）。
// endedAt 必填——toTrendPoint 靠它产出 at，无 at 的点会被 splitWindows 过滤掉。
function historyRun(i, { successRate = 1, p95 = 32000, extra = {} } = {}) {
  return {
    runId: `run-${i}`,
    profileId: "p1",
    endedAt: new Date(Date.UTC(2026, 7, 1, i)).toISOString(),
    successRate,
    p95TotalMs: p95,
    ...extra,
  };
}

// n 条“正常”历史 + 若干条“最近”历史，按时间升序（queryProfileRunSummaries 的既有口径）。
// 末尾即本次运行——persistTestRun 在 runner 内已 await，onRunComplete 在其后才触发。
function historySeries({ baseline = 20, recent = 3, baselineOpts = {}, recentOpts = {} } = {}) {
  const out = [];
  for (let i = 0; i < baseline; i++) out.push(historyRun(i, baselineOpts));
  for (let i = 0; i < recent; i++) out.push(historyRun(baseline + i, recentOpts));
  return out;
}

// scope=all 的规则在【立即发信模式】下，冷却状态记在 "all" 桶（无论哪个渠道触发），
// 不按 entry.targetId 分桶——全局规则的冷却是「全局共享」的，这是刻意的降噪设计而非疏漏，
// 故下面这批用例统一按 "all" 断言。
// 【汇总模式例外】那里的桶是 `all::<targetId>`（按渠道各算），理由见文件末尾「冷却桶」那组用例：
// 汇总反正只发一封信，共用桶不再省邮件，只会低报故障范围。
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

// 回归：lastFiredAt 落在「未来」（系统时钟被回拨/手改，或状态文件被外部写坏）时，
// 若按「还在冷却期内」处理，该规则会一直沉默到那个未来时刻真正到来——写入一年后的时间戳
// 就是整整一年不报警，恰是最危险的失声。故视为冷却已过并放行，markFired 随后把时间戳拉回当前、自愈。
test("冷却：lastFiredAt 在未来（时钟回拨）→ 放行而非永久沉默，且触发后时间戳被拉回当前", async () => {
  await withTempStores(async () => {
    const rule = await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, cooldownHours: 1 });
    // 手工把冷却状态写成一年后（绕过 markFired，模拟时钟异常/外部写坏）
    await markFired(rule.id, "all");
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    await __writeStateForTest({ [`${rule.id}::all`]: future });
    assert.equal(await getLastFiredAt(rule.id, "all"), future);

    let sent = 0;
    await evaluateAlertRules({ successRate: 0.1, profileId: "p1" }, { sendAlertMailFn: async () => sent++ });
    assert.equal(sent, 1, "未来时间戳不该把规则锁死");
    const after = await getLastFiredAt(rule.id, "all");
    assert.notEqual(after, future, "触发后应把时间戳拉回当前（自愈），而非保留未来值");
    assert.ok(new Date(after).getTime() <= Date.now(), "拉回后的时间戳不应仍在未来");
  });
});

test("冷却：lastFiredAt 是坏字符串 → NaN 比较恒 false，放行不误挡", async () => {
  await withTempStores(async () => {
    const rule = await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, cooldownHours: 1 });
    await markFired(rule.id, "all");
    await __writeStateForTest({ [`${rule.id}::all`]: "not-a-date" });
    let sent = 0;
    await evaluateAlertRules({ successRate: 0.1, profileId: "p1" }, { sendAlertMailFn: async () => sent++ });
    assert.equal(sent, 1);
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

// 回归：Number(null) === 0、Number("") === 0，两者都是有限数。取数时若不先挡掉 null/""，
// 「字段显式为 null」（如历史数据无该列）会被读成「真实测到 0」并触发报警——凭空报警。
// 上一条用的是【字段不存在】（undefined → Number(undefined) 是 NaN，恰好被 isFinite 挡住），
// 覆盖不到显式 null 这条路径，故单独钉住。
test("指标值显式为 null / 空串 → 不得被当成数值 0 而误报", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    await evaluateAlertRules({ type: "admission", profileId: "p1", successRate: null });
    assert.equal(await getLastFiredAt("alr_0", "all"), null, "successRate: null 不该被读成 0% 而命中");

    await addRule({ metric: "avgTotalMs", comparator: "lt", threshold: 100 });
    await evaluateAlertRules({ type: "admission", profileId: "p1", avgTotalMs: "" });
    assert.equal(await getLastFiredAt("alr_1", "all"), null, "avgTotalMs: '' 不该被读成 0ms 而命中");
  });
});

// 真实测到的 0 必须原样保留 —— 与上一条是一对：全败的运行成功率就是 0，
// 跟「没报出成功率」是两件事，不能因为防误报把真 0 也一起挡掉。
test("指标值真实为 0 → 照常参与比较（不能被当成缺测跳过）", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    await evaluateAlertRules({ type: "admission", profileId: "p1", successRate: 0 });
    assert.ok(await getLastFiredAt("alr_0", "all"), "全败运行（成功率 0）必须命中");
  });
});

// 回归：发信失败（如 SMTP 故障）不应计入冷却——否则整个冷却窗口内即使指标持续恶化也不会重试，
// 恰是最该报警却失声的场景。用注入的 sendAlertMailFn 模拟发信抛错。
test("发信失败 → 不 markFired，下一次评估仍会立即重试（不受冷却阻挡）", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, cooldownHours: 1 });
    let calls = 0;
    const failingSend = async () => {
      calls += 1;
      throw new Error("连接超时");
    };
    await evaluateAlertRules({ successRate: 0.1, profileId: "p1" }, { sendAlertMailFn: failingSend });
    assert.equal(calls, 1);
    assert.equal(await getLastFiredAt("alr_0", "all"), null, "发信失败不应记为已触发");

    // 立即再评估一次（模拟下一轮测试跑完）：不受冷却阻挡，应再次尝试发信。
    await evaluateAlertRules({ successRate: 0.05, profileId: "p1" }, { sendAlertMailFn: failingSend });
    assert.equal(calls, 2, "冷却未被假触发占用，第二次应再次尝试发信");
  });
});

// ===================== 稳定性抖动（复合规则） =====================
// 判定口径以用户提供的实测 CSV 为准：正常运行 P95÷P50 在 2.31～3.59× 之间，
// 异常那次是 P50 9844ms / P95 115552ms = 11.74×。阈值 6 应能区分开这两档。

test("抖动：P95÷P50 超过阈值 → 命中（实测异常值 11.74×，阈值 6）", async () => {
  await withTempStores(async () => {
    await addJitterRule({ jitterRatioMax: 6 });
    await evaluateAlertRules(stabilityResult({ p50TotalMs: 9844, p95TotalMs: 115552 }));
    assert.ok(await getLastFiredAt("alr_0", "all"), "11.74× 应越界");
  });
});

test("抖动：P95÷P50 在正常区间 → 不命中（实测中位数 3.23×，阈值 6）", async () => {
  await withTempStores(async () => {
    await addJitterRule({ jitterRatioMax: 6 });
    await evaluateAlertRules(stabilityResult({ p50TotalMs: 9587, p95TotalMs: 31297 }));
    assert.equal(await getLastFiredAt("alr_0", "all"), null, "3.26× 不应越界");
  });
});

test("抖动：恰好等于阈值 → 不命中（越界是「高于」，不含等于）", async () => {
  await withTempStores(async () => {
    await addJitterRule({ jitterRatioMax: 3 });
    await evaluateAlertRules(stabilityResult({ p50TotalMs: 10000, p95TotalMs: 30000 }));
    assert.equal(await getLastFiredAt("alr_0", "all"), null);
  });
});

// 回归：p50 为 0 时 p95/p50 = Infinity，会让任何阈值都判越界 —— 凭空报警。
test("抖动：p50 缺失或为 0 → 该项算不出，视为不检查，不误报", async () => {
  await withTempStores(async () => {
    await addJitterRule({ jitterRatioMax: 6 });
    await evaluateAlertRules(stabilityResult({ p95TotalMs: 115552 })); // 无 p50
    assert.equal(await getLastFiredAt("alr_0", "all"), null, "缺 p50 不应命中");

    await addJitterRule({ jitterRatioMax: 6 });
    await evaluateAlertRules(stabilityResult({ p50TotalMs: 0, p95TotalMs: 115552 }));
    assert.equal(await getLastFiredAt("alr_1", "all"), null, "p50=0 不应命中（Infinity 不算越界）");
  });
});

test("抖动：首次成功率低于下限 → 命中（successRate 被重试洗成 1.0 也照样抓得到）", async () => {
  await withTempStores(async () => {
    await addJitterRule({ firstAttemptSuccessRateMin: 0.9 });
    await evaluateAlertRules(stabilityResult({ successRate: 1, firstAttemptSuccessRate: 0.778 }));
    assert.ok(await getLastFiredAt("alr_0", "all"));
  });
});

test("抖动：首次成功率字段缺失（历史数据无 attempts）→ 该项跳过，不误报", async () => {
  await withTempStores(async () => {
    await addJitterRule({ firstAttemptSuccessRateMin: 0.9 });
    await evaluateAlertRules(stabilityResult({ successRate: 1, firstAttemptSuccessRate: null }));
    assert.equal(await getLastFiredAt("alr_0", "all"), null);
  });
});

test("抖动：重试额外等待超上限 → 命中；字段为 null 时跳过", async () => {
  await withTempStores(async () => {
    await addJitterRule({ retryOverheadP95MsMax: 5000 });
    await evaluateAlertRules(stabilityResult({ retryOverheadP95Ms: 8200 }));
    assert.ok(await getLastFiredAt("alr_0", "all"));

    await addJitterRule({ retryOverheadP95MsMax: 5000 });
    await evaluateAlertRules(stabilityResult({ retryOverheadP95Ms: null }));
    assert.equal(await getLastFiredAt("alr_1", "all"), null);
  });
});

test("抖动：多项同时越界 → 只发一封邮件，正文列出全部越界项", async () => {
  await withTempStores(async () => {
    await addJitterRule({ jitterRatioMax: 6, firstAttemptSuccessRateMin: 0.9 });
    const sent = [];
    await evaluateAlertRules(stabilityResult({ p50TotalMs: 9844, p95TotalMs: 115552, firstAttemptSuccessRate: 0.778 }), {
      sendAlertMailFn: async (_rule, _entry, reason) => sent.push(reason),
    });
    assert.equal(sent.length, 1, "两项越界也只该发一封");
    assert.match(sent[0], /耗时抖动 11\.74×/);
    assert.match(sent[0], /首次成功率 78%/);
    assert.match(sent[0], /判定不合格/);
  });
});

test("抖动：未配置的子阈值不出现在邮件正文里", async () => {
  await withTempStores(async () => {
    await addJitterRule({ jitterRatioMax: 6 }); // 只配抖动倍数
    const sent = [];
    await evaluateAlertRules(stabilityResult({ p50TotalMs: 9844, p95TotalMs: 115552, firstAttemptSuccessRate: 0.5 }), {
      sendAlertMailFn: async (_rule, _entry, reason) => sent.push(reason),
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /耗时抖动/);
    assert.doesNotMatch(sent[0], /首次成功率/, "该项没配就不该出现，哪怕数据本身很差");
  });
});

// 门禁：p50TotalMs / retryOverheadP95Ms 本就只有稳定性汇总才产出，但 firstAttemptSuccessRate 准入也有。
// 不门禁的话，一条名为「稳定性抖动」的规则会在准入运行上悄悄触发，违反直觉。
test("抖动：非稳定性类运行（准入/场景/快检）被门禁跳过，即便字段齐备", async () => {
  await withTempStores(async () => {
    await addJitterRule({ firstAttemptSuccessRateMin: 0.9 });
    await evaluateAlertRules({ type: "admission", profileId: "p1", firstAttemptSuccessRate: 0.5, p50TotalMs: 1000, p95TotalMs: 50000 });
    assert.equal(await getLastFiredAt("alr_0", "all"), null, "准入运行不应触发稳定性抖动规则");

    await addJitterRule({ firstAttemptSuccessRateMin: 0.9 });
    await evaluateAlertRules({ type: "quick-verify", profileId: "p1", firstAttemptSuccessRate: 0.5 });
    assert.equal(await getLastFiredAt("alr_1", "all"), null, "快检运行同样不应触发");
  });
});

test("抖动：批量稳定性（有 batchId）逐 results[] 条目评估", async () => {
  await withTempStores(async () => {
    await addJitterRule({ jitterRatioMax: 6 }, { scope: { type: "target", targetId: "p2" } });
    await evaluateAlertRules({
      batchId: "batch1",
      results: [
        { profileId: "p1", p50TotalMs: 10000, p95TotalMs: 30000 }, // 3× 正常
        { profileId: "p2", p50TotalMs: 9844, p95TotalMs: 115552 }, // 11.74× 越界
      ],
    });
    assert.ok(await getLastFiredAt("alr_0", "p2"), "p2 越界应命中");
    assert.equal(await getLastFiredAt("alr_0", "p1"), null, "规则只盯 p2");
  });
});

test("抖动：一项子阈值都没配的规则（脏数据绕过校验落盘）→ 永不命中，不抛错", async () => {
  await withTempStores(async () => {
    await addJitterRule({});
    await evaluateAlertRules(stabilityResult({ p50TotalMs: 1, p95TotalMs: 999999, firstAttemptSuccessRate: 0 }));
    assert.equal(await getLastFiredAt("alr_0", "all"), null);
  });
});

test("抖动规则与阈值规则共存：各自独立判定、独立冷却", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 }); // alr_0
    await addJitterRule({ jitterRatioMax: 6 }); // alr_1
    // 成功率 1.0（不命中阈值规则）但抖动 11.74×（命中抖动规则）
    await evaluateAlertRules(stabilityResult({ successRate: 1, p50TotalMs: 9844, p95TotalMs: 115552 }));
    assert.equal(await getLastFiredAt("alr_0", "all"), null, "成功率规则不该命中");
    assert.ok(await getLastFiredAt("alr_1", "all"), "抖动规则该命中");
  });
});

test("抖动：冷却期内不重复发信（整条规则共享一个冷却，不按子阈值分别计时）", async () => {
  await withTempStores(async () => {
    await addJitterRule({ jitterRatioMax: 6, firstAttemptSuccessRateMin: 0.9 }, { cooldownHours: 1 });
    const sent = [];
    const spy = async (_r, _e, reason) => sent.push(reason);
    await evaluateAlertRules(stabilityResult({ p50TotalMs: 9844, p95TotalMs: 115552 }), { sendAlertMailFn: spy });
    assert.equal(sent.length, 1);
    // 冷却期内换成另一项越界，也不该再发。
    await evaluateAlertRules(stabilityResult({ firstAttemptSuccessRate: 0.5 }), { sendAlertMailFn: spy });
    assert.equal(sent.length, 1, "冷却期内即使是不同子阈值越界，也共享同一个冷却");
  });
});

// ===================== 稳定性退化（与自身历史比） =====================
// 历史一律通过 opts.historyProviderFn 注入，不建库（DB 不可用时真实实现返回 []，
// 但注入能精确控制样本，且不受测试执行顺序/残留数据影响）。

test("退化：P95 中位数恶化超阈值 → 命中", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null });
    const history = historySeries({ baselineOpts: { p95: 32000 }, recentOpts: { p95: 95000 } });
    const sent = [];
    await evaluateAlertRules(stabilityResult({}), {
      historyProviderFn: async () => history,
      sendAlertMailFn: async (_r, _e, reason) => sent.push(reason),
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /P95 中位数从 32000ms（前 20 次）升到 95000ms（最近 3 次）/);
    assert.match(sent[0], /×2\.97/);
  });
});

test("退化：成功率中位数跌幅超阈值 → 命中（跌幅按绝对百分点）", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ successRateDropPp: 0.1, p95WorsenRatio: null });
    const history = historySeries({ baselineOpts: { successRate: 1 }, recentOpts: { successRate: 0.78 } });
    const sent = [];
    await evaluateAlertRules(stabilityResult({}), {
      historyProviderFn: async () => history,
      sendAlertMailFn: async (_r, _e, reason) => sent.push(reason),
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /成功率中位数从 100%（前 20 次）跌到 78%（最近 3 次），↓22pp，阈值 10pp/);
  });
});

test("退化：两窗口水平相当 → 不命中（这才是绝大多数情况）", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ successRateDropPp: 0.1, p95WorsenRatio: 1.5 });
    const history = historySeries({ baselineOpts: { p95: 32000 }, recentOpts: { p95: 33000 } });
    await evaluateAlertRules(stabilityResult({}), { historyProviderFn: async () => history });
    assert.equal(await getLastFiredAt("alr_0", "all"), null);
  });
});

test("退化：变好（P95 下降 / 成功率上升）绝不命中——只抓退化，不抓变化", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ successRateDropPp: 0.1, p95WorsenRatio: 1.5 });
    const history = historySeries({
      baselineOpts: { p95: 95000, successRate: 0.7 },
      recentOpts: { p95: 30000, successRate: 1 },
    });
    await evaluateAlertRules(stabilityResult({}), { historyProviderFn: async () => history });
    assert.equal(await getLastFiredAt("alr_0", "all"), null);
  });
});

test("退化：恰好等于阈值 → 命中（跌幅/倍数都是「达到即越界」）", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 2, successRateDropPp: null });
    const history = historySeries({ baselineOpts: { p95: 30000 }, recentOpts: { p95: 60000 } });
    await evaluateAlertRules(stabilityResult({}), { historyProviderFn: async () => history });
    assert.ok(await getLastFiredAt("alr_0", "all"), "恰好 2.00× 应命中");
  });
});

// 冷启动：历史还没攒够就判定，会拿两三个样本的中位数当基线，噪声直接变告警。
test("退化：历史样本不足（基线 < 5）→ 静默不判，不误报", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null });
    // 基线只有 4 条，低于 MIN_BASELINE_SAMPLES=5
    const history = historySeries({ baseline: 4, baselineOpts: { p95: 30000 }, recentOpts: { p95: 99000 } });
    await evaluateAlertRules(stabilityResult({}), { historyProviderFn: async () => history });
    assert.equal(await getLastFiredAt("alr_0", "all"), null, "样本不足时不该判定");
  });
});

test("退化：历史为空（新渠道第一次跑）→ 静默不判", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null });
    await evaluateAlertRules(stabilityResult({}), { historyProviderFn: async () => [] });
    assert.equal(await getLastFiredAt("alr_0", "all"), null);
  });
});

// 关键回归：批量稳定性的【聚合行】带 type:"batch-stability" 但无顶层 profileId，
// 而每个 target 的子运行落库时不带 type。若在趋势点上过滤类型（toTrendPoint 丢掉了 batchId），
// 聚合行会被误当成稳定性点混进基线，把基线中位数带偏。
test("退化：批量聚合行（有 type/batchId）不得混进基线", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null });
    const history = historySeries({ baselineOpts: { p95: 32000 }, recentOpts: { p95: 95000 } });
    // 掺入若干「聚合行」：P95 极低，若被算进基线会把基线拉低 → 恶化倍数变大 → 影响判定
    const polluted = [
      ...history.slice(0, 10),
      { runId: "agg-1", batchId: "b1", type: "batch-stability", endedAt: history[10].endedAt, successRate: 1, p95TotalMs: 100 },
      { runId: "agg-2", batchId: "b2", type: "batch-stability", endedAt: history[11].endedAt, successRate: 1, p95TotalMs: 100 },
      ...history.slice(10),
    ];
    const sent = [];
    await evaluateAlertRules(stabilityResult({}), {
      historyProviderFn: async () => polluted,
      sendAlertMailFn: async (_r, _e, reason) => sent.push(reason),
    });
    assert.equal(sent.length, 1);
    // 基线仍是 32000（20 条稳定性行的中位数），不被 100ms 的聚合行污染。
    assert.match(sent[0], /从 32000ms（前 20 次）/);
  });
});

test("退化：场景/准入历史行不混进基线（只认稳定性行）", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null });
    const history = historySeries({ baselineOpts: { p95: 32000 }, recentOpts: { p95: 95000 } });
    const mixed = [
      ...history.slice(0, 5),
      { runId: "sc-1", type: "scenario", endedAt: history[5].endedAt, successRate: 1, p95TotalMs: 300000 },
      { runId: "ad-1", type: "admission", endedAt: history[6].endedAt, successRate: 1, p95TotalMs: 9000 },
      ...history.slice(5),
    ];
    const sent = [];
    await evaluateAlertRules(stabilityResult({}), {
      historyProviderFn: async () => mixed,
      sendAlertMailFn: async (_r, _e, reason) => sent.push(reason),
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /从 32000ms（前 20 次）/, "场景 300s / 准入 9s 都不该进基线");
  });
});

test("退化：多维同时越界 → 只发一封，正文列出两项", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ successRateDropPp: 0.1, p95WorsenRatio: 1.5 });
    const history = historySeries({
      baselineOpts: { successRate: 1, p95: 32000 },
      recentOpts: { successRate: 0.78, p95: 95000 },
    });
    const sent = [];
    await evaluateAlertRules(stabilityResult({}), {
      historyProviderFn: async () => history,
      sendAlertMailFn: async (_r, _e, reason) => sent.push(reason),
    });
    assert.equal(sent.length, 1, "两维越界也只该发一封");
    assert.match(sent[0], /成功率中位数/);
    assert.match(sent[0], /P95 中位数/);
  });
});

test("退化：未配置的维不出现在邮件正文里", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null }); // 只配 P95
    const history = historySeries({
      baselineOpts: { successRate: 1, p95: 32000 },
      recentOpts: { successRate: 0.2, p95: 95000 }, // 成功率也很差，但该维没配
    });
    const sent = [];
    await evaluateAlertRules(stabilityResult({}), {
      historyProviderFn: async () => history,
      sendAlertMailFn: async (_r, _e, reason) => sent.push(reason),
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /P95 中位数/);
    assert.doesNotMatch(sent[0], /成功率中位数/, "该维没配就不该出现，哪怕数据很差");
  });
});

// 关键回归：曾经借 regression.mjs 的 toTrendPoint 做投影，而它用的是 isNum
// （Number.isFinite(Number(v))）—— Number(null)===0，于是 successRate: null（历史行没这一列）
// 被投影成 0。后果是实打实的误报：基线 1.0、最近几次缺测 → 算出「跌 100pp」并发信。
// 且缺测转 0 发生在进评估器之前，medianOf 里的 num() 届时已无从分辨真 0 与假 0。
// 现改为自己映射（declinePoint）保持 null。下面两条一正一反把这个边界钉住。
test("退化：基线有真实成功率、最近几次该字段缺测 → 不得报「跌 100pp」", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ successRateDropPp: 0.1, p95WorsenRatio: null });
    const history = historySeries({
      baselineOpts: { successRate: 1, p95: 32000 },
      recentOpts: { successRate: null, p95: 32000 },
    });
    const sent = [];
    await evaluateAlertRules(stabilityResult({}), {
      historyProviderFn: async () => history,
      sendAlertMailFn: async (_r, _e, reason) => sent.push(reason),
    });
    assert.equal(sent.length, 0, `缺测不该被投影成 0% 而误报，实际发了：${sent[0] || ""}`);
  });
});

test("退化：基线 P95 缺测、最近有值 → 不得因基线被当成 0 而误报（除零/凭空恶化）", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null });
    const history = historySeries({
      baselineOpts: { successRate: 1, p95: null },
      recentOpts: { successRate: 1, p95: 95000 },
    });
    const sent = [];
    await evaluateAlertRules(stabilityResult({}), {
      historyProviderFn: async () => history,
      sendAlertMailFn: async (_r, _e, reason) => sent.push(reason),
    });
    assert.equal(sent.length, 0, `基线缺测不该被投影成 0ms，实际发了：${sent[0] || ""}`);
  });
});

// 对照（与上面两条是一对）：真实测到的 0 必须照常参与判定。
// 全败的运行成功率就是 0，跟「没报出成功率」是两件事——不能因为防误报把真 0 一起挡掉。
test("退化：最近几次成功率真实为 0（全败）→ 必须命中", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ successRateDropPp: 0.1, p95WorsenRatio: null });
    const history = historySeries({
      baselineOpts: { successRate: 1, p95: 32000 },
      recentOpts: { successRate: 0, p95: 32000 },
    });
    const sent = [];
    await evaluateAlertRules(stabilityResult({}), {
      historyProviderFn: async () => history,
      sendAlertMailFn: async (_r, _e, reason) => sent.push(reason),
    });
    assert.equal(sent.length, 1, "真实的全败必须报");
    assert.match(sent[0], /跌到 0%（最近 3 次），↓100pp/);
  });
});

test("退化：某一维历史里全是缺测 → 该维跳过，不当成 0", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ successRateDropPp: 0.1, p95WorsenRatio: null });
    // 全部历史的 successRate 都是 null（历史数据没这一列）
    const history = historySeries({
      baselineOpts: { successRate: null, p95: 32000 },
      recentOpts: { successRate: null, p95: 95000 },
    });
    await evaluateAlertRules(stabilityResult({}), { historyProviderFn: async () => history });
    assert.equal(await getLastFiredAt("alr_0", "all"), null, "缺测不该被读成 0% 而命中");
  });
});

test("退化：基线 P95 为 0 → 不判该维（除以 0 得 Infinity，会凭空报警）", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null });
    const history = historySeries({ baselineOpts: { p95: 0 }, recentOpts: { p95: 95000 } });
    await evaluateAlertRules(stabilityResult({}), { historyProviderFn: async () => history });
    assert.equal(await getLastFiredAt("alr_0", "all"), null);
  });
});

// 门禁：与 jitter 同口径。
test("退化：非稳定性类运行（准入/场景/快检）不评估，且一次库都不查", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null });
    let queries = 0;
    const provider = async () => {
      queries += 1;
      return historySeries({ baselineOpts: { p95: 30000 }, recentOpts: { p95: 99000 } });
    };
    await evaluateAlertRules({ type: "admission", profileId: "p1", p95TotalMs: 99000 }, { historyProviderFn: provider });
    assert.equal(await getLastFiredAt("alr_0", "all"), null, "准入运行不该触发退化规则");
    assert.equal(queries, 0, "非稳定性类运行不该查库");
  });
});

// 懒查：没有启用的退化规则时，一次库都不该查（纯阈值/抖动用户的行为零变化）。
test("退化：没有启用的退化规则 → 完全不查库", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    await addJitterRule({ jitterRatioMax: 6 });
    let queries = 0;
    const provider = async () => {
      queries += 1;
      return [];
    };
    await evaluateAlertRules(stabilityResult({ successRate: 1, p50TotalMs: 10000, p95TotalMs: 30000 }), { historyProviderFn: provider });
    assert.equal(queries, 0, "只有阈值/抖动规则时不该查库");
  });
});

test("退化：停用的退化规则不触发查库", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5 }, { enabled: false });
    let queries = 0;
    await evaluateAlertRules(stabilityResult({}), {
      historyProviderFn: async () => {
        queries += 1;
        return [];
      },
    });
    assert.equal(queries, 0);
  });
});

// 批量稳定性：N 个 target × M 条规则，同一 target 的历史只该查一次
//（test_runs 无 profile_id 索引，是全表扫）。
test("退化：批量运行里同一 target 的历史只查一次（per-target 缓存）", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null }, { name: "退化A" });
    await addDeclineRule({ p95WorsenRatio: 2, successRateDropPp: null }, { name: "退化B" });
    const seen = [];
    await evaluateAlertRules(
      {
        batchId: "b1",
        results: [
          { profileId: "p1", p95TotalMs: 95000 },
          { profileId: "p2", p95TotalMs: 95000 },
        ],
      },
      {
        historyProviderFn: async (targetId) => {
          seen.push(targetId);
          return historySeries({ baselineOpts: { p95: 32000 }, recentOpts: { p95: 95000 } });
        },
        sendAlertMailFn: async () => {},
      },
    );
    // 2 个 target × 2 条规则 = 4 次判定，但只该查 2 次库。
    assert.deepEqual(seen, ["p1", "p2"], "每个 target 只查一次，不因多条规则重复查");
  });
});

// 关键回归：查库异常曾冒泡到最外层 try/catch，中断整个双层循环——后面所有规则（包括完全
// 不依赖数据库的阈值规则）都不再被评估，而"哪些规则受影响"取决于退化规则在数组里的位置。
// SQLITE_BUSY 在并发写时很常见，一次抖动不该让不相关的报警集体失声。两种顺序都要绿。
test("退化：查库抛错只让退化规则跳过，不连带吞掉其它规则（且与规则顺序无关）", async () => {
  for (const declineFirst of [false, true]) {
    await withTempStores(async () => {
      if (declineFirst) {
        await addDeclineRule({ successRateDropPp: 0.1, p95WorsenRatio: null });
        await addRule({ metric: "successRate", comparator: "lt", threshold: 0.9, name: "阈值规则" });
      } else {
        await addRule({ metric: "successRate", comparator: "lt", threshold: 0.9, name: "阈值规则" });
        await addDeclineRule({ successRateDropPp: 0.1, p95WorsenRatio: null });
      }
      const sent = [];
      await evaluateAlertRules(stabilityResult({ successRate: 0.5 }), {
        historyProviderFn: async () => {
          throw new Error("SQLITE_BUSY: database is locked");
        },
        sendAlertMailFn: async (rule) => sent.push(rule.name),
      });
      assert.deepEqual(sent, ["阈值规则"], `退化规则${declineFirst ? "在前" : "在后"}时，阈值规则都应照常报警`);
    });
  }
});

test("退化：查库失败在同一次评估内不重复重试（一次故障不放大成 N×M 次查询）", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null }, { name: "退化A" });
    await addDeclineRule({ p95WorsenRatio: 2, successRateDropPp: null }, { name: "退化B" });
    let calls = 0;
    await evaluateAlertRules(
      {
        batchId: "b1",
        results: [
          { profileId: "p1", p95TotalMs: 95000 },
          { profileId: "p2", p95TotalMs: 95000 },
        ],
      },
      {
        historyProviderFn: async () => {
          calls += 1;
          throw new Error("SQLITE_BUSY");
        },
      },
    );
    // 2 个 target × 2 条规则 = 4 次判定，但每个 target 只该尝试查一次（失败也缓存）。
    assert.equal(calls, 2, "失败结果也该缓存，不该每条规则各重试一次");
  });
});

test("退化：与阈值/抖动规则共存，各自独立判定", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 }); // alr_0
    await addJitterRule({ jitterRatioMax: 6 }); // alr_1
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null }); // alr_2
    const history = historySeries({ baselineOpts: { p95: 32000 }, recentOpts: { p95: 95000 } });
    // 成功率 1.0（阈值规则不中）、抖动 3×（抖动规则不中）、但 P95 相对历史恶化 2.97×（退化规则中）
    await evaluateAlertRules(stabilityResult({ successRate: 1, p50TotalMs: 31000, p95TotalMs: 95000 }), {
      historyProviderFn: async () => history,
      sendAlertMailFn: async () => {},
    });
    assert.equal(await getLastFiredAt("alr_0", "all"), null, "成功率规则不该中");
    assert.equal(await getLastFiredAt("alr_1", "all"), null, "抖动规则不该中（3.06× < 6×）");
    assert.ok(await getLastFiredAt("alr_2", "all"), "退化规则该中");
  });
});

test("退化：scope=target 只对指定目标生效", async () => {
  await withTempStores(async () => {
    await addDeclineRule({ p95WorsenRatio: 1.5, successRateDropPp: null }, { scope: { type: "target", targetId: "p2" } });
    const history = historySeries({ baselineOpts: { p95: 32000 }, recentOpts: { p95: 95000 } });
    await evaluateAlertRules(
      {
        batchId: "b1",
        results: [
          { profileId: "p1", p95TotalMs: 95000 },
          { profileId: "p2", p95TotalMs: 95000 },
        ],
      },
      { historyProviderFn: async () => history, sendAlertMailFn: async () => {} },
    );
    assert.equal(await getLastFiredAt("alr_0", "p1"), null);
    assert.ok(await getLastFiredAt("alr_0", "p2"));
  });
});

test("发信成功 → markFired；随后一次发信失败也不清空已有的冷却记录", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, cooldownHours: 1 });
    let shouldFail = false;
    const flakySend = async () => {
      if (shouldFail) throw new Error("连接超时");
    };
    await evaluateAlertRules({ successRate: 0.1, profileId: "p1" }, { sendAlertMailFn: flakySend });
    const firedAt = await getLastFiredAt("alr_0", "all");
    assert.ok(firedAt, "首次发信成功应记为已触发");

    shouldFail = true;
    await evaluateAlertRules({ successRate: 0.05, profileId: "p1" }, { sendAlertMailFn: flakySend });
    assert.equal(await getLastFiredAt("alr_0", "all"), firedAt, "冷却期内即使又尝试发信（且失败），触发时间也不应被覆盖或清空");
  });
});

// —— 汇总模式：定时自动测试的报警攒成一封，手动测试仍立即发信 ——
// 这批用例全部用注入的假入队函数，不碰 alert-digest-store 的真实文件。

// 收集器：替代真实的 enqueueAlert / enqueueRun / sendAlertMail，便于断言"走了哪条路"。
function makeSpies({ digestEnabled = false } = {}) {
  const alerts = [];
  const runs = [];
  const mails = [];
  return {
    alerts,
    runs,
    mails,
    opts: {
      digestConfigFn: async () => ({ enabled: digestEnabled }),
      enqueueAlertFn: async (e) => alerts.push(e),
      enqueueRunFn: async (e) => runs.push(e),
      sendAlertMailFn: async (rule, entry, reason) => mails.push({ rule: rule.name, reason }),
    },
  };
}

test("汇总关闭时：自动测试仍是命中即发信（旧行为完全不变）", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    const s = makeSpies({ digestEnabled: false });
    await evaluateAlertRules(stabilityResult({ successRate: 0.5 }), { source: "auto", ...s.opts });
    assert.equal(s.mails.length, 1, "汇总关闭 → 立即发信");
    assert.equal(s.alerts.length, 0, "不该入队");
  });
});

test("汇总开启时：自动测试的报警入队，不立即发信", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, name: "成功率过低" });
    const s = makeSpies({ digestEnabled: true });
    await evaluateAlertRules(stabilityResult({ successRate: 0.5 }), { source: "auto", ...s.opts });
    assert.equal(s.mails.length, 0, "汇总模式下不得逐条发信");
    assert.equal(s.alerts.length, 1);
    assert.equal(s.alerts[0].ruleName, "成功率过低");
    assert.equal(s.alerts[0].targetLabel, "claude-sonnet-5");
    assert.ok(s.alerts[0].reason, "入队条目必须带原因文本");
  });
});

// 你选定的口径：手动测试时人就在屏幕前，攒到几小时后再发没有意义。
test("手动测试即使开着汇总也立即发信（不进队列）", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    const s = makeSpies({ digestEnabled: true });
    await evaluateAlertRules(stabilityResult({ successRate: 0.5 }), { source: "manual", ...s.opts });
    assert.equal(s.mails.length, 1, "手动测试必须立即发信");
    assert.equal(s.alerts.length, 0);
    assert.equal(s.runs.length, 0, "手动测试也不记运行记录");
  });
});

test("source 缺省视为手动（保守：宁可立即发信，不可静默攒着）", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    const s = makeSpies({ digestEnabled: true });
    await evaluateAlertRules(stabilityResult({ successRate: 0.5 }), s.opts);
    assert.equal(s.mails.length, 1);
    assert.equal(s.alerts.length, 0);
  });
});

// 汇总信要附「本时段实测数字」，所以没命中报警的运行也必须记账。
test("汇总模式：没命中任何报警的运行也记进运行记录", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    const s = makeSpies({ digestEnabled: true });
    await evaluateAlertRules(stabilityResult({ successRate: 1, p95TotalMs: 30000 }), { source: "auto", ...s.opts });
    assert.equal(s.alerts.length, 0, "成功率 100% 不该报警");
    assert.equal(s.runs.length, 1, "但必须留下运行记录");
    assert.equal(s.runs[0].successRate, 1);
    assert.equal(s.runs[0].p95TotalMs, 30000);
  });
});

// 一条规则都没配时也要记运行记录，否则汇总信会说「本时段没有完成任何测试」——那是假话。
test("汇总模式：一条规则都没配，运行记录照样入队", async () => {
  await withTempStores(async () => {
    const s = makeSpies({ digestEnabled: true });
    await evaluateAlertRules(stabilityResult({ successRate: 1 }), { source: "auto", ...s.opts });
    assert.equal(s.runs.length, 1, "无规则也要记账，否则汇总信谎称没跑测试");
  });
});

test("汇总模式：批量运行的每个 target 各记一条运行记录", async () => {
  await withTempStores(async () => {
    const s = makeSpies({ digestEnabled: true });
    await evaluateAlertRules(
      {
        batchId: "b1",
        results: [
          { profileId: "p1", model: "模型A", successRate: 1, p95TotalMs: 30000 },
          { profileId: "p2", model: "模型B", successRate: 0.9, p95TotalMs: 40000 },
        ],
      },
      { source: "auto", ...s.opts },
    );
    assert.equal(s.runs.length, 2);
    assert.deepEqual(
      s.runs.map((r) => r.targetLabel),
      ["模型A", "模型B"],
    );
    assert.equal(s.runs[0].testType, "batch-stability");
  });
});

// 冷却语义在汇总模式下必须一致：入队成功才算"已交付"、才记冷却。
test("汇总模式：入队成功后记冷却，第二次命中被冷却拦住", async () => {
  await withTempStores(async () => {
    const rule = await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, cooldownHours: 1 });
    const s = makeSpies({ digestEnabled: true });
    await evaluateAlertRules(stabilityResult({ successRate: 0.5 }), { source: "auto", ...s.opts });
    assert.equal(s.alerts.length, 1);
    // 汇总模式下 scope=all 的桶是 `all::<targetId>`（按渠道各算），见下方「冷却桶」那组用例。
    assert.ok(await getLastFiredAt(rule.id, "all::p1"), "入队成功应记冷却");
    await evaluateAlertRules(stabilityResult({ successRate: 0.5 }), { source: "auto", ...s.opts });
    assert.equal(s.alerts.length, 1, "冷却期内不得重复入队");
  });
});

// 与「markFired 只在发信成功后才记」同一取向：入队失败不记冷却，下次立即重试。
test("汇总模式：入队抛错 → 不记冷却，下次命中立即重试", async () => {
  await withTempStores(async () => {
    const rule = await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    const s = makeSpies({ digestEnabled: true });
    let fail = true;
    const opts = {
      ...s.opts,
      enqueueAlertFn: async (e) => {
        if (fail) throw new Error("盘满");
        s.alerts.push(e);
      },
    };
    await evaluateAlertRules(stabilityResult({ successRate: 0.5 }), { source: "auto", ...opts });
    assert.equal(await getLastFiredAt(rule.id, "all"), null, "入队失败不得记冷却");
    fail = false;
    await evaluateAlertRules(stabilityResult({ successRate: 0.5 }), { source: "auto", ...opts });
    assert.equal(s.alerts.length, 1, "下次应能重试成功");
  });
});

// 读配置失败时的取向：宁可多发几封，不可静默丢报警。
test("读汇总配置抛错 → 退回立即发信（不静默丢报警）", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    const s = makeSpies({ digestEnabled: true });
    const opts = {
      ...s.opts,
      digestConfigFn: async () => {
        throw new Error("配置文件坏了");
      },
    };
    await evaluateAlertRules(stabilityResult({ successRate: 0.5 }), { source: "auto", ...opts });
    assert.equal(s.mails.length, 1, "读配置失败应退回立即发信");
    assert.equal(s.alerts.length, 0);
  });
});

// 运行记录入队失败不该妨碍报警本身入队（前者只是汇总信的附加信息）。
test("运行记录入队失败 → 报警仍照常入队", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8 });
    const s = makeSpies({ digestEnabled: true });
    const opts = {
      ...s.opts,
      enqueueRunFn: async () => {
        throw new Error("盘满");
      },
    };
    await evaluateAlertRules(stabilityResult({ successRate: 0.5 }), { source: "auto", ...opts });
    assert.equal(s.alerts.length, 1, "运行记录失败不该拖累报警入队");
  });
});

test("汇总模式：复合规则（抖动）的多行原因完整入队", async () => {
  await withTempStores(async () => {
    await addJitterRule({ jitterRatioMax: 6 });
    const s = makeSpies({ digestEnabled: true });
    await evaluateAlertRules(stabilityResult({ successRate: 1, p50TotalMs: 5000, p95TotalMs: 40000 }), { source: "auto", ...s.opts });
    assert.equal(s.alerts.length, 1);
    assert.equal(s.alerts[0].ruleKind, JITTER_KIND, "入队条目要带规则类型，汇总信据此显示标签");
    assert.match(s.alerts[0].reason, /抖动/);
  });
});

// —— scope=all 的冷却桶：两种模式各自的口径 ——
// 立即发信模式共用一个桶（"all"）是有意降噪：20 个渠道同时出问题不该一次发 20 封信。
// 汇总模式按渠道各算，因为那条取舍的前提变了——汇总反正只发一封，压掉其余渠道
// 不再节省任何邮件，只会让报警列表与标题【低报故障范围】。
// 实测（修前）：5 个渠道同时挂，报警列表只出现 1 条、标题写「1 个目标」。

const allBrokenBatch = {
  batchId: "b1",
  results: [
    { profileId: "p1", model: "模型A", successRate: 0.1 },
    { profileId: "p2", model: "模型B", successRate: 0.2 },
    { profileId: "p3", model: "模型C", successRate: 0.3 },
    { profileId: "p4", model: "模型D", successRate: 0.4 },
    { profileId: "p5", model: "模型E", successRate: 0.5 },
  ],
};

test("汇总模式 + scope=all：5 个渠道同时挂 → 入队 5 条（不低报故障范围）", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, scope: { type: "all" } });
    const s = makeSpies({ digestEnabled: true });
    await evaluateAlertRules(allBrokenBatch, { source: "auto", ...s.opts });
    assert.equal(s.alerts.length, 5, "每个出问题的渠道都该各占一条");
    assert.deepEqual(
      s.alerts.map((a) => a.targetLabel),
      ["模型A", "模型B", "模型C", "模型D", "模型E"],
    );
  });
});

test("立即发信模式 + scope=all：仍共用一个冷却桶，只发 1 封（降噪口径不变）", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, scope: { type: "all" } });
    const s = makeSpies({ digestEnabled: false });
    await evaluateAlertRules(allBrokenBatch, { source: "auto", ...s.opts });
    assert.equal(s.mails.length, 1, "立即模式不得因本次改动变成 5 封");
  });
});

test("汇总模式 + scope=all：冷却按渠道各自计时，第二轮全被拦住", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, scope: { type: "all" }, cooldownHours: 1 });
    const s = makeSpies({ digestEnabled: true });
    await evaluateAlertRules(allBrokenBatch, { source: "auto", ...s.opts });
    assert.equal(s.alerts.length, 5);
    await evaluateAlertRules(allBrokenBatch, { source: "auto", ...s.opts });
    assert.equal(s.alerts.length, 5, "冷却期内不得重复入队");
  });
});

// 只有部分渠道恢复时，仍在挂的那些不该被已恢复渠道的冷却影响（各自独立记账的直接体现）。
test("汇总模式 + scope=all：某渠道恢复后，新出问题的渠道照样能报", async () => {
  await withTempStores(async () => {
    await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, scope: { type: "all" }, cooldownHours: 1 });
    const s = makeSpies({ digestEnabled: true });
    // 第一轮：只有 p1 挂
    await evaluateAlertRules(
      { batchId: "b1", results: [{ profileId: "p1", model: "模型A", successRate: 0.1 }] },
      { source: "auto", ...s.opts },
    );
    assert.equal(s.alerts.length, 1);
    // 第二轮：p1 仍挂（冷却拦住）+ p2 新挂（该报）
    await evaluateAlertRules(
      {
        batchId: "b2",
        results: [
          { profileId: "p1", model: "模型A", successRate: 0.1 },
          { profileId: "p2", model: "模型B", successRate: 0.2 },
        ],
      },
      { source: "auto", ...s.opts },
    );
    assert.equal(s.alerts.length, 2, "p2 是新故障，不该被 p1 的冷却压掉");
    assert.equal(s.alerts[1].targetLabel, "模型B");
  });
});

// 两种模式的冷却桶不互通：切换开关后各自按自己的口径重新计时。
test("两种模式的冷却桶不互通（切换开关不会互相压制首条报警）", async () => {
  await withTempStores(async () => {
    const rule = await addRule({ metric: "successRate", comparator: "lt", threshold: 0.8, scope: { type: "all" }, cooldownHours: 24 });
    // 先在立即模式下触发，占用 "all" 桶
    const s1 = makeSpies({ digestEnabled: false });
    await evaluateAlertRules({ profileId: "p1", model: "模型A", successRate: 0.1 }, { source: "auto", ...s1.opts });
    assert.equal(s1.mails.length, 1);
    assert.ok(await getLastFiredAt(rule.id, "all"), "立即模式用 all 桶");

    // 切到汇总模式：不该被 "all" 桶的 24 小时冷却压掉
    const s2 = makeSpies({ digestEnabled: true });
    await evaluateAlertRules({ profileId: "p1", model: "模型A", successRate: 0.1 }, { source: "auto", ...s2.opts });
    assert.equal(s2.alerts.length, 1, "汇总模式首条报警不该被立即模式攒下的冷却压掉");
    assert.ok(await getLastFiredAt(rule.id, "all::p1"), "汇总模式用 all::<targetId> 桶");
  });
});

// scope=target 的规则不受本次改动影响（它本来就按 targetId 记账）。
test("scope=target 的冷却桶不受影响（两种模式都用 targetId）", async () => {
  await withTempStores(async () => {
    const rule = await addRule({
      metric: "successRate",
      comparator: "lt",
      threshold: 0.8,
      scope: { type: "target", targetId: "p1" },
    });
    const s = makeSpies({ digestEnabled: true });
    await evaluateAlertRules({ profileId: "p1", model: "模型A", successRate: 0.1 }, { source: "auto", ...s.opts });
    assert.equal(s.alerts.length, 1);
    assert.ok(await getLastFiredAt(rule.id, "p1"), "应仍用裸 targetId 作桶");
    assert.equal(await getLastFiredAt(rule.id, "all::p1"), null);
  });
});
