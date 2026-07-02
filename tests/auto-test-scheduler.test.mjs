// tests/auto-test-scheduler.test.mjs
// 调度器纯逻辑测试：注入假 loadJobs/saveJobs（内存表）+ 假 runner（记录调用）+ 可控 now。
// 断言：仅 enabled&&due 被触发、kind→runner 映射与 payload 正确、触发后运行态字段更新、
// 防重入、runner 抛错不影响其他作业。绝不起真 server、不碰真配置。
import assert from "node:assert/strict";
import test from "node:test";
import { createAutoTestScheduler } from "../server/auto-test-scheduler.mjs";

// 内存作业表 + 假存储（updateJobs 忠实复刻 store 语义：串行链 + load 副本 → mutator 原地改 → 存回）。
function makeStore(initial) {
  let jobs = initial.map((j) => ({ ...j }));
  let chain = Promise.resolve();
  const runOnce = async (mutator) => {
    const arr = jobs.map((j) => ({ ...j }));
    const value = await mutator(arr);
    jobs = arr;
    return value;
  };
  return {
    loadJobs: async () => jobs.map((j) => ({ ...j })),
    updateJobs: (mutator) => {
      const next = chain.then(() => runOnce(mutator), () => runOnce(mutator));
      chain = next.then(() => {}, () => {});
      return next;
    },
    snapshot: () => jobs,
  };
}

// 记录调用的假 runner 组，可指定某个 runner 抛错。
function makeRunners(overrides = {}) {
  const calls = [];
  const mk = (name) => async (payload) => {
    calls.push({ name, payload });
    if (overrides[name]) return overrides[name](payload);
    return { success: true, reportHtmlPath: `/reports/${name}_20260702_000000_abcd.html` };
  };
  return {
    calls,
    runners: {
      runQuickVerify: mk("runQuickVerify"),
      runAdmissionTest: mk("runAdmissionTest"),
      runStabilityTest: mk("runStabilityTest"),
      runScenarioTest: mk("runScenarioTest"),
    },
  };
}

const reportIdFromHtmlPath = (p) => (p ? String(p).split("/").pop().replace(/\.html$/, "") : "");
const NOW = Date.parse("2026-07-02T12:00:00.000Z");

function build(store, runners, extra = {}) {
  return createAutoTestScheduler({
    loadJobs: store.loadJobs,
    updateJobs: store.updateJobs,
    runners,
    reportIdFromHtmlPath,
    now: () => NOW,
    ...extra,
  });
}

