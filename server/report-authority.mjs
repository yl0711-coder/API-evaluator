// 报告权威性层：版本/溯源头、方法学说明、参考文献、复核、“疑似”措辞免责。
// 纯字符串构造，不依赖具体报告 formatter，便于独立测试与复用。
import { APP_VERSION } from "./version.mjs";

export const REPORT_TOOL_VERSION = APP_VERSION;
export const REPORT_TEMPLATE_VERSION = "2.0.0";

export const SUSPECTED_WORDING_DISCLAIMER =
  "本报告涉及身份/纯度/计费的判断均为基于软件黑盒的概率性结论，仅表述为“疑似/证据支持/需上游解释”，" +
  "不构成“确定造假”的事实认定；量化降级（如 8-bit）等情形存在检测盲区。";

// 报告头 7 项版本/溯源信息。缺失项以占位符渲染，绝不留空。
export function buildReportAuthorityHeader(summary = {}, options = {}) {
  const meta = options.meta || summary.meta || {};
  return [
    "## 报告信息（版本与溯源）",
    "",
    `- 工具版本：${options.toolVersion || REPORT_TOOL_VERSION}`,
    `- 报告模板版本：${REPORT_TEMPLATE_VERSION}`,
    `- 模型快照时间：${meta.modelSnapshotTime || summary.startedAt || "-"}`,
    `- 测试包标识：${meta.testPackId || summary.runId || summary.batchId || "-"}`,
    `- 评测人：${meta.evaluator || "-"}`,
    `- 复核人：${meta.reviewer || "待复核"}`,
    `- 复核状态：${meta.reviewStatus || "待复核"}`,
    "",
  ];
}

export function buildMethodologyNotes() {
  return [
    "## 方法学说明",
    "",
    "- 比例指标（成功率等）给出样本数与 95% 置信区间（Wilson，小样本安全），小样本不用 CLT 正态近似。",
    "- 延迟为重尾分布，报告 P50/P95/P99，不以平均值代表稳定性。",
    "- 多渠道对比做显著性判定：置信区间重叠或不显著时不下“A 优于 B”。",
    "- 身份/纯度：tokenizer 计数粗筛 + 行为指纹 +（高价档）RUT 排序均匀性检验，结论为概率判断。",
    "- 计费：本地估算对照（本地估算 vs 上游 usage），异常仅作“疑似”信号。",
    "- 质量分若由 LLM 裁判产生，多裁判一致性（Krippendorff α）低于 0.8 标注“需人工复核”。",
    "",
  ];
}

export function buildBibliography() {
  return [
    "## 参考文献 / 方法学出处",
    "",
    "- Wilson (1927) score interval；Efron bootstrap 置信区间。",
    "- McNemar / Wilcoxon signed-rank / paired-t 显著性检验。",
    "- Google SRE 四黄金信号与 SLI/SLO（稳定性与延迟分位数）。",
    "- 模型替换检测：RUT 排序均匀性检验、FDLLM 家族指纹（Model Substitution Detection）。",
    "- 计费审计：本地估算对照 / CoIn token 真实性方法学。",
    "- LLM-as-Judge：MT-Bench / G-Eval；Krippendorff α、Gwet AC 一致性系数。",
    "- 协议兼容：Anthropic Messages / OpenAI 规范、WHATWG SSE Living Standard。",
    "",
  ];
}

// 收集高敏感结论（疑似降智/换模型/灌水/不建议接入），需第二人复核。
export function collectHighSensitivityFindings(summary = {}) {
  const findings = [];
  const level = summary.recommendation?.level;
  if (level === "reject" || level === "avoid" || level === "not_recommended") {
    findings.push("不建议接入：请第二人复核失败证据与结论。");
  }
  for (const f of summary.tokenAuditFindings || []) {
    if (f.level === "high" || f.level === "medium") findings.push(`计费疑似异常：${f.note || f.code}`);
  }
  if (summary.identitySuspected) findings.push("身份/纯度疑似异常：需第二人复核证据链。");
  return findings;
}

export function buildReviewSection(findings = []) {
  if (!findings.length) {
    return ["## 复核", "", "- 本报告未触发高敏感结论，无需第二人复核。", ""];
  }
  return [
    "## 复核（高敏感结论，需第二人签字）",
    "",
    ...findings.map((f) => `- ${f}`),
    "",
    "- 复核人：__________   复核结论：__________   日期：__________",
    "",
  ];
}

// 报告尾部权威性附录：方法学说明 + 参考文献 + 复核 + 免责。
export function buildReportAppendix(summary = {}, options = {}) {
  return [
    ...buildMethodologyNotes(),
    ...buildBibliography(),
    ...buildReviewSection(options.highSensitivityFindings || collectHighSensitivityFindings(summary)),
    "## 免责声明",
    "",
    `- ${SUSPECTED_WORDING_DISCLAIMER}`,
    "- 报告不包含 API Key；敏感字段已脱敏。",
    "",
  ];
}
