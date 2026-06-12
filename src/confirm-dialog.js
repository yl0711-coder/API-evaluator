import { escapeHtml } from "./client-utils.js";

export function createConfirmDialog({
  modal,
  titleElement,
  messageElement,
  confirmButton,
  cancelButton,
}) {
  let resolveCurrent = null;

  function close(result) {
    modal.classList.add("hidden");
    if (resolveCurrent) {
      resolveCurrent(result);
      resolveCurrent = null;
    }
  }

  confirmButton.addEventListener("click", () => close(true));
  cancelButton.addEventListener("click", () => close(false));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close(false);
  });
  document.addEventListener("keydown", (event) => {
    if (!modal.classList.contains("hidden") && event.key === "Escape") {
      close(false);
    }
  });

  return function confirmAction(options) {
    // 若上一个确认框还没决议就又弹新的：先把上一个按“取消”决议掉。
    // 否则上一个 Promise 永久挂起 → 调用方的 finally 不执行 → 按钮/并发 slot 永久锁死。
    if (resolveCurrent) {
      resolveCurrent(false);
      resolveCurrent = null;
    }
    titleElement.textContent = options.title || "请确认";
    messageElement.innerHTML = renderConfirmMessage(options);
    confirmButton.textContent = options.confirmLabel || "确认";
    cancelButton.textContent = options.cancelLabel || "取消";
    confirmButton.className = options.tone === "danger" ? "danger" : "primary";
    modal.classList.remove("hidden");
    confirmButton.focus();

    return new Promise((resolve) => {
      resolveCurrent = resolve;
    });
  };
}

function renderConfirmMessage(options) {
  const lines = [options.message || "", options.detail || ""].filter(Boolean);
  const list = Array.isArray(options.items) && options.items.length > 0
    ? `<ul>${options.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";
  return `${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}${list}`;
}
