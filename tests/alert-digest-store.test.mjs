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
// 【回归：吵闹渠道挤掉安静渠道】runs 与 alerts 共用 500 条上限、裁剪丢最旧的。
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
