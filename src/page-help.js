import { escapeHtml } from "./client-utils.js";

const PAGE_HELP = {
  dashboard: {
    title: "总览页怎么用",
    steps: ["按“当前进度”一步步走：先配渠道、再配模型，然后准入、标准评测。", "还没配置时点“配置第一个渠道”（仅超管可配渠道）。", "想先熟悉工具，可以点“查看演示数据”。"],
  },
  channels: {
    title: "渠道管理怎么填（超管）",
    steps: ["渠道 = 连接信息：Base URL + Key + 协议。Key 加密保存、不回显、管理员看不到。", "不确定协议时先选“OpenAI Compatible”。Base URL 只填基础地址，不要带 /v1/chat/completions。", "站点是 new-api 搭的，可点“从 new-api 导入”一键同步渠道；之后去“模型管理”给渠道挂模型。"],
  },
  models: {
    title: "模型管理怎么用",
    steps: ["选一个渠道 + 填一个模型名 = 一个测试目标。看不到也不需要 Key。", "一个渠道可建多个模型目标。运行各类测试时从这些目标里选。", "渠道是 new-api 导入的，可在“渠道管理”里点该渠道的“同步模型”刷新它的模型。"],
  },
  "standard-eval": {
    title: "标准评测怎么用",
    steps: ["适合第一次筛选一个 API。", "工具会自动跑连通、短稳定性和少量场景。", "失败后按页面按钮回去修配置，不要继续烧额度。"],
  },
  "admission-test": {
    title: "准入评测怎么用",
    steps: ["新增渠道先跑准入评测，确认协议、模型结构、标称一致性、工具调用、流式结构和基础行为。", "准入等级 A/B 可以继续做稳定性和场景测试。", "C 以下先复核模型名、协议类型和上游渠道配置。"],
  },
  "quick-test": {
    title: "快速测试怎么用",
    steps: ["每次新增或修改配置后先跑这里。", "成功只代表能连通，不代表稳定，下一步去标准评测。", "失败时优先按下方按钮处理 Key、模型名、协议或地址。"],
  },
  "stability-test": {
    title: "稳定性测试怎么用",
    steps: ["刚开始先选 3 轮。", "日常对比用 10 轮。", "准备推荐给负责人前再用 30 轮。"],
  },
  "scenario-test": {
    title: "场景测试怎么用",
    steps: ["这是最耗额度的测试。", "先选低成本初筛包。", "内容安全合规包要单独跑，用来检查敏感内容是否被安全处理。"],
  },
  reports: {
    title: "报告中心怎么看",
    steps: ["先看“极简结论”。", "再看排行榜和最近失败记录。", "排查真实客户端问题时，把代理日志粘贴到“真实客户端日志分析”。", "需要给技术排查时，点“导出问题包”。"],
  },
  handoff: {
    title: "测试交付怎么用",
    steps: ["把检查清单过一遍。", "点“复制交付模板”。", "发给负责人时不要附 API Key 或整个 评测数据 目录。"],
  },
  manual: {
    title: "使用手册怎么用",
    steps: ["遇到不确定的地方先查这里。", "新功能上线后，手册会同步更新。", "如果页面和手册不一致，以页面当前提示为准。"],
  },
};

export function renderPageHelp(container, page) {
  const help = PAGE_HELP[page] || PAGE_HELP.dashboard;
  container.innerHTML = `
    <strong>${escapeHtml(help.title)}</strong>
    <ul>
      ${help.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
    </ul>
  `;
}
