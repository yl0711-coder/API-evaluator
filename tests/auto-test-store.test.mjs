// tests/auto-test-store.test.mjs
// 自动测试作业存储纯逻辑测试：normalize/validate 白名单与类型强制、load/save 往返、nextRunAt 计算。
// 一律写临时目录，绝不污染真源配置。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadJobs,
  saveJobs,
  updateJobs,
  normalizeJob,
  validateJob,
  computeNextRunAt,
  AUTO_TEST_KINDS,
  JobValidationError,
  __setJobsFileForTest,
  __resetWriteChainForTest,
} from "../server/auto-test-store.mjs";

test.afterEach(() => {
  __setJobsFileForTest(null);
  __resetWriteChainForTest();
});

test("normalizeJob：白名单 + 类型强制；周期允许小数；kind 限四种", () => {
  const job = normalizeJob({
    targetId: "mt_abc",
    kind: "stability",
    periodHours: "6.9",
    enabled: true,
    options: {
      concurrency: 0,
      packageLevel: "bad",
      repeats: 3,
      groups: [
        { presetId: "custom", prompt: "x".repeat(5000), repeats: "999" },
        { presetId: "basic", prompt: "", repeats: 0 },
      ],
    },
    junk: "dropped",
  });
  assert.equal(job.targetId, "mt_abc");
  assert.equal(job.kind, "stability");
  assert.equal(job.periodHours, 6.9, "保留小数");
  assert.equal(job.options.concurrency, 1, "clamp 下限");
  assert.equal(job.options.packageLevel, "standard", "非法档位回退");
  assert.equal(job.options.repeats, 3);
  assert.equal(job.options.groups.length, 1, "repeats=0 的分组被丢弃");
  assert.equal(job.options.groups[0].presetId, "custom", "保留预设 id");
  assert.equal(job.options.groups[0].repeats, 20, "clamp 上限");
  assert.equal(job.options.groups[0].prompt.length, 4000, "文案截断到 4000");
  assert.equal("junk" in job, false, "未知字段被丢弃");
  assert.ok(job.id.startsWith("atj_"), "自动生成 id");
  assert.equal(AUTO_TEST_KINDS.includes(job.kind), true);
});

test("normalizeJob：非法 kind 回退（新建默认 quick）；enabled 缺省为 true", () => {
  const job = normalizeJob({ targetId: "t", kind: "nonsense" });
  assert.equal(job.kind, "quick");
  assert.equal(job.enabled, true);
  const disabled = normalizeJob({ targetId: "t", enabled: false });
  assert.equal(disabled.enabled, false);
});

test("normalizeOptions：groups 缺省为空数组", () => {
  const job = normalizeJob({ targetId: "t", kind: "stability", periodHours: 1 });
  assert.deepEqual(job.options.groups, []);
});

test("normalizeOptions：旧扁平字段（rounds/promptPresetId/prompt）在无 groups 时迁移为单组", () => {
  const job = normalizeJob({
    targetId: "t",
    kind: "stability",
    periodHours: 1,
    options: { rounds: 20, promptPresetId: "coding", prompt: "老文案" },
  });
  assert.deepEqual(job.options.groups, [{ presetId: "coding", prompt: "老文案", repeats: 20 }]);
});

test("validateJob：stability 作业 groups 为空 → 报错", () => {
  const job = normalizeJob({ targetId: "t", kind: "stability", periodHours: 1 });
  assert.match(validateJob(job), /测试文案分组/);
  const ok = normalizeJob({
    targetId: "t",
    kind: "stability",
    periodHours: 1,
    options: { groups: [{ presetId: "basic", prompt: "", repeats: 3 }] },
  });
  assert.equal(validateJob(ok), null);
});

test("normalizeJob：existing 保留 id/createdAt/运行态字段", () => {
  const existing = {
    id: "atj_keep",
    createdAt: "2020-01-01T00:00:00.000Z",
    lastRunAt: "2021-01-01T00:00:00.000Z",
    lastStatus: "success",
    lastReportId: "rep_1",
  };
  const job = normalizeJob({ targetId: "t", kind: "quick", periodHours: 2 }, existing);
  assert.equal(job.id, "atj_keep");
  assert.equal(job.createdAt, "2020-01-01T00:00:00.000Z");
  assert.equal(job.lastRunAt, "2021-01-01T00:00:00.000Z", "运行态由调度器管，规范化保留");
  assert.equal(job.lastStatus, "success");
  assert.equal(job.lastReportId, "rep_1");
});

