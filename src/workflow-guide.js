import { escapeHtml } from "./client-utils.js";

// Pure workflow helpers for the dashboard. They decide what the operator should
// do next, while app.js only renders the returned step and wires navigation.
export function buildWorkflowStatus(state) {
  const targets = state.profiles.filter((profile) => profile.role === "target");
  const hasAdmission = state.testRuns.some((run) => run.type === "admission");
  const hasStandardLikeReport = state.testRuns.some((run) => run.type !== "admission");
  const hasReports = state.testRuns.length > 0;

  return {
    profiles: targets.length > 0,
    admission: hasAdmission,
    standard: hasStandardLikeReport,
    reports: hasReports,
    handoff: false,
  };
}

export function getNextWorkflowStep(status) {
  if (!status.profiles) {
    return {
      step: "profiles",
      page: "profiles",
      title: "先新增一个被测 API 配置",
      detail: "没有 API 配置时，其他测试都无法产生有效结果。先填写平台地址、Key、模型名和协议。",
      button: "去配置 API",
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
