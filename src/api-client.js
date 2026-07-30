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

export async function runRemoteTask(state, slot, type, payload, progressElement, { onCreated } = {}) {
  const task = await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
  state.activeTasks[slot] = task.id;
  renderTaskProgress(progressElement, task);
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
            `与后端失去联系（连续 ${pollErrors} 次查询失败：${error.message}）。任务可能仍在后端运行并继续计费，请到「任务管理」确认后再决定是否重跑。`,
          );
        }
        continue; // 瞬时抖动：继续轮询
      }
      renderTaskProgress(progressElement, current);
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
