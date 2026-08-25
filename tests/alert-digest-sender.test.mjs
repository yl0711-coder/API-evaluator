// tests/alert-digest-sender.test.mjs
// 汇总发信的时机与失败语义：到期判定、调度器忙时顺延（含顺延上限）、
// 「先推进节奏再发信」的顺序、发信失败/未配 SMTP 时把内容回填队列。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDigestDue, shouldDefer, maybeSendDigest, discardQueuedAlerts, MAX_DEFER_MS } from "../server/alert-digest-sender.mjs";
import {
  loadDigestConfig,
  updateDigestConfig,
  loadQueue,
  enqueueAlert,
  enqueueRun,
  __setDigestFilesForTest,
  __resetDigestChainsForTest,
} from "../server/alert-digest-store.mjs";
import { getLastFiredAt, markFired, __setRuleStateFileForTest, __resetRuleStateWriteChainForTest } from "../server/alert-rule-state.mjs";

test.afterEach(() => {
  __resetDigestChainsForTest();
  __resetRuleStateWriteChainForTest();
});

function withTempFiles(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ar-digest-send-"));
  __setDigestFilesForTest({ config: join(dir, "c.json"), queue: join(dir, "q.json") });
  // 冷却状态文件也隔离：discardQueuedAlerts 会清冷却，不隔离会写到真实 /data 下。
  __setRuleStateFileForTest(join(dir, "state.json"));
  return Promise.resolve(fn()).finally(() => {
    __setDigestFilesForTest({});
    __setRuleStateFileForTest(null);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
}

// —— 到期判定 ——

test("isDigestDue：功能关闭 → 永不到期", () => {
  assert.equal(isDigestDue({ enabled: false, nextDigestAt: "2000-01-01T00:00:00.000Z" }, Date.now()), false);
});

test("isDigestDue：nextDigestAt 缺失 → 视为立即到期（刚开启/迁移）", () => {
  assert.equal(isDigestDue({ enabled: true, nextDigestAt: null }, Date.now()), true);
});

test("isDigestDue：未到点 → false；已过点 → true", () => {
  const now = Date.parse("2026-08-25T09:00:00.000Z");
  assert.equal(isDigestDue({ enabled: true, nextDigestAt: "2026-08-25T09:07:00.000Z" }, now), false);
  assert.equal(isDigestDue({ enabled: true, nextDigestAt: "2026-08-25T08:07:00.000Z" }, now), true);
});

test("isDigestDue：坏时间戳 → 立即到期（不因脏数据永久沉默）", () => {
  assert.equal(isDigestDue({ enabled: true, nextDigestAt: "不是时间" }, Date.now()), true);
});

// —— 顺延 ——
// 自动测试默认串行（并发 1），一批 5 个渠道的稳定性测试要 20-30 分钟。
// 一到点就发会把同一批结果切成两封，正是汇总要避免的。

test("shouldDefer：调度器空闲 → 不顺延", () => {
  assert.equal(shouldDefer({ dueAtMs: Date.now(), nowMs: Date.now(), activeJobs: 0 }), false);
});

test("shouldDefer：调度器在忙且未超上限 → 顺延", () => {
  const due = Date.parse("2026-08-25T09:07:00.000Z");
  assert.equal(shouldDefer({ dueAtMs: due, nowMs: due + 10 * 60 * 1000, activeJobs: 1 }), true);
});

// 某个作业卡死在网络读取上时 activeJobs 会长期 > 0；没有上限的话汇总信永不发出。
test("shouldDefer：忙但已超顺延上限 → 强制发（宁可切两封，不可永不发信）", () => {
  const due = Date.parse("2026-08-25T09:07:00.000Z");
  assert.equal(shouldDefer({ dueAtMs: due, nowMs: due + MAX_DEFER_MS + 1000, activeJobs: 1 }), false);
});

// —— 完整流程 ——

test("未到期 → 什么都不做，队列不动", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.cron = "7 9 * * *";
      c.nextDigestAt = new Date(Date.now() + 3600_000).toISOString();
      return null;
    });
    await enqueueAlert({ ruleId: "r1" });
    let called = false;
    const r = await maybeSendDigest({
      sendMailFn: () => {
        called = true;
        return true;
      },
    });
    assert.equal(r.sent, false);
    assert.equal(r.reason, "not_due");
    assert.equal(called, false);
    assert.equal((await loadQueue()).alerts.length, 1, "未到期不该清队列");
  });
});

