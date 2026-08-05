import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// 【为什么这些用例不能待在 data-store.test.mjs 里】
// server/paths.mjs 在模块加载时就把 DATA_DIR 冻结，而 data-store.mjs 是【静态】导入它的。
// 给 data-store.mjs 加 ?case= 查询串只能拿到新的 data-store 实例，它绑定的仍是那份早已冻结的
// paths.mjs——于是 ensureDataDir() 建的目录和用例要写的事件文件指向两处，Windows 上直接 ENOENT。
// node --test 按【文件】分进程，所以换个文件就能拿到干净的 paths.mjs。
// 与 task-manager.test.mjs 同一套写法：先设环境变量，再 await import。
const MODULE_DATA_DIR = mkdtempSync(join(tmpdir(), "evaluator-task-detail-"));
const PREV_DATA_DIR = process.env.EVALUATOR_DATA_DIR;
process.env.EVALUATOR_DATA_DIR = MODULE_DATA_DIR;
const { ensureDataDir, readRecentTasks, readTaskDetail } = await import("../server/data-store.mjs");
const { TASK_EVENTS_FILE } = await import("../server/paths.mjs");
await ensureDataDir();

after(async () => {
  if (PREV_DATA_DIR === undefined) delete process.env.EVALUATOR_DATA_DIR;
  else process.env.EVALUATOR_DATA_DIR = PREV_DATA_DIR;
  await rm(MODULE_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
});

// 所有用例共用同一个事件文件（DATA_DIR 已冻结，改不了），因此每个用例先整体重写它。
async function writeTaskEvents(lines) {
  await writeFile(TASK_EVENTS_FILE, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
}

const identityPublicTask = (task) => task;

const startedEvent = (taskId, payload, loggedAt) => ({
  taskId,
  type: "admission-suite",
  event: "started",
  status: "running",
  loggedAt,
  payload,
});

test("readRecentTasks 合并首个事件的 payload，但列表刻意不带 steps", async () => {
  // payload 只写在首个事件上（summarizeTaskPayload 只在 queued/started 落一次），
  // 状态与 steps 只在最后一个事件上。折叠时必须同时留住两端。
  await writeTaskEvents([
    startedEvent("t1", { profileIds: ["p1", "p2"], modelNames: ["m1", "m2"] }, "2026-08-05T00:00:00.000Z"),
    {
      taskId: "t1",
      type: "admission-suite",
      event: "completed",
      status: "completed",
      loggedAt: "2026-08-05T00:05:00.000Z",
      steps: [{ groupKey: "p1", stepName: "quick", executionStatus: "completed", verdict: "passed" }],
    },
  ]);

  const [task] = await readRecentTasks(new Map(), identityPublicTask);
  assert.equal(task.taskId, "t1");
  assert.equal(task.status, "completed", "状态取最后一个事件");
  assert.deepEqual(task.payload.profileIds, ["p1", "p2"], "payload 取首个事件，否则任务一结束就查不到测了什么");
  assert.deepEqual(task.payload.modelNames, ["m1", "m2"]);
  assert.equal(task.steps, undefined, "列表不带 steps：30 个任务 × 最多 20 步会把列表响应撑到几百 KB");
});

test("readTaskDetail 从事件流补回已被逐出内存的任务详情（含 steps）", async () => {
  await writeTaskEvents([
    startedEvent("t2", { profileIds: ["p9"], modelNames: ["m9"] }, "2026-08-05T01:00:00.000Z"),
    {
      taskId: "t2",
      type: "admission-suite",
      event: "completed",
      status: "completed",
      loggedAt: "2026-08-05T01:09:00.000Z",
      steps: [
        { groupKey: "p9", stepName: "quick", executionStatus: "completed", verdict: "passed" },
        { groupKey: "p9", stepName: "admission", executionStatus: "completed", verdict: "not_passed" },
      ],
    },
  ]);

  // 内存 Map 为空 = 任务跑完满 1 小时被 cleanupTimer 逐出，或进程重启过。
  const detail = await readTaskDetail("t2", new Map(), identityPublicTask);
  assert.ok(detail, "内存里没有也得查得到，否则任务中心点开昨天的任务会报「没有找到测试任务」");
  assert.equal(detail.status, "completed");
  assert.equal(detail.steps.length, 2, "详情必须带 steps，这正是「模型 × 步骤」明细的数据源");
  assert.equal(detail.steps[1].verdict, "not_passed");
  assert.deepEqual(detail.payload.profileIds, ["p9"], "「再测一次」要靠它回填表单");
  assert.equal(await readTaskDetail("nope", new Map(), identityPublicTask), null, "查不到的任务返回 null，交给上层报 404");
  assert.equal(await readTaskDetail("", new Map(), identityPublicTask), null);
});

test("readTaskDetail 把停在 running 的僵尸任务改判为 interrupted", async () => {
  // 事件流最后停在 running = 进程在任务跑到一半时退出了。这类任务不会再自己推进，
  // 必须显式改判，否则前端会对着一个永不变化的「运行中」无限轮询。
  await writeTaskEvents([startedEvent("t3", { profileIds: ["p3"] }, "2026-08-05T02:00:00.000Z")]);

  const detail = await readTaskDetail("t3", new Map(), identityPublicTask);
  assert.equal(detail.status, "interrupted");
  assert.equal(detail.recoverable, false);
  assert.match(detail.message, /中断/);

  // 内存里还在 = 任务真的在跑，此时不得改判，否则会把正在跑的任务显示成已中断。
  const liveMap = new Map([["t3", { id: "t3", status: "running" }]]);
  const live = await readTaskDetail("t3", liveMap, identityPublicTask);
  assert.equal(live.status, "running");
  assert.equal(live.recoverable, true);
});
