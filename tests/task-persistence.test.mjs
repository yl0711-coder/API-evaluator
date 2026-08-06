// tests/task-persistence.test.mjs
// ADM-017：任务状态落库。此前任务只活在内存 Map 里——落定 1 小时被逐出、重启即清空，
// 唯一持久痕迹是 task-events.jsonl 的最后 300 行，「上周那次准入跑没跑」查不到。
//
// 必须独立成文件：server/paths.mjs 在模块加载时冻结 DATA_DIR，db.mjs 静态导入它。
// 见 tests/task-detail.test.mjs 与 tests/end-to-end-latency.test.mjs 同样的坑。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const MODULE_DATA_DIR = mkdtempSync(join(tmpdir(), "evaluator-task-persist-"));
process.env.EVALUATOR_DATA_DIR = MODULE_DATA_DIR;

const { recordEvaluationTask, queryEvaluationTask, queryRecentEvaluationTasks, markInterruptedEvaluationTasks, closeDatabase } =
  await import("../server/db.mjs");

const dbFor = (name) => join(MODULE_DATA_DIR, `${name}.db`);

const baseTask = (over = {}) => ({
  id: "t-1",
  type: "admission-suite",
  status: "running",
  createdBy: "zhangsan",
  cancelledBy: null,
  createdAt: "2026-08-05T10:00:00.000Z",
  startedAt: "2026-08-05T10:00:01.000Z",
  endedAt: null,
  progress: 10,
  completedUnits: 1,
  totalUnits: 10,
  message: "任务已开始。",
  error: null,
  errorId: "",
  ...over,
});

test("ADM-017: 任务按 task_id upsert，多次状态跃迁不产生重复行", async () => {
  const path = dbFor("upsert");
  assert.equal(await recordEvaluationTask(baseTask(), { path }), true);
  // 同一任务后续跃迁到终态。
  assert.equal(
    await recordEvaluationTask(
      baseTask({ status: "completed", progress: 100, completedUnits: 10, endedAt: "2026-08-05T10:08:00.000Z", message: "任务已完成。" }),
      { path },
    ),
    true,
  );

  const list = await queryRecentEvaluationTasks(30, { path });
  assert.equal(list.length, 1, "同一 task_id 必须只有一行——否则任务中心会把一个任务显示成好几条");
  assert.equal(list[0].status, "completed");
  assert.equal(list[0].progress, 100);
  closeDatabase(path);
});

test("ADM-017: payload 只在建任务时写一次，终态 upsert 不得把它覆盖成 null", async () => {
  const path = dbFor("payload");
  // 建任务：带 payload 形状摘要（「再测一次」要靠它回填表单）。
  await recordEvaluationTask(baseTask({ payload: { profileIds: ["p-1"], modelNames: ["claude-sonnet-5"] } }), { path });
  // 终态事件不带 payload（同事件流口径：summarizeTaskPayload 只在 queued/started 写一次）。
  await recordEvaluationTask(baseTask({ status: "completed", payload: null, result: { grade: "A" } }), { path });

  const detail = await queryEvaluationTask("t-1", { path });
  // 若 UPDATE 里没用 COALESCE，这里会是 null，「再测一次」按钮就永久失效了。
  assert.deepEqual(detail.payload.profileIds, ["p-1"], "payload 必须被 COALESCE 保住");
  assert.equal(detail.result.grade, "A");
  closeDatabase(path);
});

test("ADM-017: 列表不带 steps，明细才带（列表响应体积）", async () => {
  const path = dbFor("steps");
  const steps = Array.from({ length: 20 }, (_, i) => ({
    groupKey: "p-1",
    stepName: `step-${i}`,
    executionStatus: "completed",
    verdict: "passed",
  }));
  await recordEvaluationTask(baseTask({ status: "completed", steps }), { path });

  const list = await queryRecentEvaluationTasks(30, { path });
  assert.equal(list[0].steps, undefined, "列表刻意不带 steps：30 任务 × 20 步会把响应撑到几百 KB");
  const detail = await queryEvaluationTask("t-1", { path });
  assert.equal(detail.steps.length, 20, "明细必须带 steps，这正是任务中心要画的网格");
  closeDatabase(path);
});

test("ADM-017: 启动时把残留的 running/queued 改判 interrupted", async () => {
  const path = dbFor("interrupted");
  await recordEvaluationTask(baseTask({ id: "t-run", status: "running" }), { path });
  await recordEvaluationTask(baseTask({ id: "t-queue", status: "queued" }), { path });
  await recordEvaluationTask(baseTask({ id: "t-done", status: "completed", endedAt: "2026-08-05T10:08:00.000Z" }), { path });

  const changed = await markInterruptedEvaluationTasks({ path });
  assert.equal(changed, 2, "只该改判两条未终结的");

  assert.equal((await queryEvaluationTask("t-run", { path })).status, "interrupted");
  assert.equal((await queryEvaluationTask("t-queue", { path })).status, "interrupted");
  // 已完成的绝不能被动到——那会把成功的历史记录改写成中断。
  assert.equal((await queryEvaluationTask("t-done", { path })).status, "completed");
  // 改判后必须有 endedAt，否则前端算不出耗时、还会以为它仍在跑。
  assert.ok((await queryEvaluationTask("t-run", { path })).endedAt);
  closeDatabase(path);
});

test("ADM-017: 落库对象带 taskId 而非 id，与事件流那条路径同构", async () => {
  const path = dbFor("shape");
  await recordEvaluationTask(baseTask({ status: "cancelled", cancelledBy: "lisi" }), { path });
  const detail = await queryEvaluationTask("t-1", { path });
  // 前端任务中心按 taskId 找行（列表与明细共用一套渲染），两条数据源必须长得一样。
  assert.equal(detail.taskId, "t-1");
  assert.equal(detail.id, undefined, "不要同时给 id，否则前端两套字段名容易各写一半");
  // ADM-016 的身份字段要能跨重启查到——这是落库的主要动机之一。
  assert.equal(detail.createdBy, "zhangsan");
  assert.equal(detail.cancelledBy, "lisi");
  // 库里的记录不可能再被取消（进程换了，没有 abortController）。
  assert.equal(detail.recoverable, false);
  closeDatabase(path);
});

test("ADM-017: 没有 task.id 时安全返回 false，不抛", async () => {
  const path = dbFor("guard");
  assert.equal(await recordEvaluationTask(null, { path }), false);
  assert.equal(await recordEvaluationTask({}, { path }), false);
  closeDatabase(path);
});
