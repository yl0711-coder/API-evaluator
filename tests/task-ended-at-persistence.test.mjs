// tests/task-ended-at-persistence.test.mjs
// P1-03：终态任务的结束时间必须落库。
//
// 原缺陷：runTask 的三个终态分支都是「先 appendTaskEvent（内含落库），后在 finally 里赋
// task.endedAt」，于是 evaluation_tasks.ended_at 与事件流双双写入 null；upsert 里 ended_at
// 走 COALESCE、之后再没有任何写入，这个 null 就是永久的。任务被逐出内存或进程重启后，
// 任务中心只剩「结束：—」，任务时长 / 审计 / 运营统计都算不出来。
//
// 必须独立成文件：server/paths.mjs 在模块加载时冻结 DATA_DIR，db.mjs / report-files.mjs 静态
// 导入它。同 tests/task-persistence.test.mjs、tests/task-detail.test.mjs 的坑。
//
// 刻意【不传 path】给 queryEvaluationTask：让它走和 task-manager 里 recordEvaluationTask 完全
// 相同的默认库路径解析。传 path 只能证明"写得进读得出"，证不了生产链路那条默认路径接对了。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const MODULE_DATA_DIR = mkdtempSync(join(tmpdir(), "evaluator-task-endedat-"));
const PREV_DATA_DIR = process.env.EVALUATOR_DATA_DIR;
process.env.EVALUATOR_DATA_DIR = MODULE_DATA_DIR;

const { createTaskManager, assertTaskNotCancelled } = await import("../server/task-manager.mjs");
const { queryEvaluationTask, closeDatabase } = await import("../server/db.mjs");
const { ensureDataDir, readTaskDetail } = await import("../server/data-store.mjs");
const { TASK_EVENTS_FILE } = await import("../server/paths.mjs");
await ensureDataDir();

after(async () => {
  closeDatabase();
  if (PREV_DATA_DIR === undefined) delete process.env.EVALUATOR_DATA_DIR;
  else process.env.EVALUATOR_DATA_DIR = PREV_DATA_DIR;
  await rm(MODULE_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
});

const normalizers = {
  normalizeProfileIds: (value) => (Array.isArray(value) ? value : String(value || "").split(",")).filter(Boolean),
  normalizeScenarioIds: (value) => (Array.isArray(value) ? value : String(value || "").split(",")).filter(Boolean),
};

// 只注入本用例要用的 runner，其余给个空实现。
function makeManager(overrides = {}) {
  return createTaskManager({
    taskEventsFile: TASK_EVENTS_FILE,
    errorLogFile: join(MODULE_DATA_DIR, "errors.jsonl"),
    ...normalizers,
    runStabilityTest: async () => ({ runId: "run-ok", successRateText: "100%" }),
    runBatchAdmissionTest: async () => ({}),
    runBatchStabilityTest: async () => ({}),
    runScenarioTest: async () => ({}),
    ...overrides,
  });
}

// 落库是 best-effort 且发生在 await appendTaskEvent 里，任务状态翻到终态即已落完；
// 但内存态由调用方的 promise 推进，这里统一等到终态再断言。
async function waitFor(predicate) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待任务状态超时。");
}

// 三类终态共用的断言：库里的 ended_at 必须是有效时间，且与内存态完全一致。
async function assertEndedAtPersisted(task, expectedStatus) {
  const stored = await queryEvaluationTask(task.id);
  assert.ok(stored, `任务 ${task.id} 应已落库`);
  assert.equal(stored.status, expectedStatus);
  assert.ok(stored.endedAt, `${expectedStatus} 任务的 ended_at 不得为 null——这正是 P1-03 的缺陷表现`);
  assert.ok(Number.isFinite(new Date(stored.endedAt).getTime()), "ended_at 必须是可解析的时间");
  // 内存与库必须是同一个时间戳：finally 里若无条件重赋，两条路径会差出几毫秒到几百毫秒，
  // 同一个任务在「还在内存里」与「重启后读库」时显示的结束时间就不一样。
  assert.equal(stored.endedAt, task.endedAt, "库里的结束时间必须与内存态完全一致");
  // 结束不得早于开始，否则任务时长会算成负数。
  if (task.startedAt) {
    assert.ok(new Date(stored.endedAt).getTime() >= new Date(task.startedAt).getTime(), "结束时间不得早于开始时间（任务时长会变负数）");
  }
  return stored;
}

