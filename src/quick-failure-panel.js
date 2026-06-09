import { escapeHtml } from "./client-utils.js";

export function createQuickFailurePanel({
  container,
  getDefaultProfileId,
  updateProfileKey,
  retryQuickTest,
  openProfiles,
  openStandardEval,
  openReports,
  openStabilitySmoke,
}) {
  function clear() {
    container.classList.add("hidden");
    container.innerHTML = "";
  }

  function render(errorLike, profileId) {
    const errorKey = inferErrorKey(errorLike);
    const actions = quickFailureActionsFor(errorKey);
    container.className = "next-step-panel fail-card";
    container.innerHTML = `
      <div>
        <span>下一步怎么做</span>
        <strong>${escapeHtml(actions.title)}</strong>
        <p>${escapeHtml(actions.detail)}</p>
      </div>
      <div class="action-row">
        ${actions.buttons
          .map(
            (action) =>
              `<button class="${action.primary ? "primary" : "secondary"}" type="button" data-quick-action="${action.action}">${escapeHtml(action.label)}</button>`,
          )
          .join("")}
      </div>
    `;
    container.querySelectorAll("[data-quick-action]").forEach((button) => {
      button.addEventListener("click", () => runAction(button.dataset.quickAction, profileId));
    });
  }

  function renderSuccess(profileId) {
    container.className = "next-step-panel pass-card";
    container.innerHTML = `
      <div>
        <span>下一步怎么做</span>
        <strong>连通已经通过，建议进入标准评测</strong>
        <p>快速测试只证明这条配置能请求成功。要判断是否值得交付，还需要跑标准评测。</p>
      </div>
      <div class="action-row">
        <button class="primary" type="button" data-quick-action="standard-eval">去标准评测</button>
        <button class="secondary" type="button" data-quick-action="retry-quick">重新跑快速测试</button>
      </div>
    `;
    container.querySelectorAll("[data-quick-action]").forEach((button) => {
      button.addEventListener("click", () => runAction(button.dataset.quickAction, profileId));
    });
  }

  async function runAction(action, profileId) {
    if (action === "update-key") {
      await updateProfileKey(profileId || getDefaultProfileId());
      return;
    }
    if (action === "standard-eval") {
      openStandardEval(profileId || getDefaultProfileId());
      return;
    }
    if (action === "retry-quick") {
      retryQuickTest();
      return;
    }
    if (action === "stability-smoke") {
      openStabilitySmoke(profileId);
      return;
    }
    if (action === "open-reports") {
      openReports();
      return;
    }
    openProfiles();
  }

  return { clear, render, renderSuccess };
}

function inferErrorKey(errorLike) {
  const text = String(errorLike?.normalizedError || errorLike?.message || errorLike || "").toLowerCase();
  if (text.includes("auth") || text.includes("401") || text.includes("key")) return "auth_failed";
  if (text.includes("model") || text.includes("404")) return "model_not_found";
  if (text.includes("rate") || text.includes("429")) return "rate_limited";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("content_block_not_found") || text.includes("content block")) return "content_block_not_found";
  if (text.includes("empty_response") || text.includes("empty")) return "empty_response";
  if (text.includes("invalid_response") || text.includes("json") || text.includes("parse")) return "invalid_response";
  if (text.includes("5xx") || text.includes("500") || text.includes("502") || text.includes("503")) return "upstream_5xx";
  if (text.includes("network") || text.includes("fetch") || text.includes("dns")) return "network_error";
  return "unknown_error";
}

function quickFailureActionsFor(errorKey) {
  const common = [{ label: "重新跑快速测试", action: "retry-quick", primary: false }];
  if (errorKey === "auth_failed") {
    return {
      title: "先补 Key 或确认 Key 权限",
      detail: "这种失败通常不是模型能力问题，继续跑稳定性测试只会浪费额度。",
      buttons: [{ label: "更新这个配置的 Key", action: "update-key", primary: true }, ...common],
    };
  }
  if (errorKey === "model_not_found") {
    return {
      title: "先检查模型名",
      detail: "请复制平台后台里的完整模型名，不要手打或凭记忆填写。",
      buttons: [{ label: "回配置页改模型名", action: "open-profiles", primary: true }, ...common],
    };
  }
  if (errorKey === "timeout") {
    return {
      title: "先调高等待时间再复测",
      detail: "复杂模型或中转站排队时会慢。建议把超时时间调到 120000 后重试。",
      buttons: [{ label: "回配置页调超时", action: "open-profiles", primary: true }, ...common],
    };
  }
  if (["content_block_not_found", "empty_response", "invalid_response"].includes(errorKey)) {
    return {
      title: "优先检查协议和地址",
      detail: "中转站多数应选 OpenAI Compatible。Base URL 只填基础地址，不要带完整请求路径。",
      buttons: [{ label: "回配置页检查协议", action: "open-profiles", primary: true }, ...common],
    };
  }
  if (errorKey === "rate_limited") {
    return {
      title: "先降并发，稍后再试",
      detail: "这通常是请求太频繁或额度受限。先等 1-5 分钟，再用低轮数复测。",
      buttons: [{ label: "去 3 轮稳定性", action: "stability-smoke", primary: true }, ...common],
    };
  }
  return {
    title: "先保留错误，再小步复测",
    detail: "如果连续失败，去报告中心导出问题包给负责人排查。",
    buttons: [{ label: "去报告中心", action: "open-reports", primary: true }, ...common],
  };
}
