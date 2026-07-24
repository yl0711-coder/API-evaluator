import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// server/paths.mjs 在「模块加载」时就把 DATA_DIR 冻结下来，而 task-manager.mjs → report-files.mjs
// 会静态加载 paths.mjs。因此必须在导入 task-manager 之前就把 EVALUATOR_DATA_DIR 指向临时目录，
// 否则下方「task recovery」用例里 ensureDataDir 与写事件文件会指向不同目录（Windows 上报 ENOENT）。
const MODULE_DATA_DIR = mkdtempSync(join(tmpdir(), "evaluator-tm-datadir-"));
const PREV_DATA_DIR = process.env.EVALUATOR_DATA_DIR;
process.env.EVALUATOR_DATA_DIR = MODULE_DATA_DIR;
const { assertTaskNotCancelled, createTaskManager } = await import("../server/task-manager.mjs");
after(async () => {
  if (PREV_DATA_DIR === undefined) delete process.env.EVALUATOR_DATA_DIR;
  else process.env.EVALUATOR_DATA_DIR = PREV_DATA_DIR;
  await rm(MODULE_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
});

const normalizers = {
  normalizeProfileIds: (value) => (Array.isArray(value) ? value : String(value || "").split(",")).filter(Boolean),
  normalizeScenarioIds: (value) => (Array.isArray(value) ? value : String(value || "").split(",")).filter(Boolean),
};

test("task manager records completed tasks without leaking full payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-test-"));
  try {
    const taskEventsFile = join(dir, "task-events.jsonl");
    const manager = createTaskManager({
      taskEventsFile,
      ...normalizers,
      runStabilityTest: async () => ({
        runId: "run-ok",
        profileName: "Demo API",
        successRateText: "100%",
        p95TotalMs: 120,
        reportPath: "/tmp/report.md",
        reportMarkdown: "# very long report",
      }),
      runBatchAdmissionTest: async () => ({}),
      runBatchStabilityTest: async () => ({}),
      runScenarioTest: async () => ({}),
    });

    const task = await manager.createTask("stability", {
      profileId: "demo",
      rounds: 3,
      prompt: "hello sk-should-not-be-written-in-full",
    });

    await waitFor(() => task.status === "completed");
    await waitForFileMatch(taskEventsFile, /"event":"completed"/);

    assert.equal(task.progress, 100);
    assert.equal(task.result.runId, "run-ok");
    assert.equal(task.result.reportMarkdown, "报告内容已写入本地报告文件，请在报告中心查看。");

    const raw = await readFile(taskEventsFile, "utf8");
    assert.match(raw, /"event":"started"/);
    assert.match(raw, /"event":"completed"/);
    assert.doesNotMatch(raw, /sk-should-not-be-written-in-full/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("满槽时第二个任务进入排队(queued)，带位置与 ETA，前一个完成后自动开始", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-queue-test-"));
  process.env.EVALUATOR_MAX_CONCURRENT_TASKS = "1";
  let releaseA;
  const gate = new Promise((resolve) => {
    releaseA = resolve;
  });
  try {
    const manager = createTaskManager({
      taskEventsFile: join(dir, "task-events.jsonl"),
      ...normalizers,
      runStabilityTest: async () => {
        await gate;
        return { runId: "run-ok", successRateText: "100%" };
      },
      runBatchAdmissionTest: async () => ({}),
      runBatchStabilityTest: async () => ({}),
      runScenarioTest: async () => ({}),
    });

    const a = await manager.createTask("stability", { profileId: "p", rounds: 1 });
    const b = await manager.createTask("stability", { profileId: "p", rounds: 1 });
    assert.equal(a.status, "running");
    assert.equal(b.status, "queued");
    assert.ok(b.queuePosition >= 1);
    assert.ok(b.etaSeconds > 0);
    assert.match(b.message, /排队中/);

    releaseA();
    await waitFor(() => b.status === "completed");
    assert.equal(b.status, "completed");
  } finally {
    delete process.env.EVALUATOR_MAX_CONCURRENT_TASKS;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("task manager cancels running tasks through the task context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-cancel-test-"));
  try {
    const taskEventsFile = join(dir, "task-events.jsonl");
    const manager = createTaskManager({
      taskEventsFile,
      ...normalizers,
      runStabilityTest: async (_payload, context) => {
        await waitFor(() => context.task.cancelRequested);
        assertTaskNotCancelled(context);
      },
      runBatchAdmissionTest: async () => ({}),
      runBatchStabilityTest: async () => ({}),
      runScenarioTest: async () => ({}),
    });

    const task = await manager.createTask("stability", { rounds: 5 });
    await manager.cancelTask(task);
    await waitFor(() => task.status === "cancelled");
    await waitForFileMatch(taskEventsFile, /"event":"cancelled"/);

    assert.equal(task.cancelRequested, true);
    assert.equal(task.message, "任务已取消。");

    const raw = await readFile(taskEventsFile, "utf8");
    assert.match(raw, /"event":"cancel_requested"/);
    assert.match(raw, /"event":"cancelled"/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("task manager runs batch admission tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-admission-batch-test-"));
  try {
    const taskEventsFile = join(dir, "task-events.jsonl");
    const manager = createTaskManager({
      taskEventsFile,
      ...normalizers,
      runStabilityTest: async () => ({}),
      runBatchAdmissionTest: async (payload) => ({
        batchId: "admission-batch-ok",
        profileCount: payload.profileIds.length,
        results: [{ profileName: "Candidate A", score: 90 }],
      }),
      runBatchStabilityTest: async () => ({}),
      runScenarioTest: async () => ({}),
    });

    const task = await manager.createTask("batch-admission", {
      profileIds: ["a", "b"],
      packageLevel: "standard",
    });

    await waitFor(() => task.status === "completed");
    assert.equal(task.totalUnits, 2);
    assert.equal(task.result.batchId, "admission-batch-ok");
    assert.equal(task.result.profileCount, 2);

    const raw = await readFile(taskEventsFile, "utf8");
    assert.match(raw, /"type":"batch-admission"/);
    assert.match(raw, /"profileCount":2/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

// 回归：「模型比对·补齐单方场景」逐个真实调用付费 API，若某次误判失败用户很容易对同一
// {模型,场景} 再点一次补齐——createTask 对单模型单场景的 scenario 任务应去重，防双花。
test("scenario 任务去重：同一 profileId+scenarioId 的单模型单场景任务仍在跑时，重复创建返回同一个任务", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-scenario-dedup-test-"));
  let releaseRunner;
  const gate = new Promise((resolve) => {
    releaseRunner = resolve;
  });
  try {
    const manager = createTaskManager({
      taskEventsFile: join(dir, "task-events.jsonl"),
      ...normalizers,
      runStabilityTest: async () => ({}),
      runBatchAdmissionTest: async () => ({}),
      runBatchStabilityTest: async () => ({}),
      runScenarioTest: async () => {
        await gate;
        return { type: "scenario", results: [] };
      },
    });

    const payload = { profileIds: ["p1"], scenarioIds: ["s1"], repeats: 1 };
    const first = await manager.createTask("scenario", payload);
    const second = await manager.createTask("scenario", payload);
    assert.equal(second.id, first.id, "第二次创建应拿到同一个 in-flight 任务，不新建");
    assert.equal(manager.tasks.size, 1, "只应存在一个任务");

    releaseRunner();
    await waitFor(() => first.status === "completed");

    // 任务结束后去重键已释放，同样的 {模型,场景} 可以重新发起（不是永久锁死）。
    const third = await manager.createTask("scenario", payload);
    assert.notEqual(third.id, first.id, "上一轮已结束，应能正常发起新一轮");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("scenario 任务去重：多模型或多场景（批量场景测试）不受去重影响，各自正常创建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-scenario-nodedup-test-"));
  try {
    const manager = createTaskManager({
      taskEventsFile: join(dir, "task-events.jsonl"),
      ...normalizers,
      runStabilityTest: async () => ({}),
      runBatchAdmissionTest: async () => ({}),
      runBatchStabilityTest: async () => ({}),
      runScenarioTest: async () => ({ type: "scenario", results: [] }),
    });

    const multiModel = await manager.createTask("scenario", { profileIds: ["p1", "p2"], scenarioIds: ["s1"], repeats: 1 });
    const multiScenario = await manager.createTask("scenario", { profileIds: ["p1", "p2"], scenarioIds: ["s1"], repeats: 1 });
    assert.notEqual(multiScenario.id, multiModel.id, "多模型形态不去重，各自新建");

    await waitFor(() => multiModel.status === "completed" && multiScenario.status === "completed");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("task manager separates user-facing task errors from technical logs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-error-test-"));
  try {
    const taskEventsFile = join(dir, "task-events.jsonl");
    const errorLogFile = join(dir, "errors.jsonl");
    const manager = createTaskManager({
      taskEventsFile,
      errorLogFile,
      ...normalizers,
      logTechnicalError: async (file, entry) => {
        await writeFile(file, `${JSON.stringify({ id: "err-test", message: entry.error.message })}\n`, "utf8");
        return "err-test";
      },
      buildUserErrorMessage: (errorId) => `用户提示 ${errorId}`,
      runStabilityTest: async () => {
        throw new Error("technical stack detail");
      },
      runBatchAdmissionTest: async () => ({}),
      runBatchStabilityTest: async () => ({}),
      runScenarioTest: async () => ({}),
    });

    const task = await manager.createTask("stability", { rounds: 1 });
    await waitFor(() => task.status === "failed");

    assert.equal(task.error, "用户提示 err-test");
    assert.equal(task.errorId, "err-test");
    assert.match(await readFile(errorLogFile, "utf8"), /technical stack detail/);

    const taskEvents = await readFile(taskEventsFile, "utf8");
    assert.match(taskEvents, /用户提示 err-test/);
    assert.doesNotMatch(taskEvents, /technical stack detail/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("recent task recovery marks previous running tasks as interrupted", async () => {
  // EVALUATOR_DATA_DIR 已在文件顶部（任何 paths.mjs 加载之前）指向临时目录，
  // 于是 data-store 的 ensureDataDir 与下面写入的事件文件指向同一目录（同一 paths 实例）。
  const dataStore = await import("../server/data-store.mjs");
  const paths = await import("../server/paths.mjs");
  await dataStore.ensureDataDir();
  await writeFile(
    paths.TASK_EVENTS_FILE,
    `${JSON.stringify({
      taskId: "task-running-before-crash",
      type: "stability",
      event: "started",
      status: "running",
      message: "任务已开始。",
      loggedAt: "2026-05-20T10:00:00.000Z",
    })}\n`,
    "utf8",
  );

  const recentTasks = await dataStore.readRecentTasks(new Map(), (task) => task);

  assert.equal(recentTasks[0].status, "interrupted");
  assert.equal(recentTasks[0].recoverable, false);
  assert.match(recentTasks[0].message, /任务已中断/);
});

async function waitFor(predicate) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1500) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out while waiting for task state.");
}

async function waitForFileMatch(file, pattern) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1500) {
    const content = await readFile(file, "utf8").catch(() => "");
    if (pattern.test(content)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out while waiting for ${pattern} in ${file}.`);
}
