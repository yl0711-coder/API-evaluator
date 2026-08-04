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
const { assertTaskNotCancelled, createTaskManager, estimateTaskUnits, updateTaskProgress } = await import("../server/task-manager.mjs");
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
// {模型,场景} 再点一次补齐——带同一 idempotencyKey 的 scenario 任务应去重，防双花。
test("scenario 任务去重：带相同 idempotencyKey 的任务仍在跑时，重复创建返回同一个任务", async () => {
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

    const payload = { profileIds: ["p1"], scenarioIds: ["s1"], repeats: 1, idempotencyKey: "mc-gap-fill:p1:s1" };
    const first = await manager.createTask("scenario", payload);
    const second = await manager.createTask("scenario", payload);
    assert.equal(second.id, first.id, "第二次创建应拿到同一个 in-flight 任务，不新建");
    assert.equal(manager.tasks.size, 1, "只应存在一个任务");

    releaseRunner();
    await waitFor(() => first.status === "completed");

    // 任务结束后去重键已释放，同样的 key 可以重新发起（不是永久锁死）。
    const third = await manager.createTask("scenario", payload);
    assert.notEqual(third.id, first.id, "上一轮已结束，应能正常发起新一轮");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

// 回归：一键标准准入是最贵的流程（每个模型 3 步、几十次真实上游调用）。若 POST /api/tasks 已到达
// 后端、任务建好并开始计费，但响应在回程丢了，前端会报失败诱使用户再点一次 → 双花。带同一个
// idempotencyKey 的重试必须拿回原任务。此前该去重被 `type !== "scenario"` 挡在门外，只有场景补齐能用。
test("admission-suite 任务去重：带相同 idempotencyKey 的任务仍在跑时，重复创建返回同一个任务", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-suite-dedup-test-"));
  let releaseRunner;
  let suiteRuns = 0;
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
      runScenarioTest: async () => ({}),
      runAdmissionSuite: async () => {
        suiteRuns += 1;
        await gate;
        return { type: "admission-suite", conclusion: "accepted", steps: [], models: [] };
      },
    });

    const payload = {
      profileIds: ["p1"],
      modelNames: ["claude-sonnet-5"],
      tierProbeModels: [],
      idempotencyKey: "standard-eval:nonce-abc",
    };
    const first = await manager.createTask("admission-suite", payload);
    const second = await manager.createTask("admission-suite", payload);
    assert.equal(second.id, first.id, "重试应拿回同一个 in-flight 任务，不新建");
    assert.equal(manager.tasks.size, 1, "只应存在一个任务");

    releaseRunner();
    await waitFor(() => first.status === "completed");
    // 真正要防的是钱：编排器只能被跑起来一次。
    assert.equal(suiteRuns, 1, `准入编排器只应执行 1 次，实际 ${suiteRuns} 次`);

    // 任务已结束 → 键释放，再点视为用户主动重跑，应当放行。
    const third = await manager.createTask("admission-suite", payload);
    assert.notEqual(third.id, first.id, "上一轮已结束，应能正常发起新一轮");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

// 回归：去重键按 type 分桶。两个类型不同的任务即便幂等键字面相同，也绝不能互相合并——
// 合并会让调用方拿到一个类型完全不同的 result，前端按自己的形状去读必然崩或显示错数据。
test("任务去重按类型分桶：键相同但 type 不同的任务各自新建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-dedup-bucket-test-"));
  let releaseRunner;
  const gate = new Promise((resolve) => {
    releaseRunner = resolve;
  });
  try {
    const manager = createTaskManager({
      taskEventsFile: join(dir, "task-events.jsonl"),
      ...normalizers,
      runStabilityTest: async () => {
        await gate;
        return {};
      },
      runBatchAdmissionTest: async () => ({}),
      runBatchStabilityTest: async () => ({}),
      runScenarioTest: async () => {
        await gate;
        return { type: "scenario", results: [] };
      },
    });

    const sharedKey = "collision-test-key";
    const scenarioTask = await manager.createTask("scenario", {
      profileIds: ["p1"],
      scenarioIds: ["s1"],
      idempotencyKey: sharedKey,
    });
    const stabilityTask = await manager.createTask("stability", {
      profileIds: ["p1"],
      rounds: 1,
      idempotencyKey: sharedKey,
    });
    assert.notEqual(stabilityTask.id, scenarioTask.id, "类型不同就不该合并，哪怕幂等键一模一样");

    releaseRunner();
    await waitFor(() => scenarioTask.status === "completed" && stabilityTask.status === "completed");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

// 回归：去重键必须由调用方显式声明（payload.idempotencyKey），绝不能按 profileIds/scenarioIds
// 的形状去猜「是不是补齐场景」——否则会把「普通复杂场景测试表单只选了 1 模型 1 场景」这种
// 完全正常、语义不同的请求，跟同时发生的补齐流程错误合并成一个任务。
test("scenario 任务不去重：即便 profileIds/scenarioIds 都恰好是长度1（形似补齐），没带 idempotencyKey 就正常各自新建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-scenario-noshape-dedup-test-"));
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

    // 同一对 {模型,场景}，但没有 idempotencyKey（普通场景测试表单的真实 payload 形状）。
    const payload = { profileIds: ["p1"], scenarioIds: ["s1"], repeats: 3 };
    const first = await manager.createTask("scenario", payload);
    const second = await manager.createTask("scenario", payload);
    assert.notEqual(second.id, first.id, "没带 idempotencyKey 就不应去重，各自建新任务");
    assert.equal(manager.tasks.size, 2);

    releaseRunner();
    await waitFor(() => first.status === "completed" && second.status === "completed");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

