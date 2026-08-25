// tests/alert-digest-sender.test.mjs
// 汇总发信的时机与失败语义：到期判定、调度器忙时顺延（含顺延上限）、
// 「先推进节奏再发信」的顺序、发信失败/未配 SMTP 时把内容回填队列。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDigestDue, shouldDefer, maybeSendDigest, MAX_DEFER_MS } from "../server/alert-digest-sender.mjs";
import {
  loadDigestConfig,
  updateDigestConfig,
  loadQueue,
  enqueueAlert,
  enqueueRun,
  __setDigestFilesForTest,
  __resetDigestChainsForTest,
} from "../server/alert-digest-store.mjs";

test.afterEach(() => {
  __resetDigestChainsForTest();
});

function withTempFiles(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ar-digest-send-"));
  __setDigestFilesForTest({ config: join(dir, "c.json"), queue: join(dir, "q.json") });
  return Promise.resolve(fn()).finally(() => {
    __setDigestFilesForTest({});
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
