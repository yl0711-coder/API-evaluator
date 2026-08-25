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
import { envInt } from "./env-config.mjs";
import { createExecutionLimiter } from "./execution-limiter.mjs";

export function createAutoTestScheduler({
  loadJobs,
  updateJobs,
  runners,
  reportIdFromHtmlPath,
  onRunComplete, // (result) => void：运行完成回调（用于高危报告提示等），best-effort
  // 每 tick 末尾调一次：报警汇总的发信时机判断（到点 + 调度器空闲才发）。best-effort。
  // 【为什么挂在这个 tick 上而不另起定时器】本调度器是「平台唯一的周期性定时器」（见文件头），
  // 这是一条有意维持的不变量：多一个 setInterval 就多一处僵死可能，而 /api/health 的活性判定
  // 只认这一个。汇总只需要分钟级精度，复用现成心跳足够。
  onTickEnd,
  logError,
  tickMs = 60_000,
  // 活性判定：距上次 tick 超过此毫秒数即判「僵死」（getStatus().stale=true），供 /api/health 暴露、
  // 容器健康检查 + 外部看门狗（autoheal）据此重启「进程活着但定时器僵死」的静默故障。
  staleAfterMs = tickMs * 5,
  // 平台级共享闸由 server.mjs 注入。未注入时只保留本调度器的私有闸，方便模块独立测试。
  executionLimiter,
  maxConcurrent = envInt("EVALUATOR_AUTO_TEST_CONCURRENCY", 1, { min: 1, max: 32 }),
  // 连续失败熔断阈值：作业连续失败达此次数即自动停用，避免被监控对象挂掉后无限空跑失败。
  // 0 = 关闭熔断。默认 5，可用 EVALUATOR_AUTO_TEST_MAX_FAILURES 覆盖。
  // 必须走 envInt：旧写法 Math.max(0, Number("abc")) = NaN，会让下方 `maxConsecutiveFailures > 0`
  // 恒为 false，熔断静默失效——配了熔断却不熔断，比压根没配更危险（P1-04）。
  maxConsecutiveFailures = envInt("EVALUATOR_AUTO_TEST_MAX_FAILURES", 5, { min: 0, max: 1000 }),
  now = () => Date.now(),
}) {
  const runningJobIds = new Set();
  let timer = null;
  // 活性时间戳（ms）：每个 tick 开始时刷新。start() 先置为启动时刻，避免启动瞬间被判僵死。
  let lastTickAt = null;

  // 自动作业保留自己的子额度（兼容 EVALUATOR_AUTO_TEST_CONCURRENCY），但每一项在真正执行前
  // 还必须取得平台共享额度。获取顺序固定为「自动子额度 → 共享额度」，避免自动作业在等子额度时
  // 先占用全局槽，饿死手工测试。
  const autoLimiter = createExecutionLimiter({ getLimit: () => maxConcurrent });
  const sharedLimiter = executionLimiter || autoLimiter;

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
        // groups 为空/缺失（迁移前旧作业）时 runStabilityForProfile 会退回内置默认文案单组跑 10 轮，
        // 故直接透传安全；新作业一律带 groups（多组文案+各自数量），见 auto-test-config.js collect()。
        return () => runners.runStabilityTest({ profileId: id, concurrency: o.concurrency || 1, groups: o.groups || [] });
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

  // 需按当前值增改（如累加 consecutiveFailures + 到阈值停用）时用的可变体，同样走串行化 updateJobs。
  function patchJobWith(id, mutate) {
    return updateJobs((jobs) => {
      const target = jobs.find((j) => j.id === id);
      if (target) mutate(target);
      return target || null;
    });
  }

  // 连续失败熔断：达阈值即自动停用（enabled=false、nextRunAt=null、记 autoDisabledAt+原因），
  // 待人工修复后在配置页重新启用（端点会清零 consecutiveFailures/autoDisabledAt 复活）。
  function maybeDisableForFailures(job) {
    if (maxConsecutiveFailures > 0 && (Number(job.consecutiveFailures) || 0) >= maxConsecutiveFailures) {
      job.enabled = false;
      job.nextRunAt = null;
      job.autoDisabledAt = new Date(now()).toISOString();
      job.lastError =
        `${job.lastError ? job.lastError + " " : ""}连续失败 ${job.consecutiveFailures} 次，已自动停用以避免无效重跑；请修复后在配置页重新启用。`.slice(
          0,
          500,
        );
    }
  }

  async function fireJob(job) {
    // 先同步查重 + 占位：在任何 await 之前把 id 记入 runningJobIds，
    // 这样即便本作业还在信号量队列里等待，跨 tick 也不会被重复触发。
    if (runningJobIds.has(job.id)) return;
    const run = buildRun(job);
    if (!run) return;
    runningJobIds.add(job.id);
    try {
      // 正常创建时 validateJob 已拒绝“语法合法但永远没有执行时刻”的 cron；这一层是对
      // 历史作业/手工写入 JSON 的兜底。绝不能跑一次再按 24h 回退，否则异常作业会悄悄花钱。
      if (job.cron && !computeNextRunAt(job, now())) {
        await patchJob(job.id, {
          enabled: false,
          nextRunAt: null,
          lastStatus: "invalid_schedule",
          lastError: "定时表达式在未来四年内没有可执行时刻，已自动停用；请修正后重新启用。",
        });
        return;
      }
      await autoLimiter.acquire();
      let sharedAcquired = false;
      try {
        if (sharedLimiter !== autoLimiter) {
          await sharedLimiter.acquire();
          sharedAcquired = true;
        }
        const startedMs = now();
        const startedIso = new Date(startedMs).toISOString();
        const nextRunAt = computeNextRunAt(job, startedMs);
        await patchJob(job.id, { lastStatus: "running" });
        try {
          const result = await run();
          // 运行完成回调（高危报告提示按开关判危记录）：best-effort，绝不影响调度与状态回写。
          // 第二个参数带上触发这次运行的作业身份：报警汇总要按作业筛选（哪些作业的报警攒起来、
          // 哪些立即发），而 result 里只有 profileId/type，认不出是哪个作业 ——
          // 同一个渠道+模型可以配多个作业（不同种类、不同节奏），profileId 不足以区分。
          try {
            await onRunComplete?.(result, { jobId: job.id, jobName: job.name, jobKind: job.kind });
          } catch {
            /* 回调失败不影响调度 */
          }
          // 「成功」= 这次运行执行完成并产出结果；模型是否通过在报告里，不在作业状态里。
          // config 级失败（如目标不存在）会返回 success:false / normalizedError，算 failed。
          const ok = Boolean(result) && result.success !== false && !result.normalizedError && !result.error;
          const reportId = reportIdFromHtmlPath?.(result?.reportHtmlPath || result?.reportPath || "") || "";
          await patchJobWith(job.id, (t) => {
            t.lastRunAt = startedIso;
            t.nextRunAt = nextRunAt;
            t.lastStatus = ok ? "success" : "failed";
            t.lastReportId = reportId || null;
            t.lastError = ok ? null : String(result?.message || result?.normalizedError || "测试未成功").slice(0, 500);
            if (ok) {
              t.consecutiveFailures = 0; // 成功即复位熔断计数
            } else {
              t.consecutiveFailures = (Number(t.consecutiveFailures) || 0) + 1;
              maybeDisableForFailures(t); // 达阈值则停用（会覆盖上面的 nextRunAt→null、enabled→false）
            }
          });
        } catch (error) {
          try {
            await logError?.(error, job);
          } catch {
            // 记录失败不应影响调度
          }
          await patchJobWith(job.id, (t) => {
            t.lastRunAt = startedIso;
            t.nextRunAt = nextRunAt;
            t.lastStatus = "failed";
            t.lastError = String(error?.message || error).slice(0, 500);
            t.consecutiveFailures = (Number(t.consecutiveFailures) || 0) + 1;
            maybeDisableForFailures(t);
          });
        }
      } finally {
        if (sharedAcquired) sharedLimiter.release();
        autoLimiter.release();
      }
    } catch (error) {
      // 兜底：本函数的三个调用点全是「拒绝无人接管」的形态 —— tick 里的 Promise.all、
      // start 里的 void reconcileThenTick()、runJobNow 里的 void fireJob(job)。一旦本函数拒绝
      // 就成了 unhandledRejection，而 Node 默认直接杀进程：一次盘写失败会打死整个评测平台，
      // 而不只是这一个作业。
      // 逃逸点是两处状态回写 —— 占位的 lastStatus="running"、以及失败分支里的回写 ——
      // 它们都在上面 catch 的覆盖之外，updateJobs 落盘失败（盘满 / EACCES）时从这里冒出来。
      // 此时作业在盘上可能停留 "running"，由启动时的 reconcileInterruptedJobs 归位，不会永久卡住。
      try {
        await logError?.(error, job);
      } catch {
        // 记录失败同样不应影响调度
      }
    } finally {
      runningJobIds.delete(job.id);
    }
  }

  async function tick() {
    lastTickAt = now(); // 活性心跳：在任何 await 前刷新，长 tick 也算「还活着」
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
    // 汇总发信时机判断。放在 await 之后：本 tick 触发的作业到这里已经跑完，
    // 故 runningJobIds 里剩下的是【上一个 tick 起的、仍未结束的】作业 —— 正是要等的那些。
    // （setInterval 不等上一个 tick 结束，长批次期间会有多个 tick 并行走到这里，
    //   它们都会看到 activeJobs > 0 而顺延，直到那一批真正跑完。）
    // best-effort：汇总失败绝不影响调度。
    try {
      await onTickEnd?.({ activeJobs: runningJobIds.size });
    } catch {
      /* 汇总发信异常不影响调度 */
    }
  }

  // 启动对账：进程崩溃/OOM/重启会让中途运行的作业在盘上永久停留 lastStatus="running"（内存 runningJobIds
  // 已随进程清空）。启动时把这些「僵尸运行中」归位为 interrupted 并计一次失败——既清掉误导性的 UI 状态，
  // 也让 OOM 崩溃循环能被熔断收敛。best-effort，不阻断随后的首个 tick。
  async function reconcileInterruptedJobs() {
    await updateJobs((jobs) => {
      for (const job of jobs) {
        if (job.lastStatus === "running") {
          job.lastStatus = "interrupted";
          job.lastError = "上次运行被进程中断（崩溃/重启/OOM），已按失败计。";
          job.consecutiveFailures = (Number(job.consecutiveFailures) || 0) + 1;
          maybeDisableForFailures(job);
        }
      }
      return null;
    });
  }

  async function reconcileThenTick() {
    try {
      await reconcileInterruptedJobs();
    } catch {
      /* 对账失败不应阻断首个 tick 的追补 */
    }
    await tick();
  }

  async function runJobNow(id) {
    const jobs = await loadJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) return { ok: false, message: "作业不存在。" };
    if (runningJobIds.has(id)) return { ok: false, message: "该作业正在运行，请稍候。" };
    // “立即运行”同样不能绕开坏 cron 的安全门禁；否则接口会先回 200，后台却悄悄停用，
    // 既误导操作者也让状态解释困难。
    if (job.cron && !computeNextRunAt(job, now())) {
      await patchJob(job.id, {
        enabled: false,
        nextRunAt: null,
        lastStatus: "invalid_schedule",
        lastError: "定时表达式在未来四年内没有可执行时刻，已自动停用；请修正后重新启用。",
      });
      return { ok: false, message: "定时表达式没有可执行时刻，作业已停用；请修正后重新启用。" };
    }
    void fireJob(job); // 后台触发，不阻塞 HTTP 响应（测试可能跑数分钟）
    return { ok: true };
  }

  // 活性快照：供 /api/health 暴露、容器健康检查 + 外部看门狗（autoheal）据 stale 判定是否重启。
  function getStatus() {
    const running = Boolean(timer);
    const sinceLastTickMs = lastTickAt == null ? null : Math.max(0, now() - lastTickAt);
    // 仅在「已启动且确有一次心跳且超阈值」时判僵死：未启动 / 优雅停机不算，避免关停期误触发重启。
    const stale = running && lastTickAt != null && sinceLastTickMs > staleAfterMs;
    return {
      running,
      lastTickAt: lastTickAt == null ? null : new Date(lastTickAt).toISOString(),
      sinceLastTickMs,
      tickMs,
      staleAfterMs,
      stale,
      activeJobs: runningJobIds.size,
      // 生效额度（P1-04）：/api/health 要能看出并发闸与熔断阈值最终取了几，
      // 否则误配只能靠"熔断从来不触发"这类事后症状发现。
      maxConcurrent,
      autoSlots: autoLimiter.getStatus(),
      maxConsecutiveFailures,
    };
  }

  function start() {
    if (timer) return;
    lastTickAt = now(); // 先置起点，start_period 内不会被误判僵死
    void reconcileThenTick(); // 启动即对账僵尸「running」+ 跑一次做停机追补
    timer = setInterval(() => void tick(), tickMs);
    timer.unref?.(); // 不因调度器让本应退出的进程保持存活（listen 的 socket 才是存活来源）
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick, fireJob, runJobNow, runningJobIds, getStatus, reconcileInterruptedJobs };
}