test("scenario 任务去重：不同高级设置的幂等键各自正常创建，互不影响", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-scenario-diffkey-test-"));
  try {
    const manager = createTaskManager({
      taskEventsFile: join(dir, "task-events.jsonl"),
      ...normalizers,
      runStabilityTest: async () => ({}),
      runBatchAdmissionTest: async () => ({}),
      runBatchStabilityTest: async () => ({}),
      runScenarioTest: async () => ({ type: "scenario", results: [] }),
    });

    const a = await manager.createTask("scenario", {
      profileIds: ["p1"],
      scenarioIds: ["s1"],
      repeats: 1,
      idempotencyKey: "mc-gap-fill:v2:p1:s1:default-default-1-1-0-0",
    });
    const b = await manager.createTask("scenario", {
      profileIds: ["p1"],
      scenarioIds: ["s1"],
      repeats: 2,
      idempotencyKey: "mc-gap-fill:v2:p1:s1:default-default-2-1-0-0",
    });
    assert.notEqual(b.id, a.id, "同一模型与场景但高级设置不同，不应复用旧任务");

    await waitFor(() => a.status === "completed" && b.status === "completed");
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

// admission-suite 是唯一一个「一个任务里跑多步、每步都有独立裁决」的类型，接线点比别的类型多：
// 类型白名单、进度单元估算、runTask 分发、publicTask 的 steps[] 快照。任何一处漏接的表现都是
// 前端轮询到一个没有 steps 的任务、把网格画成空白，所以在这里一起锁住。
test("admission-suite：任务分发、进度单元估算与 steps[] 快照都接到了 task-manager 上", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-suite-task-"));
  try {
    const { createAdmissionSuiteRunner } = await import("../server/admission-suite.mjs");
    const runAdmissionSuite = createAdmissionSuiteRunner({
      runQuickVerify: async () => ({ cases: [{ id: "connectivity", passed: true }], successRate: 1 }),
      runStabilityTest: async () => ({
        successCount: 9,
        failureCount: 0,
        successRate: 1,
        p95TotalMs: 5000,
        errorCounts: {},
        firstAttemptSuccessRate: 1,
      }),
      runAdmissionTest: async () => ({
        score: 90,
        grade: "A",
        verdict: { verdict: "passed", blocking: true, summary: "硬门槛全部通过。" },
      }),
    });
    const manager = createTaskManager({
      taskEventsFile: join(dir, "task-events.jsonl"),
      ...normalizers,
      runAdmissionSuite,
    });

    const task = await manager.createTask("admission-suite", {
      profileIds: ["p1", "p2"],
      modelNames: ["m1", "m2"],
    });
    // 进度单元 = 步骤数（2 模型 × 3 步），不是请求数——否则进度条会和步骤网格互相矛盾。
    assert.equal(task.totalUnits, 6);

    await waitFor(() => task.status === "completed");
    assert.equal(task.progress, 100);
    assert.equal(task.result.conclusion, "accepted");

    const view = manager.publicTask(task);
    assert.equal(view.steps.length, 6);
    assert.deepEqual(
      view.steps.map((step) => step.executionStatus),
      Array(6).fill("completed"),
    );
    // 快照只带轻量摘要字段：它每 900ms 被轮询一次，塞原始响应体会把内存和带宽吃光。
    assert.deepEqual(Object.keys(view.steps[0]).sort(), [
      "executionStatus",
      "groupKey",
      "groupLabel",
      "isTierProbe",
      "stepLabel",
      "stepName",
      "summary",
      "verdict",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 单 API 准入从同步端点改为异步任务（线上 standard 档 11-12 条用例串行、每条最长 300s，
// 反代 60s 就掐断 → 前端报「连接不上本地服务」而后端仍在跑仍在计费 → 用户重跑 = 双花）。
// 这里锁住四个接线点：类型白名单、进度单元估算、runTask 分发、事件日志只记形状不落 key。
test("admission：单 API 准入作为异步任务分发，进度按用例数推进，事件日志不落敏感字段", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evaluator-task-admission-"));
  try {
    const taskEventsFile = join(dir, "task-events.jsonl");
    const manager = createTaskManager({
      taskEventsFile,
      ...normalizers,
      runAdmissionTest: async (payload, context) => {
        // 建任务时的 11 只是下限估算；真实条数由 runner 上报修正（这里模拟 12 条）。
        for (let i = 1; i <= 12; i += 1) {
          updateTaskProgress(context, i, 12, `准入评测进行中：${i}/12 项用例`);
        }
        return {
          type: "admission",
          runId: "admission-ok",
          grade: "A",
          score: 92,
          successRateText: "100%",
          verdict: { verdict: "passed", summary: "硬门槛全部通过。" },
          reportHtmlPath: join(dir, "report.html"),
          cases: [{ id: "connectivity", name: "连通与模型响应", passed: true }],
          packageLevel: payload.packageLevel,
        };
      },
    });

    const task = await manager.createTask("admission", {
      profileId: "demo",
      packageLevel: "standard",
      // 表单里的自由文本字段：绝不能出现在事件日志里。
      prompt: "hello sk-should-not-be-written-in-full",
    });

    await waitFor(() => task.status === "completed");
    assert.equal(task.totalUnits, 12, "runner 上报的真实用例数应把建任务时的下限估算修正上去");
    assert.equal(task.progress, 100);
    assert.equal(task.result.grade, "A");
    // 前端 renderAdmissionResult 靠 result.cases 画逐用例表格，不能被公开结果裁掉。
    assert.equal(task.result.cases.length, 1);

    const raw = await readFile(taskEventsFile, "utf8");
    assert.match(raw, /"type":"admission"/);
    assert.match(raw, /"packageLevel":"standard"/);
    assert.match(raw, /"grade":"A"/);
    assert.doesNotMatch(raw, /sk-should-not-be-written-in-full/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});

// 建任务时的单元数只是【下限】：真实条数还取决于模型家族指纹探针与 Claude 档位探针，
// 那些在建任务时还没解析出来，由 runner 跑起来后上报修正（见上一个用例）。刻意留低不留高——
// 估高了进度条会卡在中途永远走不满。
test("admission：进度单元按测试包档位给下限估算", () => {
  const opts = normalizers;
  assert.equal(estimateTaskUnits("admission", { packageLevel: "quick" }, opts), 5);
  assert.equal(estimateTaskUnits("admission", { packageLevel: "standard" }, opts), 11);
  assert.equal(estimateTaskUnits("admission", { packageLevel: "deep" }, opts), 12);
  assert.equal(estimateTaskUnits("admission", {}, opts), 11, "没传档位按 standard 兜底（与后端同口径）");
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
