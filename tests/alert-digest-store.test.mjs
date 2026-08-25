// tests/alert-digest-store.test.mjs
// 报警汇总的配置与待发队列：默认值、归一化、入队/取空/回填的原子性、溢出裁剪。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadDigestConfig,
  updateDigestConfig,
  loadQueue,
  enqueueAlert,
  enqueueRun,
  drainQueue,
  removeAlertsByRule,
  jobInDigestScope,
  requeue,
  MAX_QUEUE_ENTRIES,
  __setDigestFilesForTest,
  __resetDigestChainsForTest,
} from "../server/alert-digest-store.mjs";

test.afterEach(() => {
  __resetDigestChainsForTest();
});

function withTempFiles(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ar-digest-"));
  const config = join(dir, "alert-digest-config.json");
  const queue = join(dir, "alert-digest-queue.json");
  __setDigestFilesForTest({ config, queue });
  return Promise.resolve(fn({ dir, config, queue })).finally(() => {
    __setDigestFilesForTest({});
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
}

// —— 配置 ——

test("默认配置：关闭 + 每天 09:07（避开整点）", async () => {
  await withTempFiles(async () => {
    const cfg = await loadDigestConfig();
    assert.equal(cfg.enabled, false, "默认必须关闭——装了新版本的现有用户行为不该变");
    assert.equal(cfg.cron, "7 9 * * *");
    assert.equal(cfg.lastDigestAt, null);
    assert.equal(cfg.nextDigestAt, null);
  });
});

test("配置归一化：enabled 只认 true，脏 cron 落回默认", async () => {
  await withTempFiles(async ({ config }) => {
    writeFileSync(config, JSON.stringify({ enabled: "yes", cron: "   ", lastDigestAt: 123 }));
    const cfg = await loadDigestConfig();
    assert.equal(cfg.enabled, false, "字符串 'yes' 不是 true，不该当启用");
    assert.equal(cfg.cron, "7 9 * * *");
    assert.equal(cfg.lastDigestAt, null, "非字符串时间戳应落 null");
  });
});

test("配置坏 JSON → 回默认，不抛错", async () => {
  await withTempFiles(async ({ config }) => {
    writeFileSync(config, "{ 这不是 json");
    const cfg = await loadDigestConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.cron, "7 9 * * *");
  });
});

test("updateDigestConfig：读改写往返", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((cfg) => {
      cfg.enabled = true;
      cfg.cron = "30 8 * * 1-5";
      cfg.nextDigestAt = "2026-09-01T00:30:00.000Z";
      return null;
    });
    const cfg = await loadDigestConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.cron, "30 8 * * 1-5");
    assert.equal(cfg.nextDigestAt, "2026-09-01T00:30:00.000Z");
  });
});

// —— 队列 ——

test("空队列 → { alerts: [], runs: [] }", async () => {
  await withTempFiles(async () => {
    assert.deepEqual(await loadQueue(), { alerts: [], runs: [] });
  });
});

test("enqueueAlert / enqueueRun 各自累积，互不干扰", async () => {
  await withTempFiles(async () => {
    await enqueueAlert({ ruleId: "r1", ruleName: "成功率低", targetId: "p1", targetLabel: "模型A", reason: "成功率 50%" });
    await enqueueRun({ targetId: "p1", targetLabel: "模型A", testType: "stability", successRate: 0.5, p95TotalMs: 9000 });
    const q = await loadQueue();
    assert.equal(q.alerts.length, 1);
    assert.equal(q.runs.length, 1);
    assert.equal(q.alerts[0].ruleName, "成功率低");
    assert.equal(q.runs[0].successRate, 0.5);
    assert.ok(q.alerts[0].at, "入队应带时间戳");
  });
});

// 批量稳定性一次运行有 N 个 target，各自命中会并发调 enqueue —— 非串行的读改写会丢报警。
test("并发入队 20 条：一条不丢（串行化生效）", async () => {
  await withTempFiles(async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => enqueueAlert({ ruleId: `r${i}`, ruleName: `规则${i}` })));
    const q = await loadQueue();
    assert.equal(q.alerts.length, 20, "并发入队不得互相覆盖");
  });
});

test("并发混合入队（alerts + runs 交错）：两边都不丢", async () => {
  await withTempFiles(async () => {
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => enqueueAlert({ ruleId: `r${i}` })),
      ...Array.from({ length: 10 }, (_, i) => enqueueRun({ targetId: `p${i}` })),
    ]);
    const q = await loadQueue();
    assert.equal(q.alerts.length, 10);
    assert.equal(q.runs.length, 10);
  });
});

