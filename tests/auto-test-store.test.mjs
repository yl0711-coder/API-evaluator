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
    options: { rounds: "999", concurrency: 0, packageLevel: "bad", repeats: 3, prompt: "x".repeat(5000), promptPresetId: "custom" },
    junk: "dropped",
  });
  assert.equal(job.targetId, "mt_abc");
  assert.equal(job.kind, "stability");
  assert.equal(job.periodHours, 6.9, "保留小数");
  assert.equal(job.options.rounds, 100, "clamp 上限");
  assert.equal(job.options.concurrency, 1, "clamp 下限");
  assert.equal(job.options.packageLevel, "standard", "非法档位回退");
  assert.equal(job.options.repeats, 3);
  assert.equal(job.options.promptPresetId, "custom", "保留预设 id");
  assert.equal(job.options.prompt.length, 4000, "文案截断到 4000");
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

test("normalizeOptions：promptPresetId 缺省为 basic，prompt 缺省为空串", () => {
  const job = normalizeJob({ targetId: "t", kind: "stability", periodHours: 1 });
  assert.equal(job.options.promptPresetId, "basic");
  assert.equal(job.options.prompt, "");
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

test("validateJob：缺 targetId / 非法 kind / 周期<0.5 → 返回错误串", () => {
  assert.match(validateJob(normalizeJob({ kind: "quick", periodHours: 1 })), /渠道与模型/);
  assert.equal(validateJob(normalizeJob({ targetId: "t", kind: "quick", periodHours: 1.5 })), null, "小数合法 → null");
  assert.equal(validateJob({ targetId: "t", kind: "quick", periodHours: 0.5 }), null, "0.5 合法（下限）");
  // periodHours 被 normalize 夹到 ≥0.5，故直接构造非法对象验证校验分支：
  assert.match(validateJob({ targetId: "t", kind: "quick", periodHours: 0.4 }), /周期/);
  assert.match(validateJob({ targetId: "t", kind: "bad", periodHours: 1 }), /种类/);
});

test("computeNextRunAt：从基准推 periodHours 小时（支持小数，最短 0.5）", () => {
  const base = Date.parse("2026-07-02T00:00:00.000Z");
  assert.equal(computeNextRunAt(6, base), "2026-07-02T06:00:00.000Z");
  assert.equal(computeNextRunAt(1.5, base), "2026-07-02T01:30:00.000Z", "1.5 小时 = 90 分钟");
  assert.equal(computeNextRunAt(0, base), "2026-07-02T00:30:00.000Z", "周期<0.5 夹到半小时");
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
