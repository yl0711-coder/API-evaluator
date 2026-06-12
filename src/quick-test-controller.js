import { api } from "./api-client.js";
import { buildErrorAdviceText } from "./operator-guidance.js";
import { formatResult } from "./formatters.js";

export function createQuickTestController({
  form,
  resultElement,
  quickFailurePanel,
  afterRequest,
}) {
  let running = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (running) return; // 防双击重复发真实请求
    running = true;
    const payload = Object.fromEntries(new FormData(form).entries());
    resultElement.textContent = "测试中，请稍候...";
    quickFailurePanel.clear();

    try {
      const result = await api("/api/tests/quick", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      resultElement.textContent = result.success ? formatResult(result) : `${formatResult(result)}\n\n${buildErrorAdviceText(result)}`;
      if (result.success) {
        quickFailurePanel.renderSuccess(payload.profileId);
      } else {
        quickFailurePanel.render(result, payload.profileId);
      }
      await afterRequest();
    } catch (error) {
      resultElement.textContent = `测试失败：${error.message}\n\n${buildErrorAdviceText(error)}`;
      quickFailurePanel.render(error, payload.profileId);
    } finally {
      running = false;
    }
  });
}
