import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
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
const { recordEvaluationTask } = await import("../server/db.mjs");
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

// —— ADM-017：SQLite 落库与事件流【合并】读取 ——

// 这是本轮真正抓到的回归：最初实现写成"库里有数据就只读库"，
// 而升级那一刻 evaluation_tasks 是空的、JSONL 却有历史。用户一跑第一个新任务，
// 库里有了 1 行，于是全部历史任务从任务中心凭空消失。
test("ADM-017: 落库与事件流两个来源合并，升级后历史任务不会因新任务落库而消失", async () => {
  // JSONL 里的老任务（升级前跑的，库里没有）。
  await writeTaskEvents([
    startedEvent("legacy-task", { profileIds: ["p-old"] }, "2026-08-01T01:00:00.000Z"),
    { taskId: "legacy-task", type: "admission-suite", event: "completed", status: "completed", loggedAt: "2026-08-01T01:05:00.000Z" },
  ]);
  // 库里的新任务（升级后跑的）。
  await recordEvaluationTask({
    id: "db-task",
    type: "stability",
    status: "completed",
    createdBy: "zhangsan",
    createdAt: "2026-08-06T01:00:00.000Z",
    endedAt: "2026-08-06T01:03:00.000Z",
    progress: 100,
  });

  const list = await readRecentTasks(new Map(), identityPublicTask);
  const ids = list.map((task) => task.taskId);
  assert.ok(ids.includes("db-task"), "库里的新任务要在");
  assert.ok(ids.includes("legacy-task"), "事件流里的历史任务也必须在——只读库会让它消失");
  // 新任务排在前面（按时间倒序）。合并两个来源后排序字段不同名，写错会把两批数据交错乱放。
  assert.ok(ids.indexOf("db-task") < ids.indexOf("legacy-task"), "应按时间倒序，新任务在前");
  // 列表口径一致：两条来源都不带 steps。
  assert.ok(
    list.every((task) => task.steps === undefined),
    "列表刻意不带 steps",
  );
});

test("ADM-017: 同一任务两边都有时以库为准，且内存态覆盖库里的过时进度", async () => {
  const taskId = "both-sources";
  // 事件流停在 running（老快照）。
  await writeTaskEvents([startedEvent(taskId, { profileIds: ["p-x"] }, "2026-08-06T02:00:00.000Z")]);
  // 库里已经是 completed（更新的状态跃迁）。
  await recordEvaluationTask({
    id: taskId,
    type: "admission-suite",
    status: "completed",
    createdAt: "2026-08-06T02:00:00.000Z",
    endedAt: "2026-08-06T02:06:00.000Z",
    progress: 100,
  });

  const detail = await readTaskDetail(taskId, new Map(), identityPublicTask);
  assert.equal(detail.status, "completed", "库是权威当前态；若走事件流会显示成 interrupted");

  // 但内存里还在跑时，内存态优先：库只在状态跃迁时写，进度是内存最新。
  const liveMap = new Map([[taskId, { id: taskId, status: "running", progress: 42, steps: [{ stepName: "quick" }] }]]);
  const live = await readTaskDetail(taskId, liveMap, identityPublicTask);
  assert.equal(live.status, "running", "正在跑的任务不能被库里的旧终态盖成已完成");
  assert.equal(live.progress, 42);
  assert.equal(live.recoverable, true, "内存里有 = 真能取消");
  assert.equal(live.steps.length, 1, "明细路径要保留 steps");
});

// ADM-017 真正买到的能力：突破事件流「只读最后 300 行」的窗口。
// 这条用例是本文件里唯一【只有 SQLite 能满足】的——关掉落库它必红，
// 而前面那些用例走 JSONL 回退也能过。没有它，整个 ADM-017 就没有回归保护。
test("ADM-017: 被 300 行事件窗口挤掉的老任务，仍能从库里查到（事件流已查不到）", async () => {
  const buriedId = "buried-task";
  // 先把这个任务落库（模拟它当初跑完时写的那行）。
  await recordEvaluationTask({
    id: buriedId,
    type: "admission-suite",
    status: "completed",
    createdBy: "zhangsan",
    createdAt: "2026-07-01T01:00:00.000Z",
    endedAt: "2026-07-01T01:09:00.000Z",
    progress: 100,
    payload: { profileIds: ["p-buried"] },
    steps: [{ groupKey: "p-buried", stepName: "quick", executionStatus: "completed", verdict: "passed" }],
  });

  // 然后用 400 行【别的任务】的事件把它挤出 300 行窗口。
  const noise = [];
  for (let i = 0; i < 400; i += 1) {
    noise.push({
      taskId: `noise-${i}`,
      type: "stability",
      event: "completed",
      status: "completed",
      loggedAt: `2026-07-02T${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
    });
  }
  await writeTaskEvents(noise);

  // 证明前提成立：事件文件里根本没有这个 taskId（400 行噪声已整体覆盖写过），
  // 于是它绝不可能来自事件流那条路径。
  const rawEvents = await readFile(TASK_EVENTS_FILE, "utf8");
  assert.ok(!rawEvents.includes(buriedId), "前提：事件流里不得有这个任务，否则本用例没测到 SQLite 那条路");

  // 而详情仍然查得到——只可能来自 SQLite。
  const detail = await readTaskDetail(buriedId, new Map(), identityPublicTask);
  assert.ok(detail, "落库之后，事件窗口之外的任务也必须查得到——这正是 ADM-017 的目的");
  assert.equal(detail.status, "completed");
  assert.equal(detail.createdBy, "zhangsan");
  assert.deepEqual(detail.payload.profileIds, ["p-buried"], "「再测一次」的参数也要跨窗口保留");
  assert.equal(detail.steps.length, 1, "逐步骤明细同样来自库");
});
