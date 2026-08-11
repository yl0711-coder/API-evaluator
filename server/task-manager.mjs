// server/task-manager.mjs
// 重测试任务生命周期 + 全局并发队列：创建/排队/取消/进度上报，超出并发上限的任务排队并给 ETA。
// 不关心具体测试怎么跑（runner 由调用方注入），便于独立测试任务状态机。
import crypto from "node:crypto";
import { appendJsonLine, clampNumber, summarizeText } from "./utils.mjs";
import { envInt } from "./env-config.mjs";
import { openReportInBrowser, reportIdFromHtmlPath } from "./report-files.mjs";
import { countSuiteUnits } from "./admission-suite-plan.mjs";
import { recordEvaluationTask } from "./db.mjs";

// Owns remote task lifecycle only. It does not know how a stability or scenario
// test works; callers inject runners so task state can be tested independently.
export function createTaskManager({
  taskEventsFile,
  errorLogFile,
  runStabilityTest,
  runBatchAdmissionTest,
  runBatchStabilityTest,
  runScenarioTest,
  runLoadTest, // 压力测试 runner（server/load-test.mjs）
  runAdmissionTest, // 单 API 准入 runner（server/test-runner.mjs）
  runAdmissionSuite, // 一键准入复合任务编排器（server/admission-suite.mjs）
  normalizeProfileIds,
  normalizeScenarioIds,
  logTechnicalError,
  buildUserErrorMessage,
  onRunComplete, // (result) => void：任务完成回调（用于高危报告提示等），best-effort
}) {
  const tasks = new Map();
  // 任务去重键 `${type}::${key}` → taskId，防重复发起造成的双花（这些任务每一次都真实调用
  // 付费 API）。必须由调用方在 payload.idempotencyKey 显式带上非空字符串才生效——绝不能按
  // profileIds/scenarioIds 的形状去猜「是不是补齐场景」：普通的「复杂场景测试」表单完全可以只选
  // 1 个模型 + 1 个场景（并不罕见），而 tasks 这个 Map 是整个进程共享的内存态、不区分发起者/会话，
  // 按形状推断会把两个语义完全不同的请求（比如同一对模型+场景，但 repeats 不同）错误合并成一个，
  // 调用方会拿到别人那次任务的结果而不是自己发起的。显式 opt-in 才能保证只去重真正想去重的调用。
  // 键按 type 分桶，不同类型的任务即便键字面相同也互不干扰。
  //
  // 【覆盖范围】刻意只保「同一次提交因创建请求失败而被重试」这一种，其余场景一律不管：
  //   ✓ POST /api/tasks 已到达后端、任务已建好并开始计费，但响应在回程丢了（网络抖动 / 代理 502 /
  //     后端重启瞬间）→ 前端报错、用户再点一次 → 带同一个 key 重试，拿回原任务，不会再跑一遍。
  //   ✗ 刷新页面后重新提交：前端的 nonce 随页面状态一起没了，会建新任务（= 双花）。
  //   ✗ 多标签页各自提交：两边 nonce 互相独立，会建新任务。
  //   ✗ 任务跑完后再点一次：键在任务结束时即释放（见 createTask 末尾），视为用户主动重跑，理应放行。
  //   ✗ 多后端副本 / 多进程：这是进程内内存态，不是跨副本的强一致锁。
  // 后四种要真正堵住，得把幂等键落库并加 UNIQUE(owner_user_id, idempotency_key)（见
  // 03-v0.7.3-准入测试修复实施方案.md），属于另一档改动，当前刻意不做。
  const activeIdempotencyKeys = new Map();
  function taskDedupKey(type, payload) {
    const key = String(payload?.idempotencyKey ?? "").trim();
    return key ? `${normalizeTaskType(type)}::${key}` : null;
  }
  // 全局重测试并发上限，超出排队。避免多任务并发拖垮宿主或同机其它服务的资源。
  let runningSlots = 0;
  const slotWaiters = [];
  // 最近完成任务的耗时（滚动，估算排队 ETA 用）。
  const recentDurationsMs = [];
  function avgTaskSeconds() {
    if (recentDurationsMs.length === 0) return 90; // 无历史时的保守默认
    const sorted = [...recentDurationsMs].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    return Math.max(10, Math.round(mid / 1000));
  }
  function fmtEta(seconds) {
    return seconds < 90 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`;
  }
  // 每次调用都读 env：运维改完不必重启（历史行为，保留）。上限 64 是防手滑把并发配成 10000
  // 直接打爆宿主与上游——真需要更高，改这个常量比误配一次安全。
  // 解析走 envInt：`Math.max(1, Number("abc"))` 会得到 NaN，`runningSlots < NaN` 恒 false，
  // 任务将永久排队且提示语显示「最多同时跑 NaN 个」；`Infinity` 则绕开上限（P1-04）。
  function maxSlots() {
    return envInt("EVALUATOR_MAX_CONCURRENT_TASKS", 4, { min: 1, max: 64 });
  }
  function slotAvailable() {
    return runningSlots < maxSlots();
  }
  function acquireSlot() {
    if (slotAvailable()) {
      runningSlots += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => slotWaiters.push(resolve));
  }
  function releaseSlot() {
    const next = slotWaiters.shift();
    if (next) {
      next(); // 槽位直接转交等待者，runningSlots 计数守恒
      return;
    }
    runningSlots = Math.max(0, runningSlots - 1);
  }
  async function runWithSlot(task, payload) {
    await acquireSlot();
    // 取到槽位后的整段都纳入一个 try/finally：无论走取消早返回、started 转换还是 runTask，
    // releaseSlot 都恰好执行一次，绝不因中途异常（如 appendTaskEvent 落盘失败）泄漏槽位、卡死队列。
    try {
      // 排队的任务拿到槽位后才真正"开始"；中途已取消的，拿到槽位直接放掉、不执行。
      if (task.cancelRequested) {
        task.status = "cancelled";
        task.message = "任务已取消。";
        task.endedAt = new Date().toISOString();
        await appendTaskEvent(taskEventsFile, task, "cancelled");
        return;
      }
      if (task.status === "queued") {
        task.status = "running";
        task.startedAt = new Date().toISOString();
        task.message = "任务已开始。";
        await appendTaskEvent(taskEventsFile, task, "started");
      }
      await runTask(task, payload);
    } catch (error) {
      // 调度层兜底：runTask 自身已处理业务异常，这里只会兜到基础设施异常（如落盘失败）。
      // 既不能逃逸成 unhandled rejection（本函数由 void 调用），也不能吞掉——标记失败并尽力记录。
      if (task.status !== "cancelled") {
        task.status = "failed";
        task.message = "任务调度失败，请查看本地错误日志。";
        task.endedAt = task.endedAt || new Date().toISOString();
        if (logTechnicalError) {
          await logTechnicalError(errorLogFile, {
            source: "task-scheduler",
            error,
            context: { taskId: task.id, taskType: task.type },
          }).catch(() => {});
        }
      }
    } finally {
      releaseSlot();
    }
  }

  // actor：发起人用户名（来自会话，由 server.mjs 传入）。刻意【不经 payload】——payload 要过
  // summarizeTaskPayload 的形状摘要，把身份混进去早晚被当成敏感字段一起摘掉，或反过来被摘漏。
  //
  // 这是「记录 + 展示，不拦截」：五人团队里 A 下班后他卡住的任务应当能被 B 掐掉（取消是止损
  // 操作，限权反而放大损失），所以取消【不校验身份】。记下来是为了能追溯"这轮谁跑的、谁停的"，
  // 不是为了做权限边界。真要强制隔离得先有 SQLite 落库（ADM-017），届时加 WHERE owner = ? 即可，
  // 数据这时已经在了——先加墙再拆墙要难得多。
  async function createTask(type, payload, { actor = null } = {}) {
    const dedupKey = taskDedupKey(type, payload);
    if (dedupKey) {
      const existingId = activeIdempotencyKeys.get(dedupKey);
      const existing = existingId ? tasks.get(existingId) : null;
      // 命中且仍在跑/排队 → 直接把已有任务原样交回，绝不再起一个真实调用（防双花）。
      // 命中但已结束（completed/failed/cancelled）→ 视为过期键，走下面正常建新任务。
      if (existing && (existing.status === "running" || existing.status === "queued")) {
        return existing;
      }
    }
    const queued = !slotAvailable();
    const tasksAhead = runningSlots + slotWaiters.length; // 在跑 + 已排在前面
    const etaSeconds = queued ? Math.max(10, Math.ceil((tasksAhead + 1) / maxSlots()) * avgTaskSeconds()) : 0;
    const queuePosition = queued ? slotWaiters.length + 1 : 0;
    const task = {
      id: crypto.randomUUID(),
      type: normalizeTaskType(type),
      status: queued ? "queued" : "running",
      // 发起人 / 取消人。null = 未记录（无会话的内部调用，或本次改动之前建的历史任务）。
      createdBy: actor || null,
      cancelledBy: null,
      createdAt: new Date().toISOString(),
      startedAt: queued ? null : new Date().toISOString(),
      endedAt: null,
      progress: 0,
      completedUnits: 0,
      totalUnits: estimateTaskUnits(type, payload, { normalizeProfileIds, normalizeScenarioIds }),
      queuePosition,
      etaSeconds,
      message: queued
        ? `排队中：前面有 ${tasksAhead} 个测试在跑/等待，预计约 ${fmtEta(etaSeconds)} 后开始（为保护线上资源，复杂任务全局最多同时跑 ${maxSlots()} 个）。`
        : "任务已开始。",
      cancelRequested: false,
      // 取消时 abort 在飞的 fetch，请求层据此立即停止，不必等当前请求超时/自然结束。
      abortController: new AbortController(),
      result: null,
      error: null,
      errorId: "",
    };
    tasks.set(task.id, task);
    if (dedupKey) activeIdempotencyKeys.set(dedupKey, task.id);
    await appendTaskEvent(taskEventsFile, task, queued ? "queued" : "started", {
      payload: summarizeTaskPayload(task.type, payload, { normalizeProfileIds, normalizeScenarioIds }),
    });
    // Run in the background so HTTP handlers can return 202 immediately.
    // 经全局并发槽位调度：超出上限的任务会排队，等空闲槽位再执行。
    void runWithSlot(task, payload).finally(() => {
      // 任务结束（无论成功/失败/取消）即释放去重键，让后续对同一目标的重跑可以重新发起。
      if (dedupKey && activeIdempotencyKeys.get(dedupKey) === task.id) activeIdempotencyKeys.delete(dedupKey);
    });
    return task;
  }

  async function runTask(task, payload) {
    const context = { task };
    try {
      let result;
      if (task.type === "stability") {
        result = await runStabilityTest(payload, context);
      } else if (task.type === "batch-admission") {
        result = await runBatchAdmissionTest(payload, context);
      } else if (task.type === "batch-stability") {
        result = await runBatchStabilityTest(payload, context);
      } else if (task.type === "scenario") {
        result = await runScenarioTest(payload, context);
      } else if (task.type === "load-test") {
        result = await runLoadTest(payload, context);
      } else if (task.type === "admission") {
        result = await runAdmissionTest(payload, context);
      } else if (task.type === "admission-suite") {
        result = await runAdmissionSuite(payload, context);
      } else {
        throw new Error("不支持的任务类型。");
      }

      if (task.cancelRequested) {
        task.status = "cancelled";
        task.message = "任务已取消。";
        await appendTaskEvent(taskEventsFile, task, "cancelled");
      } else {
        const publicResult = summarizePublicTaskResult(result);
        task.status = "completed";
        task.progress = 100;
        task.completedUnits = task.totalUnits || task.completedUnits;
        task.message = "任务已完成。";
        task.result = publicResult;
        // 运行完成回调（高危报告提示按开关判危记录）：用 runner 原始 result（含 grade/recommendation）。best-effort。
        try {
          await onRunComplete?.(result);
        } catch {
          /* 回调失败不影响任务完成 */
        }
        const resultSummary = summarizeTaskResult(publicResult);
        // 多模型「每模型一篇」：逐篇在桌面浏览器打开（各开一标签）；否则打开单篇主报告。
        if (Array.isArray(resultSummary.reports) && resultSummary.reports.length) {
          for (const r of resultSummary.reports) {
            openReportInBrowser(r.reportHtmlPath);
            openReportInBrowser(r.aiAnalysisHtmlPath);
          }
        } else {
          openReportInBrowser(resultSummary.reportHtmlPath);
          // AI 辅助分析独立成文，存在时一并打开（同受 EVALUATOR_OPEN_REPORT 开关控制）。
          openReportInBrowser(resultSummary.aiAnalysisHtmlPath);
        }
        await appendTaskEvent(taskEventsFile, task, "completed", { result: resultSummary });
      }
    } catch (error) {
      if (task.cancelRequested || error?.name === "TaskCancelledError") {
        task.status = "cancelled";
        task.message = "任务已取消。";
        await appendTaskEvent(taskEventsFile, task, "cancelled");
      } else {
        task.errorId = logTechnicalError
          ? await logTechnicalError(errorLogFile, {
              source: "task",
              error,
              context: {
                taskId: task.id,
                taskType: task.type,
                progress: task.progress,
                completedUnits: task.completedUnits,
                totalUnits: task.totalUnits,
              },
            })
          : "";
        task.error = buildUserErrorMessage && task.errorId ? buildUserErrorMessage(task.errorId) : "任务执行失败，请查看本地错误日志。";
        task.status = "failed";
        task.message = task.error;
        await appendTaskEvent(taskEventsFile, task, "failed", { errorId: task.errorId });
      }
    } finally {
      // 正常路径下 endedAt 已由上面的终态 appendTaskEvent 补好（P1-03），这里只兜底
      // 「一个终态事件都没写成」的情况（如落盘异常逃逸到 runWithSlot 的 catch）。
      // 绝不能无条件重赋：那会让内存里的时间与已落库的那笔差出几毫秒到几百毫秒，
      // 同一个任务在「内存态」与「重启后读库」两条路径上显示不同的结束时间。
      if (!task.endedAt) task.endedAt = new Date().toISOString();
      // 记录任务耗时，喂给排队 ETA 估算（滚动保留最近 10 条）。
      if (task.startedAt) {
        const durMs = new Date(task.endedAt).getTime() - new Date(task.startedAt).getTime();
        if (durMs > 0) {
          recentDurationsMs.push(durMs);
          if (recentDurationsMs.length > 10) recentDurationsMs.shift();
        }
      }
      // Keep finished tasks queryable for a while, but do not keep the Node
      // process alive only because of this cleanup timer.
      const cleanupTimer = setTimeout(() => tasks.delete(task.id), 1000 * 60 * 60);
      cleanupTimer.unref?.();
    }
  }

  // actor：执行取消的人。刻意【不校验】他是否等于 createdBy——见 createTask 上方注释。
  async function cancelTask(task, { actor = null } = {}) {
    task.cancelRequested = true;
    task.cancelledBy = actor || null;
    task.message = actor ? `已请求取消（由 ${actor} 操作），正在停止当前请求。` : "已请求取消，正在停止当前请求。";
    try {
      task.abortController?.abort();
    } catch {
      // best-effort：abort 失败不影响取消标志，下个批次边界仍会停。
    }
    await appendTaskEvent(taskEventsFile, task, "cancel_requested");
  }

  return {
    tasks,
    createTask,
    cancelTask,
    getTask: (taskId) => tasks.get(taskId),
    publicTask,
    // 生效额度快照，给 /api/health 用（P1-04）：运维配了 EVALUATOR_MAX_CONCURRENT_TASKS 之后
    // 得有地方看到"到底几个槽在起作用"，否则误配只能靠任务永久排队这种事后症状发现。
    getLimits: () => ({ maxConcurrentTasks: maxSlots(), runningSlots }),
  };
}

export function normalizeTaskType(type) {
  if (
    type === "stability" ||
    type === "batch-admission" ||
    type === "batch-stability" ||
    type === "scenario" ||
    type === "load-test" ||
    type === "admission" ||
    type === "admission-suite"
  ) {
    return type;
  }
  throw new Error("不支持的任务类型。");
}

export function estimateTaskUnits(type, payload, { normalizeProfileIds, normalizeScenarioIds }) {
  if (type === "stability") {
    if (Array.isArray(payload.groups) && payload.groups.length > 0) {
      return payload.groups.reduce((sum, group) => sum + clampNumber(group.repeats, 1, 20, 1), 0);
    }
    return clampNumber(payload.rounds, 1, 100, 10);
  }
  if (type === "load-test") {
    // 压测按时长推进进度：点数 ×(ramp-up + 稳态秒数)，非请求数。扫描时 loads 有多个点。
    const points = Math.max(1, Math.min(8, Array.isArray(payload.loads) ? payload.loads.length : 1));
    const perPoint = clampNumber(payload.warmupSec, 0, 30, 5) + clampNumber(payload.durationSec, 5, 600, 60);
    return points * perPoint;
  }
  if (type === "batch-stability") {
    return normalizeProfileIds(payload.profileIds).length || 1;
  }
  if (type === "batch-admission") {
    return normalizeProfileIds(payload.profileIds).length || 1;
  }
  if (type === "scenario") {
    const profileCount = Math.max(1, normalizeProfileIds(payload.profileIds).length);
    const scenarioCount = Math.max(1, normalizeScenarioIds(payload.scenarioIds).length);
    return profileCount * scenarioCount * clampNumber(payload.repeats, 1, 5, 1);
  }
  if (type === "admission") {
    // 只是【下限估算】，用于第一次进度刻度出现之前的百分比：真实用例数由 runAdmissionTest 跑起来
    // 之后用 updateTaskProgress 上报（updateTaskProgress 的 Math.max 会把 totalUnits 修正上去）。
    // 之所以不在这里复刻一份精确公式：真实条数还取决于模型家族指纹探针（4~5 条）与档位探针
    // （仅 Claude + 本地有基线时才追加），这些在建任务时都还没解析出来。单一权威是 runner。
    if (payload.packageLevel === "quick") return 5;
    return payload.packageLevel === "deep" ? 12 : 11;
  }
  if (type === "admission-suite") {
    // 进度单元 = 步骤数：每个必选模型 3 步（快速/稳定性/准入）+ 每个档位探针 1 步。
    // 用步骤数而非请求数，是因为前端进度网格就是按步骤画的，两者对齐才不会出现
    // 「进度条 60% 但网格只亮了 1 格」这种自相矛盾的显示。
    return countSuiteUnits(payload);
  }
  return 1;
}

export function publicTask(task) {
  return {
    id: task.id,
    type: task.type,
    status: task.status,
    createdBy: task.createdBy ?? null,
    cancelledBy: task.cancelledBy ?? null,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    progress: task.progress,
    completedUnits: task.completedUnits,
    totalUnits: task.totalUnits,
    queuePosition: task.queuePosition || 0,
    etaSeconds: task.etaSeconds || 0,
    message: task.message,
    cancelRequested: task.cancelRequested,
    // 复合任务的逐步骤快照：前端每次轮询按它重绘「模型 × 步骤」进度网格。
    // 只给轻量摘要字段——这个对象每 900ms 被拉一次，绝不能带原始响应体。
    steps: Array.isArray(task.steps) ? task.steps.map(publicTaskStep) : undefined,
    result: task.result,
    error: task.error,
    errorId: task.errorId || "",
  };
}

// executionStatus（跑完没有）与 verdict（达没达标）是两个正交字段，一起给前端。
// 前端据此区分「执行失败」（红叉·平台问题）与「未通过」（红叉·渠道问题）——
// 这两者混为一谈正是 v0.7.3 假通过的表现形式之一。
function publicTaskStep(step) {
  return {
    groupKey: step.groupKey,
    groupLabel: step.groupLabel,
    stepName: step.stepName,
    stepLabel: step.stepLabel,
    isTierProbe: Boolean(step.isTierProbe),
    executionStatus: step.executionStatus,
    verdict: step.verdict ?? null,
    summary: step.summary ?? "",
  };
}

function summarizePublicTaskResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const { reportMarkdown, results, records, reports, ...safeResult } = result;
  // 多模型「每模型一篇」：把每篇报告映射成 { id, aiAnalysisId, label, model } 供前端逐篇弹出。
  const reportList = Array.isArray(reports)
    ? reports
        .filter((r) => r && r.reportHtmlPath)
        .map((r) => ({
          id: reportIdFromHtmlPath(r.reportHtmlPath),
          aiAnalysisId: reportIdFromHtmlPath(r.aiAnalysisHtmlPath),
          label: r.profileName || r.model || "报告",
          model: r.model,
          // 保留文件路径供任务完成时桌面端逐篇打开（前端浮层只用 id/aiAnalysisId）。
          reportHtmlPath: r.reportHtmlPath,
          aiAnalysisHtmlPath: r.aiAnalysisHtmlPath || null,
        }))
    : undefined;
  return {
    ...safeResult,
    // 报告 id：供前端拼 HTTP 查看 URL，在应用内浮层弹出报告（Docker/远程无桌面也能看）。
    reportId: reportIdFromHtmlPath(result.reportHtmlPath),
    aiAnalysisId: reportIdFromHtmlPath(result.aiAnalysisHtmlPath),
    reports: reportList, // 新契约：多篇报告清单（单模型时长度 1）
    reportMarkdown: reportMarkdown ? "报告内容已写入本地报告文件，请在报告中心查看。" : "",
    resultCount: Array.isArray(results) ? results.length : undefined,
    recordCount: Array.isArray(records) ? records.length : undefined,
  };
}

// 落定事件（completed/failed/cancelled）之后，任务对象会在 1 小时后被从内存 Map 里删掉，
// 重启则立刻消失。若此时不把逐步骤快照写进事件日志，「模型 × 步骤」明细就只在这 1 小时内可见——
// 任务中心点开一个昨天的任务会是一片空白。故终态事件额外落 steps（仍是 publicTaskStep 的
// 轻量摘要：无原始响应体、无 key）。
// 只在终态落一次：running 期间每次进度更新都写一遍会把事件日志撑爆，而中间态没有留存价值。
const TERMINAL_TASK_EVENTS = new Set(["completed", "failed", "cancelled"]);

export async function appendTaskEvent(taskEventsFile, task, event, extra = {}) {
  const terminal = TERMINAL_TASK_EVENTS.has(event);
  // 终态的 endedAt 在这里统一补齐（P1-03）。此前 runTask 的三个终态分支都是「先写事件、
  // 后在 finally 里赋 endedAt」，于是落库与事件流双双留下 ended_at = null，而 upsert 里
  // ended_at 走 COALESCE、之后再没有写入——这个 null 是永久的：任务被逐出内存或进程重启后，
  // 任务中心只能显示「结束：—」，任务时长/审计/运营统计全都算不出来。
  // 放在唯一的写入口补，而不是在每个分支各赋一次：将来新增终态分支不会再漏这一笔。
  if (terminal && !task.endedAt) task.endedAt = new Date().toISOString();
  const steps = terminal && Array.isArray(task.steps) ? task.steps.map(publicTaskStep) : undefined;
  // 同步落 SQLite（ADM-017）：JSONL 是逐事件流水、只读最后 300 行；这张表是逐任务当前态，
  // 能答"上周那次准入跑没跑"。两者刻意并存——JSONL 不依赖 SQLite 可用，是最后的兜底。
  // best-effort：recordEvaluationTask 自己吞掉所有异常，失败只是少一行落库，不影响事件写入。
  // payload 只在建任务的那次事件带（extra.payload），后续 upsert 靠 COALESCE 保住首份。
  // 必须 await：两次不等待的 upsert 可能乱序落地，把 completed 覆盖回 queued（status 字段是
  // 直接赋值而非 COALESCE，先写的赢不了、后写的才赢——顺序错了就是错的状态）。
  await recordEvaluationTask({
    ...task,
    payload: extra.payload ?? null,
    result: extra.result ?? task.result ?? null,
    steps: steps ?? task.steps,
    errorId: task.errorId || extra.errorId || "",
  });
  await appendJsonLine(taskEventsFile, {
    taskId: task.id,
    type: task.type,
    event,
    status: task.status,
    // 发起人 / 取消人。用户名不是敏感字段（不同于 key / baseUrl），落进事件流才能在重启后
    // 仍答得出"这轮谁跑的、谁停的"——任务对象本身落定 1 小时就被逐出内存。
    createdBy: task.createdBy ?? null,
    cancelledBy: task.cancelledBy ?? null,
    progress: task.progress,
    completedUnits: task.completedUnits,
    totalUnits: task.totalUnits,
    message: task.message,
    error: task.error,
    errorId: task.errorId || extra.errorId || "",
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    loggedAt: new Date().toISOString(),
    ...(steps ? { steps } : {}),
    ...extra,
  });
}

export function summarizeTaskPayload(type, payload, { normalizeProfileIds, normalizeScenarioIds }) {
  if (type === "stability") {
    if (Array.isArray(payload.groups) && payload.groups.length > 0) {
      return {
        profileId: payload.profileId || "",
        groups: payload.groups.map((group) => ({
          presetId: group.presetId ?? null,
          repeats: clampNumber(group.repeats, 1, 20, 1),
        })),
        concurrency: clampNumber(payload.concurrency, 1, 5, 1),
        promptPreview: "<多组>",
      };
    }
    return {
      profileId: payload.profileId || "",
      rounds: clampNumber(payload.rounds, 1, 100, 10),
      concurrency: clampNumber(payload.concurrency, 1, 5, 1),
      promptPreview: summarizeTaskPrompt(payload.prompt || ""),
    };
  }
  if (type === "batch-stability") {
    return {
      profileCount: normalizeProfileIds(payload.profileIds).length,
      rounds: clampNumber(payload.rounds, 1, 100, 10),
      maxParallelProfiles: clampNumber(payload.maxParallelProfiles, 1, 5, 2),
      concurrency: clampNumber(payload.concurrency, 1, 5, 1),
      promptPreview: summarizeTaskPrompt(payload.prompt || ""),
    };
  }
  if (type === "batch-admission") {
    return {
      profileCount: normalizeProfileIds(payload.profileIds).length,
      packageLevel: payload.packageLevel || "standard",
      maxParallelProfiles: clampNumber(payload.maxParallelProfiles, 1, 3, 1),
    };
  }
  if (type === "scenario") {
    return {
      profileCount: normalizeProfileIds(payload.profileIds).length,
      scenarioCount: normalizeScenarioIds(payload.scenarioIds).length,
      repeats: clampNumber(payload.repeats, 1, 5, 1),
      maxParallelProfiles: clampNumber(payload.maxParallelProfiles, 1, 5, 2),
      requestConcurrency: clampNumber(payload.requestConcurrency || payload.concurrency, 1, 3, 1),
    };
  }
  if (type === "admission") {
    // 事件日志是运维记录，绝不落 key/base URL。只记形状：测的是哪档、要不要 AI 辅助分析。
    return {
      packageLevel: payload.packageLevel || "standard",
      useAiReportAnalysis: Boolean(payload.useAiReportAnalysis),
    };
  }
  if (type === "admission-suite") {
    // 事件日志是运维记录，绝不落 key/base URL。只记形状：测了几个模型、跑不跑档位探测。
    // profileIds/modelNames 例外，因为任务中心的「再测一次」要靠它们回填表单——只有计数的话，
    // 用户点「再测一次」我们连测的是哪个模型都不知道。它们是内部 id 与模型名，不是凭据：
    // 模型名早已遍布报告与结果摘要，profileId 任何登录用户都能从 /api/profiles 读到，
    // 且 stability 分支一直就在落 profileId（见上文），这里不是新开的先例。
    return {
      profileCount: normalizeProfileIds(payload.profileIds).length,
      profileIds: normalizeProfileIds(payload.profileIds),
      modelNames: Array.isArray(payload.modelNames) ? payload.modelNames.map((name) => String(name || "")) : [],
      isClaudeChannel: Boolean(String(payload.claudeChannelId || "").trim()),
      useAiReportAnalysis: Boolean(payload.useAiReportAnalysis),
      tierProbeCount: Array.isArray(payload.tierProbeModels) ? payload.tierProbeModels.length : 0,
      groupCount: Array.isArray(payload.groups) ? payload.groups.length : 0,
    };
  }
  return {};
}

export function summarizeTaskResult(result) {
  if (!result || typeof result !== "object") {
    return {};
  }
  if (result.type === "admission-suite") {
    // 事件日志只记结论与报告清单，不记逐步骤明细（明细在任务对象里，前端轮询可取）。
    return {
      type: result.type,
      policyVersion: result.policyVersion,
      conclusion: result.conclusion,
      modelCount: Array.isArray(result.models) ? result.models.length : 0,
      reports: result.reports, // 每模型一篇（供桌面逐篇打开）
    };
  }
  if (result.type === "admission") {
    // 事件日志只记结论级字段，不记逐用例明细（明细在报告文件里）。
    return {
      type: result.type,
      runId: result.runId,
      grade: result.grade,
      score: result.score,
      verdict: result.verdict?.verdict,
      successRateText: result.successRateText,
      reportPath: result.reportPath,
      reportHtmlPath: result.reportHtmlPath,
      aiAnalysisHtmlPath: result.aiAnalysisHtmlPath,
    };
  }
  if (result.type === "scenario" || result.runId?.startsWith?.("scenario-")) {
    return {
      runId: result.runId,
      profileCount: result.profileCount,
      scenarioCount: result.scenarioCount,
      reportPath: result.reportPath,
      reportHtmlPath: result.reportHtmlPath,
      aiAnalysisHtmlPath: result.aiAnalysisHtmlPath,
      reports: result.reports, // 每模型一篇（供桌面逐篇打开）
    };
  }
  if (result.batchId) {
    return {
      batchId: result.batchId,
      profileCount: result.profileCount,
      rounds: result.rounds,
      reportPath: result.reportPath,
      reportHtmlPath: result.reportHtmlPath,
      aiAnalysisHtmlPath: result.aiAnalysisHtmlPath,
      reports: result.reports, // 每模型一篇（供桌面逐篇打开）
    };
  }
  return {
    runId: result.runId,
    profileName: result.profileName,
    successRateText: result.successRateText,
    p95TotalMs: result.p95TotalMs,
    reportPath: result.reportPath,
    reportHtmlPath: result.reportHtmlPath,
    aiAnalysisHtmlPath: result.aiAnalysisHtmlPath,
  };
}

/**
 * 派生一个「只借用取消信号、不许写进度计数器」的子上下文，给复合任务里被嵌套调用的 runner 用。
 * 共享同一个 task 对象引用，所以 assertTaskNotCancelled 与 abortController.signal 照常生效。
 */
export function nestedTaskContext(taskContext) {
  return { ...(taskContext || {}), nestedProgress: true };
}

export function updateTaskProgress(taskContext, completedUnits, totalUnits, message) {
  const task = taskContext?.task;
  if (!task || task.status !== "running") {
    return;
  }
  // 嵌套 runner 按【自己的】单元空间上报：稳定性说"3/9 轮"，而外层 admission-suite 的总单元是
  // "6 个步骤"。若放它写计数器，下面的 Math.max 会把 totalUnits 从 6 抬到 9、completedUnits 也被
  // 它的轮次数顶上去，进度条与「模型 × 步骤」网格当场互相矛盾（实测：6 步的套件跑完显示 9/9、99%）。
  // 所以嵌套上下文只借用 message——"稳定性测试进行中：3/9 轮"对用户有用，让它照常显示；
  // 计数器由外层编排器独占。
  if (taskContext.nestedProgress) {
    task.message = message || task.message;
    return;
  }
  task.completedUnits = Math.max(task.completedUnits || 0, Number(completedUnits) || 0);
  task.totalUnits = Math.max(task.totalUnits || 1, Number(totalUnits) || 1);
  task.progress = Math.min(99, Math.round((task.completedUnits / task.totalUnits) * 100));
  task.message = message || task.message;
}

function summarizeTaskPrompt(prompt) {
  // Task events are operational logs. They may include prompt previews, but
  // summarizeText always redacts obvious secrets before writing them.
  return summarizeText(String(prompt));
}

export function assertTaskNotCancelled(taskContext) {
  if (!taskContext?.task?.cancelRequested) {
    return;
  }
  const error = new Error("任务已取消。");
  error.name = "TaskCancelledError";
  throw error;
}
