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
      const next = chain.then(
        () => runOnce(mutator),
        () => runOnce(mutator),
      );
      chain = next.then(
        () => {},
        () => {},
      );
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

const reportIdFromHtmlPath = (p) =>
  p
    ? String(p)
        .split("/")
        .pop()
        .replace(/\.html$/, "")
    : "";
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
    {
      id: "c",
      targetId: "ts",
      kind: "stability",
      periodHours: 1,
      enabled: true,
      nextRunAt: null,
      options: { concurrency: 3, groups: [{ presetId: "custom", prompt: "自定义文案", repeats: 20 }] },
    },
    {
      id: "d",
      targetId: "tc",
      kind: "scenario",
      periodHours: 1,
      enabled: true,
      nextRunAt: null,
      scenarioIds: ["s1", "s2"],
      options: { repeats: 2 },
    },
  ]);
  const { calls, runners } = makeRunners();
  await build(store, runners).tick();
  const byName = Object.fromEntries(calls.map((c) => [c.name, c.payload]));
  assert.deepEqual(byName.runQuickVerify, { profileId: "tq" });
  assert.deepEqual(byName.runAdmissionTest, { profileId: "ta", packageLevel: "deep" });
  assert.deepEqual(byName.runStabilityTest, {
    profileId: "ts",
    concurrency: 3,
    groups: [{ presetId: "custom", prompt: "自定义文案", repeats: 20 }],
  });
  assert.deepEqual(byName.runScenarioTest, { profileIds: ["tc"], scenarioIds: ["s1", "s2"], repeats: 2 });
});

test("scenario 作业无选题 → 回退默认 connectivity-basic", async () => {
  const store = makeStore([{ id: "d", targetId: "tc", kind: "scenario", periodHours: 1, enabled: true, nextRunAt: null, scenarioIds: [] }]);
  const { calls, runners } = makeRunners();
  await build(store, runners).tick();
  assert.deepEqual(calls[0].payload.scenarioIds, ["connectivity-basic"]);
});

test("触发后：lastRunAt/nextRunAt/lastStatus/lastReportId 更新", async () => {
  const store = makeStore([{ id: "a", targetId: "tq", kind: "quick", periodHours: 3, enabled: true, nextRunAt: null }]);
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
  await build(store, runners, {
    logError: (err, job) => {
      logged = { msg: err.message, id: job.id };
    },
  }).tick();
  const boom = store.snapshot().find((j) => j.id === "boom");
  const ok = store.snapshot().find((j) => j.id === "ok");
  assert.equal(boom.lastStatus, "failed");
  assert.match(boom.lastError, /上游炸了/);
  assert.ok(boom.nextRunAt, "失败也要排下次");
  assert.equal(ok.lastStatus, "success", "一个作业失败不拖累其他");
  assert.deepEqual(logged, { msg: "上游炸了", id: "boom" }, "错误被上报");
});

test("config 级失败（runner 返回 success:false）→ failed 且带 lastError", async () => {
  const store = makeStore([{ id: "a", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }]);
  const { runners } = makeRunners({
    runQuickVerify: () => ({ success: false, normalizedError: "profile_not_found", message: "没有找到被测 API 配置。" }),
  });
  await build(store, runners).tick();
  const job = store.snapshot()[0];
  assert.equal(job.lastStatus, "failed");
  assert.match(job.lastError, /没有找到被测/);
});

test("历史遗留的无执行时刻 cron 会被停用，且绝不发起上游请求", async () => {
  const store = makeStore([{ id: "bad-cron", targetId: "tq", kind: "quick", cron: "0 0 30 2 *", enabled: true, nextRunAt: null }]);
  const { calls, runners } = makeRunners();
  await build(store, runners).tick();

  const job = store.snapshot()[0];
  assert.equal(calls.length, 0, "发现坏 cron 后不能再调用上游");
  assert.equal(job.enabled, false);
  assert.equal(job.nextRunAt, null);
  assert.equal(job.lastStatus, "invalid_schedule");
  assert.match(job.lastError, /未来四年内没有可执行时刻/);
});

test("立即运行也拒绝历史坏 cron，不能先回成功再悄悄停用", async () => {
  const store = makeStore([{ id: "bad-cron-now", targetId: "tq", kind: "quick", cron: "0 0 30 2 *", enabled: true, nextRunAt: null }]);
  const { calls, runners } = makeRunners();
  const result = await build(store, runners).runJobNow("bad-cron-now");

  assert.equal(result.ok, false);
  assert.match(result.message, /没有可执行时刻/);
  assert.equal(calls.length, 0);
  assert.equal(store.snapshot()[0].enabled, false);
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
  assert.equal(
    store.snapshot().every((j) => j.lastStatus === "success"),
    true,
    "两条最终都跑完",
  );
});