test("tick：仅触发 enabled && due 的作业；未到期/停用的不动", async () => {
  const store = makeStore([
    { id: "due", targetId: "t1", kind: "quick", periodHours: 1, enabled: true, nextRunAt: "2026-07-02T11:00:00.000Z" },
    { id: "future", targetId: "t2", kind: "quick", periodHours: 1, enabled: true, nextRunAt: "2026-07-02T13:00:00.000Z" },
    { id: "disabled", targetId: "t3", kind: "quick", periodHours: 1, enabled: false, nextRunAt: "2026-07-02T11:00:00.000Z" },
    { id: "no-next", targetId: "t4", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
  ]);
  const { calls, runners } = makeRunners();
  await build(store, runners).tick();
  const fired = calls.map((c) => c.payload.profileId).sort();
  assert.deepEqual(fired, ["t1", "t4"], "只有 due 与 无 nextRunAt 的被触发");
});

test("kind→runner 映射与 payload 正确", async () => {
  const store = makeStore([
    { id: "a", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
    { id: "b", targetId: "ta", kind: "admission", periodHours: 1, enabled: true, nextRunAt: null, options: { packageLevel: "deep" } },
    { id: "c", targetId: "ts", kind: "stability", periodHours: 1, enabled: true, nextRunAt: null, options: { rounds: 20, concurrency: 3, prompt: "自定义文案" } },
    { id: "d", targetId: "tc", kind: "scenario", periodHours: 1, enabled: true, nextRunAt: null, scenarioIds: ["s1", "s2"], options: { repeats: 2 } },
  ]);
  const { calls, runners } = makeRunners();
  await build(store, runners).tick();
  const byName = Object.fromEntries(calls.map((c) => [c.name, c.payload]));
  assert.deepEqual(byName.runQuickVerify, { profileId: "tq" });
  assert.deepEqual(byName.runAdmissionTest, { profileId: "ta", packageLevel: "deep" });
  assert.deepEqual(byName.runStabilityTest, { profileId: "ts", rounds: 20, concurrency: 3, prompt: "自定义文案" });
  assert.deepEqual(byName.runScenarioTest, { profileIds: ["tc"], scenarioIds: ["s1", "s2"], repeats: 2 });
});

test("scenario 作业无选题 → 回退默认 connectivity-basic", async () => {
  const store = makeStore([
    { id: "d", targetId: "tc", kind: "scenario", periodHours: 1, enabled: true, nextRunAt: null, scenarioIds: [] },
  ]);
  const { calls, runners } = makeRunners();
  await build(store, runners).tick();
  assert.deepEqual(calls[0].payload.scenarioIds, ["connectivity-basic"]);
});

test("触发后：lastRunAt/nextRunAt/lastStatus/lastReportId 更新", async () => {
  const store = makeStore([
    { id: "a", targetId: "tq", kind: "quick", periodHours: 3, enabled: true, nextRunAt: null },
  ]);
  const { runners } = makeRunners();
  await build(store, runners).tick();
  const job = store.snapshot()[0];
  assert.equal(job.lastStatus, "success");
  assert.equal(job.lastRunAt, "2026-07-02T12:00:00.000Z");
  assert.equal(job.nextRunAt, "2026-07-02T15:00:00.000Z", "now + 3h");
  assert.equal(job.lastReportId, "runQuickVerify_20260702_000000_abcd");
  assert.equal(job.lastError, null);
});

test("runner 抛错 → 该作业 lastStatus=failed + lastError；其他作业照常", async () => {
  const store = makeStore([
    { id: "boom", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
    { id: "ok", targetId: "ts", kind: "stability", periodHours: 1, enabled: true, nextRunAt: null },
  ]);
  const { runners } = makeRunners({
    runQuickVerify: () => {
      throw new Error("上游炸了");
    },
  });
  let logged = null;
  await build(store, runners, { logError: (err, job) => { logged = { msg: err.message, id: job.id }; } }).tick();
  const boom = store.snapshot().find((j) => j.id === "boom");
  const ok = store.snapshot().find((j) => j.id === "ok");
  assert.equal(boom.lastStatus, "failed");
  assert.match(boom.lastError, /上游炸了/);
  assert.ok(boom.nextRunAt, "失败也要排下次");
  assert.equal(ok.lastStatus, "success", "一个作业失败不拖累其他");
  assert.deepEqual(logged, { msg: "上游炸了", id: "boom" }, "错误被上报");
});

test("config 级失败（runner 返回 success:false）→ failed 且带 lastError", async () => {
  const store = makeStore([
    { id: "a", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
  ]);
  const { runners } = makeRunners({
    runQuickVerify: () => ({ success: false, normalizedError: "profile_not_found", message: "没有找到被测 API 配置。" }),
  });
  await build(store, runners).tick();
  const job = store.snapshot()[0];
  assert.equal(job.lastStatus, "failed");
  assert.match(job.lastError, /没有找到被测/);
});

test("并发闸：maxConcurrent=1 时，多作业同刻到期也一次只跑一个", async () => {
  const store = makeStore([
    { id: "j1", targetId: "t1", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
    { id: "j2", targetId: "t2", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
  ]);
  const started = [];
  const resolvers = [];
  const runners = {
    runQuickVerify: (payload) => {
      started.push(payload.profileId);
      return new Promise((r) => resolvers.push(() => r({ success: true })));
    },
    runAdmissionTest: async () => ({ success: true }),
    runStabilityTest: async () => ({ success: true }),
    runScenarioTest: async () => ({ success: true }),
  };
  const scheduler = build(store, runners, { maxConcurrent: 1 });
  const p = scheduler.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started.length, 1, "只有一个进入运行，另一个在信号量排队");
  resolvers[0]();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started.length, 2, "第一个完成后第二个才开始");
  resolvers[1]();
  await p;
  assert.equal(store.snapshot().every((j) => j.lastStatus === "success"), true, "两条最终都跑完");
});

test("防重入：fireJob 运行中期间同一作业不被再次触发", async () => {
  const store = makeStore([
    { id: "slow", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
  ]);
  let resolveRun;
  const { calls, runners } = makeRunners({
    runQuickVerify: () => new Promise((r) => { resolveRun = () => r({ success: true }); }),
  });
  const scheduler = build(store, runners);
  const first = scheduler.tick(); // 触发 slow，卡在 pending
  await new Promise((r) => setTimeout(r, 10));
  await scheduler.tick(); // 第二次 tick：slow 仍在 runningJobIds，应被跳过
  assert.equal(calls.length, 1, "运行中不重复触发");
  resolveRun();
  await first;
});
