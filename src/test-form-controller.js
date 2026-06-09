import { escapeHtml, toast } from "./client-utils.js";
import { runRemoteTask } from "./api-client.js";

export function createTaskFormController({
  form,
  submitButton,
  resultElement,
  progressElement,
  state,
  slot,
  taskType,
  confirmRun,
  preparePayload,
  predict,
  beforeStart,
  onSuccess,
  failurePrefix,
  idleButtonText,
}) {
  let running = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // 重入守卫：确认框 await 期间按钮尚未禁用，双击/回车会产生抢同一 slot 的并发任务，
    // 前一个会变成无法取消的孤儿任务继续消耗额度。进入即锁。
    if (running) return;
    const payload = preparePayload(Object.fromEntries(new FormData(form).entries()));
    if (!payload) {
      return;
    }
    // 跑前预测随 payload 一起送后端记录，供报告"预测 vs 实际"对比。
    if (typeof predict === "function") {
      try {
        payload.predicted = predict(payload);
      } catch {
        payload.predicted = null;
      }
    }
    running = true;
    submitButton.disabled = true;

    try {
      if (confirmRun) {
        const confirmed = await confirmRun(payload);
        if (!confirmed) return; // finally 会解锁
      }
      submitButton.textContent = "任务运行中...";
      beforeStart?.(payload);
      const result = await runRemoteTask(state, slot, taskType, payload, progressElement);
      await onSuccess(result, payload);
    } catch (error) {
      resultElement.innerHTML = `<p class="fail">${escapeHtml(failurePrefix)}：${escapeHtml(error.message)}</p>`;
    } finally {
      running = false;
      submitButton.disabled = false;
      submitButton.textContent = idleButtonText;
    }
  });
}

export function requireSelectedValues(select, emptyMessage) {
  const values = Array.from(select.selectedOptions).map((option) => option.value);
  if (values.length === 0) {
    toast(emptyMessage, true);
    return null;
  }
  return values;
}
