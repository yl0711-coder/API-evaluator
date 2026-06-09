import { sleep, toast } from "./client-utils.js";

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

export async function runRemoteTask(state, slot, type, payload, progressElement) {
  const task = await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
  state.activeTasks[slot] = task.id;
  renderTaskProgress(progressElement, task);

  while (true) {
    await sleep(900);
    const current = await api(`/api/tasks/${encodeURIComponent(task.id)}`);
    renderTaskProgress(progressElement, current);
    if (current.status === "completed") {
      delete state.activeTasks[slot];
      return current.result;
    }
    if (current.status === "cancelled") {
      delete state.activeTasks[slot];
      throw new Error("任务已取消。");
    }
    if (current.status === "failed") {
      delete state.activeTasks[slot];
      throw new ApiClientError(current.error || "任务失败，请重试。", {
        errorId: current.errorId || "",
        technicalMessage: current.error || "",
      });
    }
  }
}

export async function cancelRemoteTask(state, slot) {
  const taskId = state.activeTasks[slot];
  if (!taskId) {
    toast("当前没有运行中的任务。", true);
    return;
  }
  await api(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
  toast("已请求取消任务。");
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