test("drainQueue：取走内容并清空，一次原子操作", async () => {
  await withTempFiles(async () => {
    await enqueueAlert({ ruleId: "r1" });
    await enqueueRun({ targetId: "p1" });
    const taken = await drainQueue();
    assert.equal(taken.alerts.length, 1);
    assert.equal(taken.runs.length, 1);
    const after = await loadQueue();
    assert.deepEqual(after, { alerts: [], runs: [] }, "取完必须清空");
  });
});

// 发信失败时必须回填，否则一次 SMTP 抖动就把这批报警永久吞掉。
test("requeue：发信失败后内容放回队列头部（比现有的更旧）", async () => {
  await withTempFiles(async () => {
    await enqueueAlert({ ruleId: "old" });
    const taken = await drainQueue();
    await enqueueAlert({ ruleId: "new" }); // 发信期间新来的
    await requeue(taken);
    const q = await loadQueue();
    assert.deepEqual(
      q.alerts.map((a) => a.ruleId),
      ["old", "new"],
      "回填的旧内容应排在新内容之前",
    );
  });
});

test("requeue 空内容 → 不动队列", async () => {
  await withTempFiles(async () => {
    await enqueueAlert({ ruleId: "r1" });
    await requeue({ alerts: [], runs: [] });
    await requeue(null);
    assert.equal((await loadQueue()).alerts.length, 1);
  });
});

// 上限存在的理由：SMTP 持续故障时队列只增不减，会把配置盘写爆、并让汇总信长到发不出去。
test(`溢出裁剪：超过 ${MAX_QUEUE_ENTRIES} 条丢最旧的，保留最新`, async () => {
  await withTempFiles(async ({ queue }) => {
    // 直接写盘造一个接近上限的队列，避免逐条 await 上千次（慢且没必要）
    const alerts = Array.from({ length: MAX_QUEUE_ENTRIES }, (_, i) => ({ at: "2026-08-01T00:00:00.000Z", ruleId: `r${i}` }));
    writeFileSync(queue, JSON.stringify({ alerts, runs: [] }));
    await enqueueAlert({ ruleId: "newest" });
    const q = await loadQueue();
    assert.equal(q.alerts.length, MAX_QUEUE_ENTRIES, "不得超过上限");
    assert.equal(q.alerts.at(-1).ruleId, "newest", "最新的必须在");
    assert.equal(q.alerts[0].ruleId, "r1", "最旧的 r0 应被丢掉");
  });
});

test("requeue 也受上限约束（回填不得撑爆队列）", async () => {
  await withTempFiles(async ({ queue }) => {
    const existing = Array.from({ length: MAX_QUEUE_ENTRIES }, (_, i) => ({ ruleId: `cur${i}` }));
    writeFileSync(queue, JSON.stringify({ alerts: existing, runs: [] }));
    await requeue({ alerts: [{ ruleId: "back1" }, { ruleId: "back2" }], runs: [] });
    const q = await loadQueue();
    assert.equal(q.alerts.length, MAX_QUEUE_ENTRIES);
  });
});

// 兼容：早期若落过纯数组形状的队列文件，升级后不能崩、也不该丢内容。
test("队列文件是纯数组（早期形状）→ 当成 alerts 读回", async () => {
  await withTempFiles(async ({ queue }) => {
    writeFileSync(queue, JSON.stringify([{ ruleId: "legacy" }]));
    const q = await loadQueue();
    assert.equal(q.alerts.length, 1);
    assert.equal(q.alerts[0].ruleId, "legacy");
    assert.deepEqual(q.runs, []);
  });
});

test("队列坏 JSON / 非对象条目 → 过滤掉，不抛错", async () => {
  await withTempFiles(async ({ queue }) => {
    writeFileSync(queue, "{ 坏 json");
    assert.deepEqual(await loadQueue(), { alerts: [], runs: [] });
    writeFileSync(queue, JSON.stringify({ alerts: [null, "x", { ruleId: "ok" }], runs: null }));
    const q = await loadQueue();
    assert.equal(q.alerts.length, 1, "null/字符串条目应被过滤");
    assert.deepEqual(q.runs, []);
  });
});

// —— runs 按目标覆盖式记账 ——
// 【回归：吵闹渠道挤掉安静渠道】runs 自己有 500 条上限（与 alerts 各自独立计）、裁剪丢最旧的。
// 若 runs 追加式记账，一个每分钟一测的渠道会在一天里产生上千条，把其它渠道整个挤出汇总表。
// 实测：吵闹渠道 550 条 + 一个成功率仅 10% 的安静渠道 → 裁剪后安静渠道被挤光，
// 恰恰是最该被看到的那个消失了。改为按目标覆盖后，runs 条数上界 = 目标数，与测试频率无关。