test("P1-03: completed 任务的结束时间落库", async () => {
  const manager = makeManager();
  const task = await manager.createTask("stability", { profileId: "p-done", rounds: 1 });
  await waitFor(() => task.status === "completed");
  await assertEndedAtPersisted(task, "completed");
});

test("P1-03: failed 任务的结束时间落库", async () => {
  const manager = makeManager({
    runStabilityTest: async () => {
      throw new Error("boom");
    },
    // 不注入 logTechnicalError：errorId 留空，走 task.error 的默认文案，与本用例无关。
  });
  const task = await manager.createTask("stability", { profileId: "p-fail", rounds: 1 });
  await waitFor(() => task.status === "failed");
  await assertEndedAtPersisted(task, "failed");
});

test("P1-03: cancelled 任务的结束时间落库", async () => {
  const manager = makeManager({
    runStabilityTest: async (_payload, context) => {
      // 等取消请求到达，再在批次边界抛 TaskCancelledError（真实 runner 的做法）。
      await waitFor(() => context.task.cancelRequested);
      assertTaskNotCancelled(context);
      return {};
    },
  });
  const task = await manager.createTask("stability", { profileId: "p-cancel", rounds: 1 });
  await manager.cancelTask(task, { actor: "lisi" });
  await waitFor(() => task.status === "cancelled");
  const stored = await assertEndedAtPersisted(task, "cancelled");
  assert.equal(stored.cancelledBy, "lisi", "取消人也要跨重启查得到");
});

// 排队中被取消的任务走另一条路径（runWithSlot 里拿到槽位后直接放掉，不进 runTask），
// 那里原本就显式赋了 endedAt——加个用例锁住，防后人把那句一起删掉。
test("P1-03: 排队中即被取消的任务同样落下结束时间", async () => {
  const PREV_SLOTS = process.env.EVALUATOR_MAX_CONCURRENT_TASKS;
  process.env.EVALUATOR_MAX_CONCURRENT_TASKS = "1";
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  try {
    const manager = makeManager({
      runStabilityTest: async () => {
        await gate;
        return { runId: "run-ok" };
      },
    });
    const running = await manager.createTask("stability", { profileId: "p-a", rounds: 1 });
    const queued = await manager.createTask("stability", { profileId: "p-b", rounds: 1 });
    assert.equal(queued.status, "queued", "槽位已满，第二个任务应当排队");

    await manager.cancelTask(queued);
    releaseFirst(); // 放行第一个，队列里那个才会拿到槽位并立即放弃
    await waitFor(() => queued.status === "cancelled");
    await assertEndedAtPersisted(queued, "cancelled");
    await waitFor(() => running.status === "completed");
  } finally {
    if (PREV_SLOTS === undefined) delete process.env.EVALUATOR_MAX_CONCURRENT_TASKS;
    else process.env.EVALUATOR_MAX_CONCURRENT_TASKS = PREV_SLOTS;
  }
});

// 落库之外，JSONL 事件流也必须带上 endedAt：SQLite 不可用时它是唯一来源
// （data-store.readTaskDetail 的第二级回退），那条路径同样不该显示「结束：—」。
test("P1-03: 终态事件写进 JSONL 时也带 endedAt，且读回路径能拿到", async () => {
  const manager = makeManager();
  const task = await manager.createTask("stability", { profileId: "p-jsonl", rounds: 1 });
  await waitFor(() => task.status === "completed");

  const lines = (await readFile(TASK_EVENTS_FILE, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const terminal = lines.filter((entry) => entry.taskId === task.id && entry.event === "completed");
  assert.equal(terminal.length, 1, "应恰好有一条 completed 事件");
  assert.equal(terminal[0].endedAt, task.endedAt, "事件流里的 endedAt 必须与内存态一致，不得为 null");

  // 读回路径（库优先）也要给出结束时间——任务中心「结束：」那一栏读的就是这个字段。
  const detail = await readTaskDetail(task.id, manager.tasks, manager.publicTask);
  assert.ok(detail.endedAt, "readTaskDetail 必须给出 endedAt，否则任务中心显示「结束：—」");
});