test("功能关闭 → 不发信（即使队列里有东西）", async () => {
  await withTempFiles(async () => {
    await enqueueAlert({ ruleId: "r1" });
    const r = await maybeSendDigest({ sendMailFn: () => true });
    assert.equal(r.sent, false);
    assert.equal(r.reason, "not_due");
  });
});

test("到期 + 调度器在忙 → 顺延，不发信也不清队列", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.nextDigestAt = new Date(Date.now() - 60_000).toISOString();
      return null;
    });
    await enqueueAlert({ ruleId: "r1" });
    const r = await maybeSendDigest({ sendMailFn: () => true, getActiveJobs: () => 2 });
    assert.equal(r.sent, false);
    assert.equal(r.reason, "deferred_scheduler_busy");
    assert.equal((await loadQueue()).alerts.length, 1, "顺延期间队列必须原样保留");
  });
});

test("到期 + 空闲 → 发一封、清空队列、推进 nextDigestAt", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.cron = "7 9 * * *";
      c.nextDigestAt = new Date(Date.now() - 60_000).toISOString();
      return null;
    });
    await enqueueAlert({ ruleId: "r1", ruleName: "成功率过低", targetLabel: "模型A" });
    await enqueueRun({ targetId: "p1", targetLabel: "模型A", successRate: 0.5 });

    const mails = [];
    const r = await maybeSendDigest({
      sendMailFn: (subject, body) => {
        mails.push({ subject, body });
        return true;
      },
      getActiveJobs: () => 0,
    });
    assert.equal(r.sent, true);
    assert.equal(r.alerts, 1);
    assert.equal(r.runs, 1);
    assert.equal(mails.length, 1, "必须只发一封");
    assert.match(mails[0].subject, /1 个目标 1 项报警/);
    assert.match(mails[0].body, /成功率过低/);

    const q = await loadQueue();
    assert.deepEqual(q, { alerts: [], runs: [] }, "发成功后队列应清空");
    const cfg = await loadDigestConfig();
    assert.ok(cfg.nextDigestAt, "必须推进到下一个时刻");
    assert.ok(Date.parse(cfg.nextDigestAt) > Date.now(), "下一个时刻必须在未来");
    assert.ok(cfg.lastDigestAt, "必须记下本次发信时刻");
  });
});

// 队列为空也要发 —— 这是本功能的核心承诺（「都没有报警也发一封」）。
test("队列为空也照发（收不到信只可能是发信坏了，不会是「都正常所以没发」）", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.nextDigestAt = new Date(Date.now() - 60_000).toISOString();
      return null;
    });
    const mails = [];
    const r = await maybeSendDigest({ sendMailFn: (s, b) => (mails.push({ s, b }), true), getActiveJobs: () => 0 });
    assert.equal(r.sent, true);
    assert.equal(mails.length, 1);
    assert.match(mails[0].s, /无新增报警/);
  });
});

// 发信失败绝不能吞掉报警：与单条报警「markFired 只在发信成功后才记」同一取向。
test("发信抛错 → 内容回填队列，下期重试", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.nextDigestAt = new Date(Date.now() - 60_000).toISOString();
      return null;
    });
    await enqueueAlert({ ruleId: "r1" });
    const r = await maybeSendDigest({
      sendMailFn: () => {
        throw new Error("SMTP 连接超时");
      },
      getActiveJobs: () => 0,
    });
    assert.equal(r.sent, false);
    assert.equal(r.reason, "send_failed");
    assert.equal((await loadQueue()).alerts.length, 1, "发信失败必须回填，不得丢报警");
  });
});

// 开着汇总但没配 SMTP 时，若清空队列，等配好后之前所有报警都已无声消失。
test("未配 SMTP（sendMailFn 返回 false）→ 内容回填队列", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.nextDigestAt = new Date(Date.now() - 60_000).toISOString();
      return null;
    });
    await enqueueAlert({ ruleId: "r1" });
    const r = await maybeSendDigest({ sendMailFn: () => false, getActiveJobs: () => 0 });
    assert.equal(r.sent, false);
    assert.equal(r.reason, "smtp_not_configured");
    assert.equal((await loadQueue()).alerts.length, 1);
  });
});

