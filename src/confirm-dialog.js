import { escapeHtml } from "./client-utils.js";

export function createConfirmDialog({
  modal,
  titleElement,
  messageElement,
  confirmButton,
  cancelButton,
  closeButton,
}) {
  let resolveCurrent = null;
  let isTristate = false;
  let delayTimer = null;
  let countdownTimer = null;
  let activeConfirmLabel = "";

  function clearTimers() {
    if (delayTimer) {
      clearTimeout(delayTimer);
      delayTimer = null;
    }
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // reason: "confirm" | "cancel" | "dismiss"。三态时原样返回，否则保持旧 boolean 语义（confirm→true）。
  function close(reason) {
    clearTimers();
    confirmButton.disabled = false;
    confirmButton.textContent = activeConfirmLabel;
    modal.classList.add("hidden");
    if (resolveCurrent) {
      resolveCurrent(isTristate ? reason : reason === "confirm");
      resolveCurrent = null;
    }
  }

  confirmButton.addEventListener("click", () => {
    if (confirmButton.disabled) return; // 冷静期内点不动
    close("confirm");
  });
  cancelButton.addEventListener("click", () => close("cancel"));
  // 右上角 ❌：等同 Esc/点背景，取消（dismiss）。
  closeButton?.addEventListener("click", () => close("dismiss"));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close("dismiss");
  });
  document.addEventListener("keydown", (event) => {
    if (!modal.classList.contains("hidden") && event.key === "Escape") {
      close("dismiss");
    }
  });

  // 确认钮冷静期：禁用 delayMs 毫秒，标签倒计时（如「是（2）」），到点恢复可点。
  function startConfirmDelay(delayMs, label) {
    confirmButton.disabled = true;
    let remaining = Math.ceil(delayMs / 1000);
    confirmButton.textContent = `${label}（${remaining}）`;
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) confirmButton.textContent = `${label}（${remaining}）`;
    }, 1000);
    delayTimer = setTimeout(() => {
      clearTimers();
      confirmButton.disabled = false;
      confirmButton.textContent = label;
    }, delayMs);
  }

  return function confirmAction(options) {
    // 若上一个确认框还没决议就又弹新的：先把上一个按“取消”决议掉。
    // 否则上一个 Promise 永久挂起 → 调用方的 finally 不执行 → 按钮/并发 slot 永久锁死。
    if (resolveCurrent) {
      resolveCurrent(isTristate ? "dismiss" : false);
      resolveCurrent = null;
    }
    clearTimers();
    isTristate = options.tristate === true;
    activeConfirmLabel = options.confirmLabel || "确认";
    titleElement.textContent = options.title || "请确认";
    messageElement.innerHTML = renderConfirmMessage(options);
    confirmButton.textContent = activeConfirmLabel;
    confirmButton.disabled = false;
    cancelButton.textContent = options.cancelLabel || "取消";
    confirmButton.className = options.tone === "danger" ? "danger" : "primary";
    modal.classList.remove("hidden");
    if (options.confirmDelayMs > 0) {
      startConfirmDelay(options.confirmDelayMs, activeConfirmLabel);
      cancelButton.focus(); // 冷静期内焦点给取消，避免回车误触
    } else {
      confirmButton.focus();
    }

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
