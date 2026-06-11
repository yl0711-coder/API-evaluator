import { escapeHtml } from "./client-utils.js";
import { resolveRunnableTargets } from "./runnable-targets.js";

// Pure workflow helpers for the dashboard. They decide what the operator should
// do next, while app.js only renders the returned step and wires navigation.
export function buildWorkflowStatus(state) {
  const channels = state.channels || [];
  // 可运行目标统一走 resolveRunnableTargets（单一事实源）。source==="legacy" 的孤儿老 profile
  // 本身是"渠道+模型"二合一，算作两步都已就绪。
  const runnable = resolveRunnableTargets(state);
  const hasChannels = channels.length > 0 || runnable.some((target) => target.source === "legacy");
  const hasModels = runnable.length > 0;
  const hasAdmission = state.testRuns.some((run) => run.type === "admission");
  const hasStandardLikeReport = state.testRuns.some((run) => run.type !== "admission");
  const hasReports = state.testRuns.length > 0;

  return {
    channels: hasChannels,
    models: hasModels,
    admission: hasAdmission,
    standard: hasStandardLikeReport,
    reports: hasReports,
    handoff: false,
  };
}

export function getNextWorkflowStep(status) {
  if (!status.channels) {
    return {
      step: "channels",
      page: "channels",
      title: "先配一个渠道",
      detail: "渠道 = Base URL + Key + 协议（只超管能配）。配好渠道，才能在“模型管理”里选它来建测试模型。",
      button: "去配渠道",
    };
  }
  if (!status.models) {
    return {
      step: "models",
      page: "models",
      title: "再配一个测试模型",
      detail: "在“模型管理”里选一个渠道 + 填一个模型名，就得到一个可以评测的目标。",
      button: "去配模型",
    };
  }
  if (!status.standard) {
    if (!status.admission) {
      return {
        step: "admission",
        page: "admission-test",
        title: "先跑一次模型准入评测",
        detail: "准入评测会检查协议结构、标称一致性、工具调用和基础行为，先确认渠道值得继续烧额度。",
        button: "去准入评测",
      };
    }
    return {
      step: "standard",
      page: "standard-eval",
      title: "运行一次标准评测",
      detail: "标准评测会自动完成连通、低轮稳定性和少量场景初筛，普通操作员不需要先进入高级测试。",
      button: "去标准评测",
    };
  }
  return {
    step: "handoff",
    page: "handoff",
    title: "复制测试交付模板",
    detail: "把测试对象、关键指标、异常、报告文件和下一步建议一次性发给负责人。",
    button: "生成交付内容",
  };
}

export function renderNextActionHtml(next) {
  return `
    <strong>当前建议：${escapeHtml(next.title)}</strong>
    <span>${escapeHtml(next.detail)}</span>
    <button class="primary" type="button" data-go-page="${next.page}">${escapeHtml(next.button)}</button>
  `;
}