test("normalizeJob：保留熔断运行态（consecutiveFailures / autoDisabledAt），缺省清零", () => {
  const fresh = normalizeJob({ targetId: "t", kind: "quick", periodHours: 1 });
  assert.equal(fresh.consecutiveFailures, 0, "新建默认 0");
  assert.equal(fresh.autoDisabledAt, null);
  const existing = { id: "atj_x", consecutiveFailures: 4, autoDisabledAt: "2026-07-03T00:00:00.000Z" };
  const kept = normalizeJob({ targetId: "t", kind: "quick", periodHours: 1 }, existing);
  assert.equal(kept.consecutiveFailures, 4, "load 归一化不得丢失熔断计数，否则熔断永不触发");
  assert.equal(kept.autoDisabledAt, "2026-07-03T00:00:00.000Z");
  // 脏值（负数/NaN）归零，杜绝坏数据。
  assert.equal(normalizeJob({ targetId: "t", kind: "quick", periodHours: 1 }, { consecutiveFailures: -3 }).consecutiveFailures, 0);
  assert.equal(normalizeJob({ targetId: "t", kind: "quick", periodHours: 1 }, { consecutiveFailures: "abc" }).consecutiveFailures, 0);
});

test("validateJob：缺 targetId / 非法 kind / 周期<0.1 → 返回错误串", () => {
  assert.match(validateJob(normalizeJob({ kind: "quick", periodHours: 1 })), /渠道与模型/);
  assert.equal(validateJob(normalizeJob({ targetId: "t", kind: "quick", periodHours: 1.5 })), null, "小数合法 → null");
  assert.equal(validateJob({ targetId: "t", kind: "quick", periodHours: 0.1 }), null, "0.1 合法（下限）");
  // periodHours 被 normalize 夹到 ≥0.1，故直接构造非法对象验证校验分支：
  assert.match(validateJob({ targetId: "t", kind: "quick", periodHours: 0.05 }), /周期/);
  assert.match(validateJob({ targetId: "t", kind: "bad", periodHours: 1 }), /种类/);
});

test("computeNextRunAt：从基准推 periodHours 小时（支持小数，最短 0.1）", () => {
  const base = Date.parse("2026-07-02T00:00:00.000Z");
  assert.equal(computeNextRunAt(6, base), "2026-07-02T06:00:00.000Z");
  assert.equal(computeNextRunAt(1.5, base), "2026-07-02T01:30:00.000Z", "1.5 小时 = 90 分钟");
  assert.equal(computeNextRunAt(0, base), "2026-07-02T00:06:00.000Z", "周期<0.1 夹到 6 分钟");
});