test("enqueueRun：同一目标重复入队 → 覆盖而非追加，只留最后一次", async () => {
  await withTempFiles(async () => {
    await enqueueRun({ targetId: "p1", targetLabel: "模型A", successRate: 1, p95TotalMs: 30000 });
    await enqueueRun({ targetId: "p1", targetLabel: "模型A", successRate: 0.4, p95TotalMs: 90000 });
    const q = await loadQueue();
    assert.equal(q.runs.length, 1, "同一目标只留一条");
    assert.equal(q.runs[0].successRate, 0.4, "留的是最后一次");
    assert.equal(q.runs[0].p95TotalMs, 90000);
  });
});

test("enqueueRun：覆盖时累计 runCount（看得出本时段跑了几次）", async () => {
  await withTempFiles(async () => {
    for (let i = 0; i < 7; i += 1) await enqueueRun({ targetId: "p1", targetLabel: "模型A", successRate: 1 });
    const q = await loadQueue();
    assert.equal(q.runs.length, 1);
    assert.equal(q.runs[0].runCount, 7);
  });
});

test("enqueueRun：不同目标各占一条，互不覆盖", async () => {
  await withTempFiles(async () => {
    await enqueueRun({ targetId: "p1", targetLabel: "模型A", successRate: 1 });
    await enqueueRun({ targetId: "p2", targetLabel: "模型B", successRate: 1 });
    assert.equal((await loadQueue()).runs.length, 2);
  });
});

test("一个吵闹渠道刷 600 次，不得挤掉安静渠道（runs 上界 = 目标数）", async () => {
  await withTempFiles(async () => {
    await enqueueRun({ targetId: "quiet", targetLabel: "安静渠道", successRate: 0.1 });
    for (let i = 0; i < MAX_QUEUE_ENTRIES + 100; i += 1) {
      await enqueueRun({ targetId: "noisy", targetLabel: "吵闹渠道", successRate: 1 });
    }
    const q = await loadQueue();
    assert.equal(q.runs.length, 2, "条数上界应为目标数，不随测试频率增长");
    const quiet = q.runs.find((r) => r.targetId === "quiet");
    assert.ok(quiet, "成功率仅 10% 的安静渠道必须还在——它恰恰是最该被看到的");
    assert.equal(quiet.successRate, 0.1);
    assert.equal(q.runs.find((r) => r.targetId === "noisy").runCount, MAX_QUEUE_ENTRIES + 100);
  });
});

// —— 规则被删除时移除它的待发报警 ——
// 删除一条规则的含义是「别再就这件事提醒我」。留着的话，汇总信会在数小时后报出一条
// 【已经不存在的规则】，收件人按名字去页面上找会找不到；且这与删除时已有的
// clearRuleState（清冷却）不一致——既然冷却记录都清了，待发内容更该清。

test("removeAlertsByRule：只移除该规则的报警，其它规则不受影响", async () => {
  await withTempFiles(async () => {
    await enqueueAlert({ ruleId: "keep", ruleName: "留下" });
    await enqueueAlert({ ruleId: "drop", ruleName: "删掉" });
    await enqueueAlert({ ruleId: "drop", ruleName: "删掉" });
    const n = await removeAlertsByRule("drop");
    assert.equal(n, 2, "应报告移除 2 条");
    const q = await loadQueue();
    assert.deepEqual(
      q.alerts.map((a) => a.ruleId),
      ["keep"],
    );
  });
});

test("removeAlertsByRule：运行记录不动（runs 记的是跑了什么，与规则无关）", async () => {
  await withTempFiles(async () => {
    await enqueueAlert({ ruleId: "drop" });
    await enqueueRun({ targetId: "p1", targetLabel: "模型A", successRate: 0.5 });
    await removeAlertsByRule("drop");
    const q = await loadQueue();
    assert.equal(q.alerts.length, 0);
    assert.equal(q.runs.length, 1, "运行记录必须保留——汇总信仍要列出实测数字");
  });
});

test("removeAlertsByRule：无匹配 / 空 id → 返回 0，不报错", async () => {
  await withTempFiles(async () => {
    await enqueueAlert({ ruleId: "r1" });
    assert.equal(await removeAlertsByRule("不存在"), 0);
    assert.equal(await removeAlertsByRule(""), 0);
    assert.equal(await removeAlertsByRule(null), 0);
    assert.equal((await loadQueue()).alerts.length, 1, "都不该动到现有内容");
  });
});