// 【回归】nextDigestAt 必须在发信【之前】推进。
// 反过来的话，一次发信耗时超过一个 tick（60s）时，下个 tick 会看到仍然到期的 nextDigestAt
// 而重复触发，收件人收到两封内容互补的残信。
test("发信期间再次触发 → 第二次判为未到期（节奏先推进，防重复发信）", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.cron = "7 9 * * *";
      c.nextDigestAt = new Date(Date.now() - 60_000).toISOString();
      return null;
    });
    await enqueueAlert({ ruleId: "r1" });

    let secondResult = null;
    const r = await maybeSendDigest({
      // 在「发信进行中」这一刻并发再调一次，模拟下一个 tick 撞进来
      sendMailFn: async () => {
        secondResult = await maybeSendDigest({ sendMailFn: () => true, getActiveJobs: () => 0 });
        return true;
      },
      getActiveJobs: () => 0,
    });
    assert.equal(r.sent, true);
    assert.equal(secondResult.sent, false, "并发的第二次不得也发出一封");
    assert.equal(secondResult.reason, "not_due");
  });
});

// 【回归：曾经每分钟一封】坏 cron 让 nextDigestAt 落 null，而 isDigestDue 把 null 当
// 「立即到期」——于是每个 tick 都发一封。实测 10 个 tick 发 10 封，一天 1440 封，
// 比「邮件太多」这个原始问题严重得多。端点已挡掉坏 cron，但手改配置文件仍能绕过。
test("cron 无可执行时刻 → 退化成 24 小时一封，绝不每 tick 一封", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.cron = "0 0 30 2 *"; // 2 月 30 日：永不存在
      c.nextDigestAt = new Date(Date.now() - 60_000).toISOString();
      return null;
    });
    let sent = 0;
    // 模拟连续 10 个 tick
    for (let i = 0; i < 10; i += 1) {
      await maybeSendDigest({
        sendMailFn: () => {
          sent += 1;
          return true;
        },
        getActiveJobs: () => 0,
      });
    }
    assert.equal(sent, 1, "10 个 tick 只该发 1 封");
    const cfg = await loadDigestConfig();
    assert.ok(cfg.nextDigestAt, "必须兜出一个时刻，不得留 null");
    const gapMs = Date.parse(cfg.nextDigestAt) - Date.now();
    assert.ok(gapMs > 23 * 3600 * 1000, `退化间隔应约 24 小时，实得 ${Math.round(gapMs / 3600000)} 小时`);
  });
});

// 退化而非停用：停用会让「每期必到」的心跳消失，于是「没收到信」重新变得有歧义——
// 那正是本功能要消除的东西。
test("cron 坏掉时仍保持启用（心跳不能断，否则「没收到信」重新有歧义）", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.cron = "0 0 30 2 *";
      c.nextDigestAt = new Date(Date.now() - 60_000).toISOString();
      return null;
    });
    await maybeSendDigest({ sendMailFn: () => true, getActiveJobs: () => 0 });
    assert.equal((await loadDigestConfig()).enabled, true, "不得自作主张停用");
  });
});

// —— 关闭汇总时处置队列 ——
// 【回归：关掉汇总会静默吞掉已攒的报警】maybeSendDigest 在功能关闭时直接早退，既不发也不清；
// 而这些报警入队时【已经记过冷却】（入队即视为已交付）。于是关掉汇总意味着它们永不送达、
// 且在冷却期内不会重报；日后重新开启还会让几周前的陈旧报警诈尸。实测两种症状都会出现。

test("discardQueuedAlerts：清空队列并清掉相关规则的冷却", async () => {
  await withTempFiles(async () => {
    await enqueueAlert({ ruleId: "r1", ruleName: "规则1" });
    await enqueueAlert({ ruleId: "r1", ruleName: "规则1" }); // 同一规则两条
    await enqueueAlert({ ruleId: "r2", ruleName: "规则2" });
    await enqueueRun({ targetId: "p1" });

    const cleared = [];
    const stat = await discardQueuedAlerts({ clearRuleStateFn: async (id) => cleared.push(id) });

    assert.deepEqual(stat, { alerts: 3, rules: 2 }, "应报告清了 3 条报警、涉及 2 条规则");
    assert.deepEqual(cleared.sort(), ["r1", "r2"], "每条涉及的规则都要清冷却，且去重");
    const q = await loadQueue();
    assert.deepEqual(q, { alerts: [], runs: [] }, "队列必须清空（runs 也一并清掉）");
  });
});

test("discardQueuedAlerts：队列为空 → 返回 null，不做无谓清理", async () => {
  await withTempFiles(async () => {
    const cleared = [];
    const stat = await discardQueuedAlerts({ clearRuleStateFn: async (id) => cleared.push(id) });
    assert.equal(stat, null);
    assert.deepEqual(cleared, [], "没有报警就不该动任何规则的冷却");
  });
});

