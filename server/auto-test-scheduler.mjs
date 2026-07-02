// server/auto-test-scheduler.mjs
// 自动测试调度器：平台首个（也是唯一）周期性定时器。每 tick 读作业配置，把「已启用且已到期」的作业
// 逐个触发一次对应测试（直接调用 test-runner 的 runner，各自产出报告），再把 lastRunAt/nextRunAt/lastStatus/
// lastReportId 写回作业配置。
//
// 可靠性边界：调度器是【进程内】的，仅在服务器运行时生效。重启后凭持久化的 nextRunAt 追补（首个 tick 补跑
// 过期作业）；进程若在某次测试中途崩溃，那一次不会自动续跑（与任务管理器一致，需下个周期或手动重跑）。
// 依赖全部注入，便于单测（假 loadJobs/updateJobs/runners、可控 now）。
//
// 加固：
//  1) 写盘串行化——回写作业状态统一走注入的 updateJobs（store 里一把锁），与端点增删改互不覆盖。
//  2) 全局并发闸——同时最多跑 maxConcurrent 个作业（信号量），避免多作业同刻到期时压垮上游 API。
//     作业在【等待信号量之前】就标记进 runningJobIds，故跨 tick 不会重复触发同一作业。
import { computeNextRunAt } from "./auto-test-store.mjs";

export function createAutoTestScheduler({
  loadJobs,
  updateJobs,
  runners,
  reportIdFromHtmlPath,
  onRunComplete, // (result) => void：运行完成回调（用于高危报告提示等），best-effort
  logError,
  tickMs = 60_000,
  maxConcurrent = Math.max(1, Number(process.env.EVALUATOR_AUTO_TEST_CONCURRENCY || 2)),
  now = () => Date.now(),
}) {
  const runningJobIds = new Set();
  let timer = null;

  // 并发信号量（与 task-manager 同款）：acquire 拿槽/排队，release 直接转交等待者，计数守恒。
  let activeSlots = 0;
  const slotWaiters = [];
  function acquireSlot() {
    if (activeSlots < maxConcurrent) {
      activeSlots += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => slotWaiters.push(resolve));
  }
  function releaseSlot() {
    const next = slotWaiters.shift();
    if (next) next();
    else activeSlots = Math.max(0, activeSlots - 1);
  }

  function isDue(job, nowMs) {
    if (!job.nextRunAt) return true; // 无 nextRunAt（新启用/迁移）→ 立即到期
    const t = Date.parse(job.nextRunAt);
    return !Number.isFinite(t) || t <= nowMs;
  }

  // kind → 一个无参 thunk，调对应 runner（taskContext 传 {}，脱离任务管理器直接跑）。
  function buildRun(job) {
    const id = job.targetId;
    const o = job.options || {};
    switch (job.kind) {
      case "quick":
        return () => runners.runQuickVerify({ profileId: id });
      case "admission":
        return () => runners.runAdmissionTest({ profileId: id, packageLevel: o.packageLevel || "standard" });
      case "stability":
        // prompt 为空时 runStabilityForProfile 会回退内置默认文案，故直接透传（含空串）安全。
        return () =>
          runners.runStabilityTest({ profileId: id, rounds: o.rounds || 10, concurrency: o.concurrency || 1, prompt: o.prompt || "" });
      case "scenario":
        return () =>
          runners.runScenarioTest({
            profileIds: [id],
            scenarioIds: job.scenarioIds?.length ? job.scenarioIds : ["connectivity-basic"],
            repeats: o.repeats || 1,
          });
      default:
        return null;
    }
  }

  // 回写单条作业：走串行化的 updateJobs（store 内一把锁），与端点写互不覆盖。
  function patchJob(id, patch) {
    return updateJobs((jobs) => {
      const target = jobs.find((j) => j.id === id);
      if (target) Object.assign(target, patch);
      return target || null;
    });
  }

  async function fireJob(job) {
    // 先同步查重 + 占位：在任何 await 之前把 id 记入 runningJobIds，
    // 这样即便本作业还在信号量队列里等待，跨 tick 也不会被重复触发。
    if (runningJobIds.has(job.id)) return;
    const run = buildRun(job);
    if (!run) return;
    runningJobIds.add(job.id);
    try {
      await acquireSlot(); // 全局并发闸：超出上限则排队
      try {
        const startedMs = now();
        const startedIso = new Date(startedMs).toISOString();
        const nextRunAt = computeNextRunAt(job.periodHours, startedMs);
        await patchJob(job.id, { lastStatus: "running" });
        try {
          const result = await run();
          // 运行完成回调（高危报告提示按开关判危记录）：best-effort，绝不影响调度与状态回写。
          try {
            await onRunComplete?.(result);
          } catch {
            /* 回调失败不影响调度 */
          }
          // 「成功」= 这次运行执行完成并产出结果；模型是否通过在报告里，不在作业状态里。
          // config 级失败（如目标不存在）会返回 success:false / normalizedError，算 failed。
          const ok = Boolean(result) && result.success !== false && !result.normalizedError && !result.error;
          const reportId = reportIdFromHtmlPath?.(result?.reportHtmlPath || result?.reportPath || "") || "";
          await patchJob(job.id, {
            lastRunAt: startedIso,
            nextRunAt,
            lastStatus: ok ? "success" : "failed",
            lastReportId: reportId || null,
            lastError: ok ? null : String(result?.message || result?.normalizedError || "测试未成功").slice(0, 500),
          });
        } catch (error) {
          try {
            await logError?.(error, job);
          } catch {
            // 记录失败不应影响调度
          }
          await patchJob(job.id, {
            lastRunAt: startedIso,
            nextRunAt,
            lastStatus: "failed",
            lastError: String(error?.message || error).slice(0, 500),
          });
        }
      } finally {
        releaseSlot();
      }
    } finally {
      runningJobIds.delete(job.id);
    }
  }

  async function tick() {
    let jobs;
    try {
      jobs = await loadJobs();
    } catch {
      return;
    }
    const nowMs = now();
    const due = jobs.filter((j) => j.enabled && !runningJobIds.has(j.id) && isDue(j, nowMs));
    // 并发触发但受信号量封顶（最多 maxConcurrent 个同时跑），其余在信号量队列里等。
    // 每个 fireJob 在首个 await 前已把 id 记入 runningJobIds，故本轮内不会重复、跨 tick 也不会重复。
    await Promise.all(due.map((job) => fireJob(job)));
  }

  async function runJobNow(id) {
    const jobs = await loadJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) return { ok: false, message: "作业不存在。" };
    if (runningJobIds.has(id)) return { ok: false, message: "该作业正在运行，请稍候。" };
    void fireJob(job); // 后台触发，不阻塞 HTTP 响应（测试可能跑数分钟）
    return { ok: true };
  }

  function start() {
    if (timer) return;
    void tick(); // 启动即跑一次做停机追补
    timer = setInterval(() => void tick(), tickMs);
    timer.unref?.(); // 不因调度器让本应退出的进程保持存活（listen 的 socket 才是存活来源）
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick, fireJob, runJobNow, runningJobIds };
}
