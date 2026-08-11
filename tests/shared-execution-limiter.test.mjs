import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// task-manager 的依赖会在模块加载时读取 DATA_DIR，必须先隔离，不能污染开发者的真实评测数据。
const moduleDataDir = mkdtempSync(join(tmpdir(), "evaluator-shared-limiter-data-"));
const previousDataDir = process.env.EVALUATOR_DATA_DIR;
process.env.EVALUATOR_DATA_DIR = moduleDataDir;
const { createAutoTestScheduler } = await import("../server/auto-test-scheduler.mjs");
const { createExecutionLimiter } = await import("../server/execution-limiter.mjs");
const { createTaskManager } = await import("../server/task-manager.mjs");
const { closeDatabase } = await import("../server/db.mjs");

after(async () => {
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.EVALUATOR_DATA_DIR;
  else process.env.EVALUATOR_DATA_DIR = previousDataDir;
  await rm(moduleDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

const normalizers = {
  normalizeProfileIds: (value) => (Array.isArray(value) ? value : String(value || "").split(",")).filter(Boolean),
  normalizeScenarioIds: (value) => (Array.isArray(value) ? value : String(value || "").split(",")).filter(Boolean),
};

function makeStore(initial) {
  let jobs = initial.map((job) => ({ ...job }));
  return {
    loadJobs: async () => jobs.map((job) => ({ ...job })),
    updateJobs: async (mutator) => {
      const next = jobs.map((job) => ({ ...job }));
      const value = await mutator(next);
      jobs = next;
      return value;
    },
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test("手工任务与自动作业共用执行总额度，自动作业不得绕过在途手工任务", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-shared-limiter-"));
  let releaseManual;
  const manualGate = new Promise((resolve) => {
    releaseManual = resolve;
  });
  const started = [];
  const limiter = createExecutionLimiter({ getLimit: () => 1 });

  try {
    const manager = createTaskManager({
      taskEventsFile: join(dir, "task-events.jsonl"),
      ...normalizers,
      executionLimiter: limiter,
      runStabilityTest: async () => {
        started.push("manual");
        await manualGate;
        return { runId: "manual" };
      },
      runBatchAdmissionTest: async () => ({}),
      runBatchStabilityTest: async () => ({}),
      runScenarioTest: async () => ({}),
    });
    const store = makeStore([{ id: "auto", targetId: "target-auto", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }]);
    const scheduler = createAutoTestScheduler({
      ...store,
      executionLimiter: limiter,
      maxConcurrent: 2,
      runners: {
        runQuickVerify: async () => {
          started.push("auto");
          return { success: true };
        },
        runAdmissionTest: async () => ({ success: true }),
        runStabilityTest: async () => ({ success: true }),
        runScenarioTest: async () => ({ success: true }),
      },
      reportIdFromHtmlPath: () => "",
    });

    const task = await manager.createTask("stability", { profileId: "target-manual", rounds: 1 });
    await waitFor(() => started.includes("manual"), "手工任务未进入执行");
    const autoTick = scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(started, ["manual"], "自动作业必须在共享闸外等待，不能与手工任务并行");
    assert.deepEqual(limiter.getStatus(), { maxConcurrent: 1, active: 1, queued: 1 });

    releaseManual();
    await waitFor(() => task.status === "completed", "手工任务未完成");
    await autoTick;
    assert.deepEqual(started, ["manual", "auto"]);
    assert.deepEqual(limiter.getStatus(), { maxConcurrent: 1, active: 0, queued: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});