// 只有运行记录、没有报警时也不该报告「清理了报警」。
test("discardQueuedAlerts：只有运行记录 → 返回 null", async () => {
  await withTempFiles(async () => {
    await enqueueRun({ targetId: "p1" });
    const stat = await discardQueuedAlerts({ clearRuleStateFn: async () => {} });
    assert.equal(stat, null);
  });
});

test("discardQueuedAlerts：缺 ruleId 的脏条目不参与清冷却，也不报错", async () => {
  await withTempFiles(async () => {
    await enqueueAlert({ ruleName: "无 id" }); // ruleId 为空
    const cleared = [];
    const stat = await discardQueuedAlerts({ clearRuleStateFn: async (id) => cleared.push(id) });
    assert.equal(stat.alerts, 1);
    assert.equal(stat.rules, 0);
    assert.deepEqual(cleared, []);
  });
});

// 清冷却是为了让下一次命中能立刻重新报警：验证清完之后冷却确实不再拦。
test("清完冷却后：同一规则的下次命中不再被冷却拦住", async () => {
  await withTempFiles(async () => {
    await markFired("r1", "all");
    assert.ok(await getLastFiredAt("r1", "all"), "先确认有冷却记录");
    await enqueueAlert({ ruleId: "r1" });
    await discardQueuedAlerts();
    assert.equal(await getLastFiredAt("r1", "all"), null, "冷却记录必须被清掉");
  });
});

// 【回归：并发 tick 各发一封】到期判定与推进节奏若不是一次原子操作，两个并发的 tick 会
// 都在对方写入之前读到同一个已到期的 nextDigestAt，于是各发一封。
// 实测两封还是互补的残信：第一封列出报警，第二封紧跟着说「本时段无新增报警」
// （队列已被第一封取空）—— 恰是本功能最该避免的观感。
// setInterval 不等上一个 tick 结束，长批次期间确实会有多个 tick 并行走到 onTickEnd，
// 而读配置是异步读盘，两个 tick 落在那个 await 的间隙里就会撞上。
test("并发两个 tick 同时到期 → 只发一封，另一个判 not_due", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.cron = "7 9 * * *";
      c.nextDigestAt = new Date(Date.now() - 60_000).toISOString();
      return null;
    });
    await enqueueAlert({ ruleId: "r1", ruleName: "规则1", targetId: "p1", targetLabel: "模型A", reason: "成功率 30%" });

    const mails = [];
    const send = (s) => {
      mails.push(s);
      return true;
    };
    const [a, b] = await Promise.all([
      maybeSendDigest({ sendMailFn: send, getActiveJobs: () => 0 }),
      maybeSendDigest({ sendMailFn: send, getActiveJobs: () => 0 }),
    ]);

    assert.equal(mails.length, 1, "并发两个 tick 只该发出一封");
    const results = [a, b];
    assert.equal(results.filter((r) => r.sent).length, 1, "只有一个该抢到");
    assert.equal(results.find((r) => !r.sent).reason, "not_due", "没抢到的应判未到期");
    // 抢到的那封必须带上报警，不能是空信
    assert.match(mails[0], /1 项报警/);
  });
});

test("并发 5 个 tick 同时到期 → 仍只发一封", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.cron = "7 9 * * *";
      c.nextDigestAt = new Date(Date.now() - 60_000).toISOString();
      return null;
    });
    await enqueueAlert({ ruleId: "r1" });
    const mails = [];
    const results = await Promise.all(
      Array.from({ length: 5 }, () => maybeSendDigest({ sendMailFn: () => (mails.push(1), true), getActiveJobs: () => 0 })),
    );
    assert.equal(mails.length, 1);
    assert.equal(results.filter((r) => r.sent).length, 1);
  });
});

// 顺延判定也在同一个原子块里：并发时不该出现「一个顺延、一个照发」的分裂。
test("并发 tick 且调度器在忙 → 全部顺延，一封都不发", async () => {
  await withTempFiles(async () => {
    await updateDigestConfig((c) => {
      c.enabled = true;
      c.nextDigestAt = new Date(Date.now() - 60_000).toISOString();
      return null;
    });
    await enqueueAlert({ ruleId: "r1" });
    const mails = [];
    const results = await Promise.all(
      Array.from({ length: 3 }, () => maybeSendDigest({ sendMailFn: () => (mails.push(1), true), getActiveJobs: () => 2 })),
    );
    assert.equal(mails.length, 0);
    assert.ok(
      results.every((r) => r.reason === "deferred_scheduler_busy"),
      "全部应判顺延",
    );
    assert.equal((await loadQueue()).alerts.length, 1, "队列必须原样保留");
  });
});