test("updateJobs：并发读改写被串行化，不丢写", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atj-upd-"));
  const file = join(dir, "auto-test-jobs.json");
  try {
    __setJobsFileForTest(file);
    await saveJobs([]);
    // 并发发起 20 个 push；若读改写有竞争会互相覆盖，最终少于 20 条。串行化后应恰好 20 条。
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        updateJobs((jobs) => {
          jobs.push(normalizeJob({ id: `atj_${i}`, targetId: "t", kind: "quick", periodHours: 1 }));
        }),
      ),
    );
    const back = await loadJobs();
    assert.equal(back.length, 20, "20 次并发写全部保留，无覆盖丢失");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("updateJobs：mutator 抛错 → 不落盘（校验失败不破坏现有数据）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atj-upd-err-"));
  const file = join(dir, "auto-test-jobs.json");
  try {
    __setJobsFileForTest(file);
    await saveJobs([normalizeJob({ id: "atj_keep", targetId: "t", kind: "quick", periodHours: 1 })]);
    await assert.rejects(
      updateJobs((jobs) => {
        jobs.push(normalizeJob({ id: "atj_bad", targetId: "t", kind: "quick", periodHours: 1 }));
        throw new JobValidationError("拒绝");
      }),
      JobValidationError,
    );
    const back = await loadJobs();
    assert.equal(back.length, 1, "抛错的那次不落盘");
    assert.equal(back[0].id, "atj_keep");
    // 后续正常写仍能进行（链未被卡死）。
    await updateJobs((jobs) => jobs.push(normalizeJob({ id: "atj_ok", targetId: "t", kind: "quick", periodHours: 1 })));
    assert.equal((await loadJobs()).length, 2, "错误后链仍可继续");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("load/save 往返：写临时文件、读回一致；坏/无文件 → 空数组", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atj-store-"));
  const file = join(dir, "auto-test-jobs.json");
  try {
    __setJobsFileForTest(file);
    assert.deepEqual(await loadJobs(), [], "无文件 → []");
    const job = normalizeJob({ targetId: "mt_x", kind: "scenario", periodHours: 12, scenarioIds: ["a", "a", "b", ""] });
    await saveJobs([job]);
    const back = await loadJobs();
    assert.equal(back.length, 1);
    assert.equal(back[0].targetId, "mt_x");
    assert.deepEqual(back[0].scenarioIds, ["a", "b"], "scenarioIds 去重去空");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

// ── cron 模式（与间隔模式并存）──

test("normalizeJob：cron 字段规范化（trim + 截断），缺省空串", () => {
  assert.equal(normalizeJob({ targetId: "t", kind: "quick" }).cron, "", "无 cron → 空串");
  assert.equal(normalizeJob({ targetId: "t", kind: "quick", cron: "  0 9-18 * * 1-5  " }).cron, "0 9-18 * * 1-5", "首尾空白去除");
  // existing 保留 cron
  const kept = normalizeJob({ targetId: "t", kind: "quick" }, { cron: "0 0 * * *" });
  assert.equal(kept.cron, "0 0 * * *");
});

test("normalizeJob：固定时刻模式标记保留，避免 HH:00 与每天一次编辑回填歧义", () => {
  const fixed = normalizeJob({ targetId: "t", kind: "quick", cron: "0 1 * * 1-5", cronMode: "fixed" });
  assert.equal(fixed.cronMode, "fixed");
  const changedToOnce = normalizeJob({ targetId: "t", kind: "quick", cron: "0 1 * * 1-5", cronMode: "" }, fixed);
  assert.equal(changedToOnce.cronMode, "");
});

test("validateJob：cron 合法 → null；非法 → 可读错误；有 cron 时不强校验 periodHours", () => {
  assert.equal(validateJob(normalizeJob({ targetId: "t", kind: "quick", cron: "0 9-18 * * 1-5" })), null, "合法 cron");
  // 有 cron 时即使 periodHours 缺省也 OK（cron 优先）
  assert.equal(validateJob(normalizeJob({ targetId: "t", kind: "quick", cron: "0 */12 * * 6,0" })), null);
  assert.equal(validateJob(normalizeJob({ targetId: "t", kind: "quick", cron: "30 1 * * 1-5;45 5 * * 1-5" })), null);
  assert.match(validateJob(normalizeJob({ targetId: "t", kind: "quick", cron: "60 * * * *" })), /定时表达式不合法/, "分钟越界");
  assert.match(validateJob(normalizeJob({ targetId: "t", kind: "quick", cron: "0 9 * *" })), /定时表达式不合法/, "字段不足");
});

test("validateJob：语法合法但永不触发的 cron 必须拒绝，不能回退为每日执行", () => {
  const impossible = normalizeJob({ targetId: "t", kind: "quick", cron: "0 0 30 2 *" });
  assert.match(validateJob(impossible), /未来四年内没有可执行时刻/);
  assert.equal(computeNextRunAt(impossible, Date.UTC(2026, 0, 1)), null, "不得伪造 24 小时后的 nextRunAt");
});

test("validateJob：闰日 cron 在四年窗口内有效，不被误判为无执行时刻", () => {
  const leapDay = normalizeJob({ targetId: "t", kind: "quick", cron: "0 0 29 2 *" });
  assert.equal(validateJob(leapDay), null);
  assert.equal(computeNextRunAt(leapDay, Date.UTC(2026, 0, 1)), "2028-02-28T16:00:00.000Z");
});

test("computeNextRunAt：对象入参 + cron → 按 cron 算下次（北京时间）", () => {
  // 北京周一 09:30 → UTC 周一 01:30。工作日白天每小时，下次应是北京 10:00 = UTC 02:00。
  const from = Date.UTC(2026, 0, 5, 1, 30); // 北京 2026-01-05(周一) 09:30
  const job = { cron: "0 9-18 * * 1-5", periodHours: 24 };
  assert.equal(computeNextRunAt(job, from), "2026-01-05T02:00:00.000Z", "北京 10:00");
});

test("computeNextRunAt：多个固定时刻取最早的下一次", () => {
  const from = Date.UTC(2026, 0, 5, 17, 31); // 北京时间周二 01:31
  const job = { cron: "30 1 * * 1-5;45 5 * * 1-5", periodHours: 24 };
  assert.equal(computeNextRunAt(job, from), "2026-01-05T21:45:00.000Z"); // 北京时间周二 05:45
});

test("computeNextRunAt：对象入参无 cron → 退回 periodHours 间隔", () => {
  const base = Date.parse("2026-07-02T00:00:00.000Z");
  assert.equal(computeNextRunAt({ periodHours: 6, cron: "" }, base), "2026-07-02T06:00:00.000Z", "空 cron 走间隔");
});