test("熔断：连续失败达阈值 → 自动停用（enabled=false, nextRunAt=null, autoDisabledAt+原因）", async () => {
  const store = makeStore([{ id: "f", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }]);
  const { runners } = makeRunners({
    runQuickVerify: () => {
      throw new Error("挂了");
    },
  });
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
  const store = makeStore([{ id: "f", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }]);
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
  const store = makeStore([{ id: "f", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }]);
  const { runners } = makeRunners({
    runQuickVerify: () => {
      throw new Error("x");
    },
  });
  const scheduler = build(store, runners, { maxConsecutiveFailures: 0 });
  for (let i = 0; i < 6; i++) await scheduler.fireJob(store.snapshot()[0]);
  const job = store.snapshot()[0];
  assert.equal(job.enabled, true, "阈值 0 关闭熔断");
  assert.equal(job.consecutiveFailures, 6);
});

test("对账：启动时把僵尸 running 归位为 interrupted 并计一次失败；非 running 不动", async () => {
  const store = makeStore([
    {
      id: "zombie",
      targetId: "tq",
      kind: "quick",
      periodHours: 1,
      enabled: true,
      nextRunAt: null,
      lastStatus: "running",
      consecutiveFailures: 0,
    },
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
    {
      id: "z",
      targetId: "tq",
      kind: "quick",
      periodHours: 1,
      enabled: true,
      nextRunAt: "2026-07-02T13:00:00.000Z",
      lastStatus: "running",
      consecutiveFailures: 2,
    },
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
  const store = makeStore([{ id: "slow", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }]);
  let resolveRun;
  const { calls, runners } = makeRunners({
    runQuickVerify: () =>
      new Promise((r) => {
        resolveRun = () => r({ success: true });
      }),
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
  const store = makeStore([{ id: "a", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }]);
  const { calls, runners } = makeRunners();
  const res = await build(store, runners).runJobNow("missing");
  assert.equal(res.ok, false);
  assert.match(res.message, /不存在/);
  assert.equal(calls.length, 0, "不存在的作业不触发 runner");
});

test("runJobNow：后台触发存在的作业 → { ok:true } 且最终写回运行态（含重算 nextRunAt）", async () => {
  const store = makeStore([{ id: "a", targetId: "tq", kind: "quick", periodHours: 2, enabled: true, nextRunAt: null }]);
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
  const store = makeStore([{ id: "slow", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }]);
  let resolveRun;
  const { calls, runners } = makeRunners({
    runQuickVerify: () =>
      new Promise((r) => {
        resolveRun = () => r({ success: true });
      }),
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
    {
      id: "off",
      targetId: "tq",
      kind: "quick",
      periodHours: 1,
      enabled: false,
      nextRunAt: null,
      autoDisabledAt: "2026-07-01T00:00:00.000Z",
    },
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

// —— 回归（P2-4）：盘写失败不能掀翻进程 ——
// fireJob 里有两处状态回写不在内层 catch 覆盖内（占位 lastStatus="running"、失败分支的回写）。
// updateJobs 落盘失败（盘满 / EACCES）时异常会一路冒到三个「拒绝无人接管」的调用点
// （tick 的 Promise.all、start 的 void reconcileThenTick、runJobNow 的 void fireJob），
// 变成 unhandledRejection —— Node 默认直接杀进程，一次盘写失败打死整个评测平台。

// 所有写盘都失败的假存储（读得到、写就抛，模拟 ENOSPC / EACCES）。
function makeFailingStore(initial) {
  const jobs = initial.map((j) => ({ ...j }));
  return {
    loadJobs: async () => jobs.map((j) => ({ ...j })),
    updateJobs: async () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    },
    snapshot: () => jobs,
  };
}

test("盘写失败：tick 不拒绝（否则 void tick() → unhandledRejection → 杀进程）（P2-4 回归）", async () => {
  const store = makeFailingStore([{ id: "a", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }]);
  const { runners } = makeRunners();
  const logged = [];
  const scheduler = build(store, runners, { logError: (err, job) => logged.push({ code: err.code, id: job?.id }) });

  await assert.doesNotReject(() => scheduler.tick(), "tick 必须自己咽下盘写失败");
  assert.deepEqual(logged, [{ code: "ENOSPC", id: "a" }], "错误仍要被上报，不能静默吞掉");
});

test("盘写失败：runJobNow 的后台 fireJob 不产生无人接管的拒绝（P2-4 回归）", async () => {
  const store = makeFailingStore([{ id: "a", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }]);
  const { runners } = makeRunners();
  const scheduler = build(store, runners, { logError: () => {} });

  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const res = await scheduler.runJobNow("a"); // 内部是 void fireJob(job)
    assert.equal(res.ok, true);
    await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => setImmediate(r));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(rejections, [], "「立即运行」遇盘写失败不得产生 unhandledRejection");
});

test("盘写失败：两个作业各自失败，互不拖累，且都不拒绝（P2-4 回归）", async () => {
  const store = makeFailingStore([
    { id: "a", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null },
    { id: "b", targetId: "ts", kind: "stability", periodHours: 1, enabled: true, nextRunAt: null },
  ]);
  const { calls, runners } = makeRunners();
  const logged = [];
  const scheduler = build(store, runners, { logError: (err, job) => logged.push(job?.id) });

  await assert.doesNotReject(() => scheduler.tick());
  // 占位回写 lastStatus="running" 排在 runner 之前，故全盘写失败时 runner 根本轮不到调用。
  // 这正是第一个逃逸点：过去这里抛出后会一路冒成 unhandledRejection。
  assert.equal(calls.length, 0, "占位回写就失败了，不该已经打到上游");
  assert.deepEqual(logged.sort(), ["a", "b"], "两个作业各自失败各自上报，互不拖累");
  assert.equal(scheduler.runningJobIds.size, 0, "失败后必须解除占位，否则作业永远不再被触发");
});

test("盘写失败后占位被解除，盘恢复前的下一轮仍会重试（P2-4 回归）", async () => {
  const store = makeFailingStore([{ id: "a", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }]);
  const { runners } = makeRunners();
  const logged = [];
  const scheduler = build(store, runners, { logError: (err, job) => logged.push(job?.id) });

  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(logged, ["a", "a"], "占位没解除的话第二轮会被防重入挡掉，只会有一次");
});

// 第二个逃逸点：跑完之后的状态回写。占位写得进、runner 也跑完了，落盘时才失败
// （更贴近真实：盘在测试运行的几分钟里写满了）。此时异常从失败分支的 patchJobWith 冒出。
function makeStoreFailingAfter(initial, okWrites) {
  const jobs = initial.map((j) => ({ ...j }));
  let writes = 0;
  return {
    loadJobs: async () => jobs.map((j) => ({ ...j })),
    updateJobs: async (mutator) => {
      writes += 1;
      if (writes > okWrites) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      const arr = jobs.map((j) => ({ ...j }));
      const value = await mutator(arr);
      jobs.splice(0, jobs.length, ...arr);
      return value;
    },
    snapshot: () => jobs,
  };
}

test("跑完后回写失败：结果丢了但进程活着（P2-4 回归，第二个逃逸点）", async () => {
  const store = makeStoreFailingAfter(
    [{ id: "a", targetId: "tq", kind: "quick", periodHours: 1, enabled: true, nextRunAt: null }],
    1, // 第 1 次写（占位 running）成功，之后全失败
  );
  const { calls, runners } = makeRunners();
  const logged = [];
  const scheduler = build(store, runners, { logError: (err, job) => logged.push({ code: err.code, id: job?.id }) });

  await assert.doesNotReject(() => scheduler.tick(), "跑完后回写失败同样不得拒绝");
  assert.equal(calls.length, 1, "上游确实被打了一次");
  // 两条日志对应真实的失败链路：成功分支回写(第2次写)失败 → 内层 catch 记一次 → 它再试着
  // 回写 "failed" 状态(第3次写) → 又失败 → 从内层 catch 里冒出来 → 外层兜底记第二次。
  // 过去没有外层兜底，第二次失败就是那个杀进程的 unhandledRejection。
  assert.deepEqual(logged, [
    { code: "ENOSPC", id: "a" },
    { code: "ENOSPC", id: "a" },
  ]);
  // 盘上停在 "running"：这是可接受的降级，启动时的 reconcileInterruptedJobs 会把它归位为 interrupted。
  assert.equal(store.snapshot()[0].lastStatus, "running", "回写没成功，状态停在占位值");
  assert.equal(scheduler.runningJobIds.size, 0, "内存占位仍必须解除");
});

// —— 活性心跳（getStatus().stale）回归 —— //
// 这段判定曾在 80624fc（7月7日）连同它的测试一起被静默删除，而 deploy/docker-compose 的健康检查
// 仍在断言 j.autoTest.stale——导致「调度器僵死」这一故障永远不会被 autoheal 感知。此测试守住它别再丢。
test("getStatus：未启动不判僵死；心跳新鲜=not stale；超阈值=stale；停机后不 stale", async () => {
  let clock = NOW;
  const store = makeStore([]);
  const { runners } = makeRunners();
  const scheduler = build(store, runners, { tickMs: 1000, staleAfterMs: 5000, now: () => clock });

  assert.equal(scheduler.getStatus().running, false, "未启动 running=false");
  assert.equal(scheduler.getStatus().stale, false, "未启动不判僵死");

  scheduler.start();
  try {
    // start() 先把 lastTickAt 置为启动时刻，随后 reconcileThenTick 会跑一次 tick 再刷新一次心跳。
    await new Promise((r) => setImmediate(r)); // 让首个 tick 的微任务跑完
    assert.equal(scheduler.getStatus().stale, false, "刚 tick 过，心跳新鲜");

    clock += 6000; // 合成时钟推过 staleAfterMs=5000（真实定时器 1000ms 在假时钟下不会触发）
    assert.equal(scheduler.getStatus().stale, true, "心跳超阈值 → 判僵死");
  } finally {
    scheduler.stop();
  }
  assert.equal(scheduler.getStatus().stale, false, "停机后不再判僵死，避免关停期误重启");
});

// 密集固定时刻（多表达式 cron）+ 单轮耗时跨过下一个时刻：一天的总运行次数不该被放大。
// nextRunAt 是在 run 之前按开跑时刻算的、run 结束才写回；若单轮耗时跨过了下一个固定时刻，
// 写回的 nextRunAt 已成过去时，下一 tick 立刻又判到期。要守住的安全属性是「错过的槽位会塌缩，
// 不会累加」——每一轮都要真花钱，放大就是多扣费。这是固定时刻功能带来的新组合，此前无用例覆盖。
test("固定时刻：24 个密集时刻且每轮耗时超过间隔时，全天运行次数不超过配置的时刻数", async () => {
  const TIMES = Array.from({ length: 24 }, (_, i) => {
    const total = 9 * 60 + i * 5; // 北京 09:00 起，每 5 分钟一个
    return { hour: Math.floor(total / 60), minute: total % 60 };
  });
  const cron = TIMES.map(({ hour, minute }) => `${minute} ${hour} * * *`).join(";");
  const store = makeStore([{ id: "j-dense", targetId: "t", kind: "quick", cron, cronMode: "fixed", enabled: true, nextRunAt: null }]);
  let clock = Date.parse("2026-07-02T00:55:00.000Z"); // 北京 08:55，首个槽位前 5 分钟
  const DAY_END = Date.parse("2026-07-03T00:00:00.000Z"); // 次日北京 08:00，当天槽位已全部走完
  const runs = [];
  const runner = async () => {
    runs.push(clock);
    clock += 10 * 60 * 1000; // 每轮 10 分钟，必然跨过下一个（相隔 5 分钟的）时刻
    return { success: true, reportHtmlPath: "/reports/quick_20260702_000000_abcd.html" };
  };
  const scheduler = createAutoTestScheduler({
    loadJobs: store.loadJobs,
    updateJobs: store.updateJobs,
    runners: { runQuickVerify: runner, runAdmissionTest: runner, runStabilityTest: runner, runScenarioTest: runner },
    reportIdFromHtmlPath,
    now: () => clock,
  });

  let ticks = 0;
  while (clock < DAY_END && ticks < 5000) {
    const before = clock;
    await scheduler.tick();
    if (clock === before) clock += 60 * 1000; // 空 tick：时钟前进 1 分钟，保证循环收敛
    ticks += 1;
  }

  assert.ok(runs.length <= TIMES.length, `全天运行次数不该超过配置的时刻数（配置 ${TIMES.length}，实际 ${runs.length}）——超出即为重复扣费`);
  assert.ok(runs.length > 0, "前提校验：这批固定时刻当天应当真的跑过，否则本用例是空转的假绿");
});
