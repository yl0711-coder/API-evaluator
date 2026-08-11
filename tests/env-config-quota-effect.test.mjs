// tests/env-config-quota-effect.test.mjs
// P1-04 的行为级复测：解析器单测只能证明"函数返回 4 而不是 NaN"，证明不了那两个真实症状
// （任务永久排队、熔断静默失效）确实消失了。这里直接对着 task-manager 与 auto-test-scheduler
// 设非法 env 跑一遍。
//
// 必须独立成文件：paths.mjs 在模块加载时冻结 DATA_DIR（同 tests/task-persistence.test.mjs 的坑）。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const MODULE_DATA_DIR = mkdtempSync(join(tmpdir(), "evaluator-env-quota-"));
const PREV_DATA_DIR = process.env.EVALUATOR_DATA_DIR;
process.env.EVALUATOR_DATA_DIR = MODULE_DATA_DIR;

const { createTaskManager } = await import("../server/task-manager.mjs");
const { createAutoTestScheduler } = await import("../server/auto-test-scheduler.mjs");
const { closeDatabase } = await import("../server/db.mjs");
const { ensureDataDir } = await import("../server/data-store.mjs");
const { TASK_EVENTS_FILE } = await import("../server/paths.mjs");
await ensureDataDir();

after(async () => {
  closeDatabase();
  if (PREV_DATA_DIR === undefined) delete process.env.EVALUATOR_DATA_DIR;
  else process.env.EVALUATOR_DATA_DIR = PREV_DATA_DIR;
  await rm(MODULE_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
});

function withEnv(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
  })();
}

async function waitFor(predicate, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${label}`);
}

function makeManager() {
  return createTaskManager({
    taskEventsFile: TASK_EVENTS_FILE,
    errorLogFile: join(MODULE_DATA_DIR, "errors.jsonl"),
    normalizeProfileIds: (v) => (Array.isArray(v) ? v : String(v || "").split(",")).filter(Boolean),
    normalizeScenarioIds: (v) => (Array.isArray(v) ? v : String(v || "").split(",")).filter(Boolean),
    runStabilityTest: async () => ({ runId: "run-ok" }),
    runBatchAdmissionTest: async () => ({}),
    runBatchStabilityTest: async () => ({}),
    runScenarioTest: async () => ({}),
  });
}

// 症状一：并发数配成 'abc' 时，旧写法下 runningSlots < NaN 恒 false，任务拿不到槽位、永久 queued。
test("P1-04: 并发数非法时任务仍能被调度，不会永久排队", async () => {
  await withEnv("EVALUATOR_MAX_CONCURRENT_TASKS", "abc", async () => {
    const manager = makeManager();
    const task = await manager.createTask("stability", { profileId: "p-1", rounds: 1 });
    await waitFor(() => task.status === "completed", `任务停在 ${task.status}——并发额度回落失败`);
    const limits = manager.getLimits();
    assert.ok(Number.isSafeInteger(limits.maxConcurrentTasks) && limits.maxConcurrentTasks > 0);
    assert.equal(limits.maxConcurrentTasks, 4, "应回落到默认 4 个槽位");
  });
});

// 队列位/提示语里的 NaN 是用户能直接看到的那一半症状。
test("P1-04: 非法并发数下队列信息不出现 NaN", async () => {
  await withEnv("EVALUATOR_MAX_CONCURRENT_TASKS", "abc", async () => {
    const manager = makeManager();
    const task = await manager.createTask("stability", { profileId: "p-2", rounds: 1 });
    const view = manager.publicTask(task);
    assert.ok(!JSON.stringify(view).includes("NaN"), `任务视图不得含 NaN：${JSON.stringify(view)}`);
    assert.ok(Number.isSafeInteger(view.queuePosition), "队列位必须是整数");
    await waitFor(() => task.status === "completed", "任务未完成");
  });
});

// Infinity 能绕开上限——上限存在的意义就是保护上游 API 与宿主资源。
test("P1-04: 并发数配 Infinity 不得绕开上限", async () => {
  await withEnv("EVALUATOR_MAX_CONCURRENT_TASKS", "Infinity", async () => {
    const { maxConcurrentTasks } = makeManager().getLimits();
    assert.ok(Number.isFinite(maxConcurrentTasks), "不得是 Infinity");
    assert.ok(maxConcurrentTasks <= 64, "必须落在 64 的硬上限内");
  });
});

// 症状二：熔断阈值配成 'abc' 时，旧写法下 maxConsecutiveFailures > 0 恒 false，
// 熔断被静默关掉——作业会对着已挂掉的上游无限空跑失败。
test("P1-04: 熔断阈值非法时熔断仍然生效，不被静默关闭", async () => {
  await withEnv("EVALUATOR_AUTO_TEST_MAX_FAILURES", "abc", async () => {
    const scheduler = createAutoTestScheduler({
      loadJobs: async () => [],
      updateJobs: async () => [],
      runners: {},
      reportIdFromHtmlPath: () => null,
      logError: () => {},
      now: () => 0,
    });
    const status = scheduler.getStatus();
    assert.equal(status.maxConsecutiveFailures, 5, "应回落到默认 5 次");
    assert.ok(status.maxConsecutiveFailures > 0, "必须 > 0——NaN 会让这个判断恒为 false，熔断彻底不触发");
    assert.ok(Number.isSafeInteger(status.maxConcurrent) && status.maxConcurrent > 0);
  });
});

// 0 是"显式关闭熔断"的合法配置，不能被当成非法值一起回落成 5——那会改变运维的既有意图。
test("P1-04: 熔断阈值显式配 0（关闭熔断）仍受尊重", async () => {
  await withEnv("EVALUATOR_AUTO_TEST_MAX_FAILURES", "0", async () => {
    const scheduler = createAutoTestScheduler({
      loadJobs: async () => [],
      updateJobs: async () => [],
      runners: {},
      reportIdFromHtmlPath: () => null,
      logError: () => {},
      now: () => 0,
    });
    assert.equal(scheduler.getStatus().maxConsecutiveFailures, 0, "0 是合法的「关闭熔断」，不该被回落");
  });
});
