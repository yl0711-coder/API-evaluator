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

test("熔断：连续失败达阈值 → 自动停用（enabled=false, nextRunAt=null, autoDisabledAt+原因）", async () => {
  const store = makeStore([
    { id: "f", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
  ]);
  const { runners } = makeRunners({ runQuickVerify: () => { throw new Error("挂了"); } });
  const scheduler = build(store, runners, { maxConsecutiveFailures: 3 });
  for (let i = 0; i < 3; i++) await scheduler.fireJob(store.snapshot()[0]);
  const job = store.snapshot()[0];
  assert.equal(job.consecutiveFailures, 3);
  assert.equal(job.enabled, false, "达阈值自动停用");
  assert.equal(job.nextRunAt, null, "停用清空 nextRunAt");
  assert.ok(job.autoDisabledAt, "记录 autoDisabledAt");
  assert.match(job.lastError, /连续失败 3 次/);
});

test("熔断计数：一次成功即复位 consecutiveFailures=0，不停用", async () => {
  const store = makeStore([
    { id: "f", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null, consecutiveFailures: 2 },
  ]);
  const { runners } = makeRunners(); // 默认成功
  await build(store, runners, { maxConsecutiveFailures: 3 }).fireJob(store.snapshot()[0]);
  const job = store.snapshot()[0];
  assert.equal(job.consecutiveFailures, 0, "成功复位熔断计数");
  assert.equal(job.enabled, true);
});

test("config 级失败（success:false）也累加熔断计数并可触发停用", async () => {
  const store = makeStore([
    { id: "f", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
  ]);
  const { runners } = makeRunners({
    runQuickVerify: () => ({ success: false, normalizedError: "profile_not_found" }),
  });
  const scheduler = build(store, runners, { maxConsecutiveFailures: 2 });
  await scheduler.fireJob(store.snapshot()[0]);
  await scheduler.fireJob(store.snapshot()[0]);
  const job = store.snapshot()[0];
  assert.equal(job.consecutiveFailures, 2);
  assert.equal(job.enabled, false, "config 级失败同样计入熔断");
});

test("熔断阈值=0 → 永不自动停用（仅累加计数）", async () => {
  const store = makeStore([
    { id: "f", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
  ]);
  const { runners } = makeRunners({ runQuickVerify: () => { throw new Error("x"); } });
  const scheduler = build(store, runners, { maxConsecutiveFailures: 0 });
  for (let i = 0; i < 6; i++) await scheduler.fireJob(store.snapshot()[0]);
  const job = store.snapshot()[0];
  assert.equal(job.enabled, true, "阈值 0 关闭熔断");
  assert.equal(job.consecutiveFailures, 6);
});

test("对账：启动时把僵尸 running 归位为 interrupted 并计一次失败；非 running 不动", async () => {
  const store = makeStore([
    { id: "zombie", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null, lastStatus: "running", consecutiveFailures: 0 },
    { id: "normal", targetId: "ts", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null, lastStatus: "success" },
  ]);
  const { runners } = makeRunners();
  await build(store, runners, { maxConsecutiveFailures: 5 }).reconcileInterruptedJobs();
  const zombie = store.snapshot().find((j) => j.id === "zombie");
  const normal = store.snapshot().find((j) => j.id === "normal");
  assert.equal(zombie.lastStatus, "interrupted");
  assert.equal(zombie.consecutiveFailures, 1);
  assert.match(zombie.lastError, /进程中断/);
  assert.equal(normal.lastStatus, "success", "非 running 不受对账影响");
});

test("对账：僵尸作业濒临阈值 → 这次中断失败直接触发熔断停用（收敛 OOM 崩溃循环）", async () => {
  const store = makeStore([
    { id: "z", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: "2026-07-02T13:00:00.000Z", lastStatus: "running", consecutiveFailures: 2 },
  ]);
  const { runners } = makeRunners();
  await build(store, runners, { maxConsecutiveFailures: 3 }).reconcileInterruptedJobs();
  const z = store.snapshot()[0];
  assert.equal(z.consecutiveFailures, 3);
  assert.equal(z.enabled, false);
  assert.equal(z.nextRunAt, null);
  assert.ok(z.autoDisabledAt);
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

test("runJobNow：作业不存在 → { ok:false }，不触发任何 runner", async () => {
  const store = makeStore([
    { id: "a", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
  ]);
  const { calls, runners } = makeRunners();
  const res = await build(store, runners).runJobNow("missing");
  assert.equal(res.ok, false);
  assert.match(res.message, /不存在/);
  assert.equal(calls.length, 0, "不存在的作业不触发 runner");
});

test("runJobNow：后台触发存在的作业 → { ok:true } 且最终写回运行态（含重算 nextRunAt）", async () => {
  const store = makeStore([
    { id: "a", targetId: "tq", kind: "quick", periodHours: 2, enabled: true, nextRunAt: null },
  ]);
  const { calls, runners } = makeRunners();
  const res = await build(store, runners).runJobNow("a");
  assert.deepEqual(res, { ok: true }, "受理即返回，不阻塞等测试跑完");
  await new Promise((r) => setTimeout(r, 20)); // 让后台 void fireJob 跑完
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.profileId, "tq");
  const job = store.snapshot()[0];
  assert.equal(job.lastStatus, "success");
  assert.equal(job.nextRunAt, "2026-07-02T14:00:00.000Z", "手动运行也重算 nextRunAt(now+2h)");
});

test("runJobNow：作业正在运行 → { ok:false }，不重复触发", async () => {
  const store = makeStore([
    { id: "slow", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
  ]);
  let resolveRun;
  const { calls, runners } = makeRunners({
    runQuickVerify: () => new Promise((r) => { resolveRun = () => r({ success: true }); }),
  });
  const scheduler = build(store, runners);
  const first = await scheduler.runJobNow("slow"); // 后台触发，卡在 pending runner
  assert.equal(first.ok, true);
  await new Promise((r) => setTimeout(r, 10));
  const again = await scheduler.runJobNow("slow"); // 仍在 runningJobIds，应被挡
  assert.equal(again.ok, false);
  assert.match(again.message, /正在运行/);
  assert.equal(calls.length, 1, "运行中重复点『立即运行』不重复触发上游");
  resolveRun();
  await new Promise((r) => setTimeout(r, 10));
});

test("runJobNow：手动运行放行已停用作业（绕过 enabled 门禁），但不改其启用态", async () => {
  const store = makeStore([
    { id: "off", targetId: "tq", kind: "quick", periodHours: 1, enabled: false, nextRunAt: null, autoDisabledAt: "2026-07-01T00:00:00.000Z" },
  ]);
  const { calls, runners } = makeRunners();
  const res = await build(store, runners).runJobNow("off");
  assert.equal(res.ok, true, "停用（含熔断自停）作业也能被手动立即运行");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  const job = store.snapshot()[0];
  assert.equal(job.lastStatus, "success");
  assert.equal(job.enabled, false, "手动运行不复活作业，启用态仍由配置端点掌控");
});
