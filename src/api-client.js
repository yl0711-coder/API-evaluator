import { sleep, toast } from "./client-utils.js";
import { maybeAutoOpenReport } from "./report-overlay.js";

export class ApiClientError extends Error {
  constructor(message, { errorId = "", technicalMessage = "" } = {}) {
    super(message);
    this.name = "ApiClientError";
    this.errorId = errorId;
    this.technicalMessage = technicalMessage;
  }
}

export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
  } catch (error) {
    await reportClientError({
      kind: "network",
      message: error instanceof Error ? error.message : String(error),
      page: location.hash || location.pathname,
    });
    throw new ApiClientError("工具暂时连接不上本地服务。请关闭本工具后重新打开一次。", {
      technicalMessage: error instanceof Error ? error.message : String(error),
    });
  }

  const data = await readJsonResponse(response);
  if (!response.ok) {
    if (response.status === 401) {
      // 会话失效：通知登录闸门重新拉起登录界面
      window.dispatchEvent(new CustomEvent("evaluator:unauthorized"));
    }
    throw new ApiClientError(data.userMessage || data.message || "操作失败，请重试。", {
      errorId: data.errorId || "",
      technicalMessage: data.message || data.error || response.statusText,
    });
  }
  return data;
}

// onProgress：每次轮询拿到任务快照就回调一次，供调用方重绘自己的进度视图
// （如标准评测的「模型 × 步骤」网格按 task.steps 重画）。它只是观察者，抛错不影响轮询。
export async function runRemoteTask(state, slot, type, payload, progressElement, { onCreated, onProgress } = {}) {
  const task = await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
  state.activeTasks[slot] = task.id;
  renderTaskProgress(progressElement, task);
  notifyProgress(onProgress, task);
  onCreated?.(task);

  const MAX_POLL_MS = 45 * 60 * 1000; // 兜底：后端任务僵死(仍 running)时，前端不至于无限轮询
  // 单次轮询失败（网络抖动/代理 502/后端重启瞬间）绝不能直接中止等待：任务在后端仍在跑、仍在计费，
  // 前端却报「失败」会诱使用户重跑 → 双倍扣费。故容忍连续 N 次失败再放弃。
  const MAX_CONSECUTIVE_POLL_ERRORS = 5; // ≈4.5 秒抖动窗口
  const startedAt = Date.now();
  let pollErrors = 0;
  try {
    while (true) {
      await sleep(900);
      let current;
      try {
        current = await api(`/api/tasks/${encodeURIComponent(task.id)}`);
        pollErrors = 0; // 一次成功即复位
      } catch (error) {
        pollErrors += 1;
        if (pollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          throw new Error(
            `与后端失去联系（连续 ${pollErrors} 次查询失败：${error.message}）。任务可能仍在后端运行并继续计费，请到「任务中心」确认后再决定是否重跑。`,
          );
        }
        continue; // 瞬时抖动：继续轮询
      }
      renderTaskProgress(progressElement, current);
      notifyProgress(onProgress, current);
      if (current.status === "completed") {
        // 任务完成自动弹报告（Web/Docker 无桌面也能看；受客户端开关控制）。
        maybeAutoOpenReport(current.result);
        return current.result;
      }
      if (current.status === "cancelled") {
        throw new Error("任务已取消。");
      }
      if (current.status === "failed") {
        throw new ApiClientError(current.error || "任务失败，请重试。", {
          errorId: current.errorId || "",
          technicalMessage: current.error || "",
        });
      }
      if (Date.now() - startedAt > MAX_POLL_MS) {
        throw new Error("任务超过 45 分钟仍未结束，已停止等待。请检查后端任务状态或稍后重试。");
      }
    }
  } finally {
    // 无论正常返回还是抛错退出，都清掉 slot——否则残留的僵尸 id 会让「取消」对着不存在的任务发 404。
    delete state.activeTasks[slot];
  }
}

// 只读观察一个【已存在】的任务，直到它落定或调用方叫停。
// 与 runRemoteTask 的区别：不 POST /api/tasks（不会新建任务、不产生费用），也不写 state.activeTasks
// （那是「本页发起的任务」专用的槽位，任务中心只是旁观者，写进去会让「取消」误指到别人的任务）。
// 任务中心要靠它给运行中的任务持续刷新进度：不轮询的话，用户得自己一直点刷新。
// shouldStop() 返回 true 即停止轮询（用户切走页面、或点开了另一个任务）。
export async function observeRemoteTask(taskId, { onProgress, shouldStop, intervalMs = 1500 } = {}) {
  const MAX_OBSERVE_MS = 45 * 60 * 1000;
  const MAX_CONSECUTIVE_POLL_ERRORS = 5;
  const startedAt = Date.now();
  let pollErrors = 0;
  while (true) {
    if (shouldStop?.()) return null;
    await sleep(intervalMs);
    if (shouldStop?.()) return null;
    let current;
    try {
      current = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
      pollErrors = 0;
    } catch {
      pollErrors += 1;
      // 观察失败是只读操作失败，不涉及计费，也没有「双花」风险，故不抛给用户：
      // 静默停止轮询即可，页面上仍留着最后一次拿到的快照，用户可手动刷新。
      if (pollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) return null;
      continue;
    }
    try {
      onProgress?.(current);
    } catch {
      // 观察者渲染出错不该中断轮询，与 notifyProgress 同理。
    }
    // interrupted 是前端/数据层对「事件流停在 running」的改判，它同样是终态，必须停下来；
    // 漏掉它会让轮询一直打在一个永不推进的任务上。
    if (["completed", "failed", "cancelled", "interrupted"].includes(current.status)) return current;
    if (Date.now() - startedAt > MAX_OBSERVE_MS) return current;
  }
}

// 按 id 取消任务（任务中心用）。cancelRemoteTask 是按 slot 取消的，只认本页发起的任务，
// 任务中心面对的是别处发起、甚至上次运行留下的任务，只有 id 可用。
export async function cancelTaskById(taskId) {
  await api(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
}

export async function cancelRemoteTask(state, slot) {
  const taskId = state.activeTasks[slot];
  if (!taskId) {
    toast("当前没有运行中的任务。", true);
    return;
  }
  // 必须自己接住失败：调用方是 onclick 的 async 箭头函数、没有 .catch()，
  // 一旦这里拒绝，toast 不执行 → 用户点了「取消」却毫无反应（只留一条静默上报的 unhandledrejection）。
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
    toast("已请求取消任务。");
  } catch (error) {
    toast(`取消失败：${error.message}`, true);
  }
}

// 进度回调是纯观察者：调用方的渲染逻辑出错绝不能中断轮询——一旦中断，后端任务
// 仍在跑仍在计费，而前端会报失败诱导用户重跑（双花）。故在此吞掉异常。
function notifyProgress(onProgress, task) {
  if (!onProgress) return;
  try {
    onProgress(task);
  } catch {
    // 渲染失败不影响任务本身的等待与结果获取。
  }
}

function renderTaskProgress(element, task) {
  if (!element) return;
  element.classList.remove("hidden");
  const bar = element.querySelector(".progress-bar span");
  const text = element.querySelector("p");
  if (bar) {
    bar.style.width = `${Math.max(0, Math.min(100, task.progress || 0))}%`;
  }
  if (text) {
    text.textContent = `${task.message || "任务运行中"} (${task.progress || 0}%)`;
  }
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function reportClientError(payload) {
  try {
    await fetch("/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // If the local service itself is unavailable, there is nowhere safe to log.
  }
}
