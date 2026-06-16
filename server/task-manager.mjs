// server/task-manager.mjs
// 重测试任务生命周期 + 全局并发队列：创建/排队/取消/进度上报，超出并发上限的任务排队并给 ETA。
// 不关心具体测试怎么跑（runner 由调用方注入），便于独立测试任务状态机。
import crypto from "node:crypto";
import { appendJsonLine, clampNumber, summarizeText } from "./utils.mjs";
import { openReportInBrowser } from "./report-files.mjs";

// Owns remote task lifecycle only. It does not know how a stability or scenario
// test works; callers inject runners so task state can be tested independently.
export function createTaskManager({
  taskEventsFile,
  errorLogFile,
  runStabilityTest,
  runBatchAdmissionTest,
  runBatchStabilityTest,
  runScenarioTest,
  normalizeProfileIds,
  normalizeScenarioIds,
  logTechnicalError,
  buildUserErrorMessage,
}) {
  const tasks = new Map();
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
  function maxSlots() {
    return Math.max(1, Number(process.env.EVALUATOR_MAX_CONCURRENT_TASKS || 4));
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

  async function createTask(type, payload) {
    const queued = !slotAvailable();
    const tasksAhead = runningSlots + slotWaiters.length; // 在跑 + 已排在前面
    const etaSeconds = queued ? Math.max(10, Math.ceil((tasksAhead + 1) / maxSlots()) * avgTaskSeconds()) : 0;
    const queuePosition = queued ? slotWaiters.length + 1 : 0;
    const task = {
      id: crypto.randomUUID(),
      type: normalizeTaskType(type),
      status: queued ? "queued" : "running",
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
    await appendTaskEvent(taskEventsFile, task, queued ? "queued" : "started", {
      payload: summarizeTaskPayload(task.type, payload, { normalizeProfileIds, normalizeScenarioIds }),
    });
    // Run in the background so HTTP handlers can return 202 immediately.
    // 经全局并发槽位调度：超出上限的任务会排队，等空闲槽位再执行。
    void runWithSlot(task, payload);
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
        const resultSummary = summarizeTaskResult(publicResult);
        // 任务级单点：一个任务只打开它的主报告（批量任务=只开总报告，不会一渠道一个标签页）。
        openReportInBrowser(resultSummary.reportHtmlPath);
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
      task.endedAt = new Date().toISOString();
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

  async function cancelTask(task) {
    task.cancelRequested = true;
    task.message = "已请求取消，正在停止当前请求。";
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
  };
}

export function normalizeTaskType(type) {
  if (type === "stability" || type === "batch-admission" || type === "batch-stability" || type === "scenario") {
    return type;
  }
  throw new Error("不支持的任务类型。");
}

export function estimateTaskUnits(type, payload, { normalizeProfileIds, normalizeScenarioIds }) {
  if (type === "stability") {
    return clampNumber(payload.rounds, 1, 100, 10);
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
  return 1;
}

export function publicTask(task) {
  return {
    id: task.id,
    type: task.type,
    status: task.status,
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
    result: task.result,
    error: task.error,
    errorId: task.errorId || "",
  };
}

function summarizePublicTaskResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const { reportMarkdown, results, records, ...safeResult } = result;
  return {
    ...safeResult,
    reportMarkdown: reportMarkdown ? "报告内容已写入本地报告文件，请在报告中心查看。" : "",
    resultCount: Array.isArray(results) ? results.length : undefined,
    recordCount: Array.isArray(records) ? records.length : undefined,
  };
}

export async function appendTaskEvent(taskEventsFile, task, event, extra = {}) {
  await appendJsonLine(taskEventsFile, {
    taskId: task.id,
    type: task.type,
    event,
    status: task.status,
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
    ...extra,
  });
}

export function summarizeTaskPayload(type, payload, { normalizeProfileIds, normalizeScenarioIds }) {
  if (type === "stability") {
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
  return {};
}

export function summarizeTaskResult(result) {
  if (!result || typeof result !== "object") {
    return {};
  }
  if (result.type === "scenario" || result.runId?.startsWith?.("scenario-")) {
    return {
      runId: result.runId,
      profileCount: result.profileCount,
      scenarioCount: result.scenarioCount,
      reportPath: result.reportPath,
      reportHtmlPath: result.reportHtmlPath,
    };
  }
  if (result.batchId) {
    return {
      batchId: result.batchId,
      profileCount: result.profileCount,
      rounds: result.rounds,
      reportPath: result.reportPath,
      reportHtmlPath: result.reportHtmlPath,
    };
  }
  return {
    runId: result.runId,
    profileName: result.profileName,
    successRateText: result.successRateText,
    p95TotalMs: result.p95TotalMs,
    reportPath: result.reportPath,
    reportHtmlPath: result.reportHtmlPath,
  };
}

export function updateTaskProgress(taskContext, completedUnits, totalUnits, message) {
  const task = taskContext?.task;
  if (!task || task.status !== "running") {
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