// id 前缀相同的规则不该被波及（与 clearRuleState 的同类护栏对应）。
test("removeAlertsByRule：id 前缀相同的另一条规则不受影响", async () => {
  await withTempFiles(async () => {
    await enqueueAlert({ ruleId: "alr_1" });
    await enqueueAlert({ ruleId: "alr_12" });
    await removeAlertsByRule("alr_1");
    const q = await loadQueue();
    assert.deepEqual(
      q.alerts.map((a) => a.ruleId),
      ["alr_12"],
      "alr_12 不该被 alr_1 的清理波及",
    );
  });
});

// —— 按作业筛选汇总范围 ——
// 部分自动测试需要汇总、部分不需要。jobScope="all" 含日后新建的作业；
// "selected" 只认 jobIds 里的，其余仍命中即发信。
// 【最要紧的语义】不在汇总范围内 ≠ 不报警。取消勾选只是改变【送达方式】（攒着 → 立即发），
// 绝不是一个静默开关——否则用户会以为自己只是调整了节奏，实际关掉了监控。

test("默认 jobScope=all、jobIds 为空（现有用户升级后全部照旧汇总）", async () => {
  await withTempFiles(async () => {
    const cfg = await loadDigestConfig();
    assert.equal(cfg.jobScope, "all");
    assert.deepEqual(cfg.jobIds, []);
  });
});

test("jobScope 脏值 → 落回 all（宁可多汇总，不可因脏数据改变送达方式）", async () => {
  await withTempFiles(async ({ config }) => {
    writeFileSync(config, JSON.stringify({ enabled: true, jobScope: "bogus", jobIds: ["a"] }));
    assert.equal((await loadDigestConfig()).jobScope, "all");
  });
});

test("jobIds 去重、去空、非数组落空数组", async () => {
  await withTempFiles(async ({ config }) => {
    writeFileSync(config, JSON.stringify({ jobScope: "selected", jobIds: ["a", "a", "", "  b  ", null, "c"] }));
    assert.deepEqual((await loadDigestConfig()).jobIds, ["a", "b", "c"]);
    writeFileSync(config, JSON.stringify({ jobScope: "selected", jobIds: "不是数组" }));
    assert.deepEqual((await loadDigestConfig()).jobIds, []);
  });
});

test("jobInDigestScope：功能关闭 → 一律 false", () => {
  assert.equal(jobInDigestScope({ enabled: false, jobScope: "all" }, "atj_1"), false);
  assert.equal(jobInDigestScope(null, "atj_1"), false);
});

test("jobInDigestScope：all → 任何作业都进（含日后新建的）", () => {
  const cfg = { enabled: true, jobScope: "all", jobIds: [] };
  assert.equal(jobInDigestScope(cfg, "atj_1"), true);
  assert.equal(jobInDigestScope(cfg, "atj_从没见过的新作业"), true);
});

test("jobInDigestScope：selected → 只有列出的作业进", () => {
  const cfg = { enabled: true, jobScope: "selected", jobIds: ["atj_1", "atj_2"] };
  assert.equal(jobInDigestScope(cfg, "atj_1"), true);
  assert.equal(jobInDigestScope(cfg, "atj_3"), false, "没勾的作业不进汇总（但仍会立即发信）");
});

// 关键的保守取向：认不出是哪个作业时不攒。与「source 缺省视为手动」同一考虑——
// 宁可多发几封立即信，不可把报警攒进一个可能几小时后才发的队列。
test("jobInDigestScope：selected 且 jobId 为空 → 不进汇总（保守，立即发）", () => {
  const cfg = { enabled: true, jobScope: "selected", jobIds: ["atj_1"] };
  assert.equal(jobInDigestScope(cfg, ""), false);
  assert.equal(jobInDigestScope(cfg, undefined), false);
});

// all 模式下即使认不出作业也照样汇总：这与 selected 不同，因为 all 的语义是「不筛选」。
test("jobInDigestScope：all 且 jobId 为空 → 仍进汇总（all 就是不筛选）", () => {
  assert.equal(jobInDigestScope({ enabled: true, jobScope: "all" }, ""), true);
});

test("jobScope=all 时 jobIds 不参与判定（脏数据不影响）", () => {
  const cfg = { enabled: true, jobScope: "all", jobIds: ["只有这个"] };
  assert.equal(jobInDigestScope(cfg, "别的作业"), true);
});
