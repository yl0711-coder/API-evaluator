import { BASIC_SCENARIOS } from "./basic.mjs";
import { CHINESE_SCENARIOS } from "./chinese.mjs";
import { CODING_SCENARIOS } from "./coding.mjs";
import { LONG_CONTEXT_SCENARIOS } from "./long-context.mjs";
import { SAFETY_SCENARIOS } from "./safety.mjs";
import { LIVEBENCH_SCENARIOS } from "./livebench.mjs";
import { envCompat } from "../env-compat.mjs";

// 场景能力标签（UI 展示用）：每个场景一个标签。规则：JSON 相关→代码，其余按内容归类。
// 多数场景按 category 直接映射；中文场景与 LiveBench 同 category 但内容各异，按 id 细分。
// 注：当前没有考"工具调用"的场景（工具调用在准入评测里测），该标签暂为预留。
const TAG_BY_CATEGORY = {
  connectivity: "响应速度",
  speed: "响应速度",
  structured: "代码", // 结构化 JSON 输出
  writing: "写作",
  coding: "代码",
  long_context: "长上下文",
  reasoning: "逻辑推理",
  safety: "内容安全",
};
const TAG_BY_ID = {
  "chinese-knowledge-history": "知识事实",
  "chinese-language-idiom": "知识事实",
  "chinese-reasoning-work": "逻辑推理",
  "chinese-writing-notice": "写作",
  "chinese-instruction-format": "写作",
  "chinese-structured-json": "代码",
};
function resolveScenarioTag(scenario) {
  if (TAG_BY_ID[scenario.id]) return TAG_BY_ID[scenario.id];
  // LiveBench 全为 category=livebench：表格重排输出 JSON/JSONL→代码，数学/逻辑谜题→逻辑推理。
  if (scenario.category === "livebench") {
    return scenario.id.includes("data_analysis") ? "代码" : "逻辑推理";
  }
  return TAG_BY_CATEGORY[scenario.category] || "";
}
// 浅拷贝挂上 tag，保留 id/prompt/scorer 等全部原字段；runner 按 id 过滤，不受影响。
function withTag(scenario) {
  return { ...scenario, tag: resolveScenarioTag(scenario) };
}

export const ABILITY_SCENARIOS = [
  ...BASIC_SCENARIOS,
  ...CODING_SCENARIOS,
  ...LONG_CONTEXT_SCENARIOS,
  ...CHINESE_SCENARIOS,
].map(withTag);

export const TEST_SCENARIOS = [
  ...ABILITY_SCENARIOS,
  ...enabledSafetyScenarios().map(withTag),
  ...enabledLiveBenchScenarios().map(withTag),
];

// 内容安全场景默认【关闭】，需显式开启（EVALUATOR_ENABLE_SAFETY_SCENARIOS=1）。
// 理由：这些是对你自己模型的"拒绝行为"红队测试（见 safety.mjs 文件头），提示词原文含
// 敏感类别字面；开源仓库默认关闭可避免被误解，需要做安全测试的人显式打开即可。
function enabledSafetyScenarios() {
  const flag = String(envCompat("ENABLE_SAFETY_SCENARIOS") || "").toLowerCase();
  return flag === "1" || flag === "true" ? SAFETY_SCENARIOS : [];
}

// LiveBench 抗污染难题包默认【关闭】，需显式开启（EVALUATOR_ENABLE_LIVEBENCH=1）。
// 理由：硬题更耗额度，主要服务档位降级判别这一特定用途（见 livebench.mjs 文件头）；
// 客观 ground-truth 判分（exact/structured），不污染默认场景跑。
function enabledLiveBenchScenarios() {
  const flag = String(envCompat("ENABLE_LIVEBENCH") || "").toLowerCase();
  return flag === "1" || flag === "true" ? LIVEBENCH_SCENARIOS : [];
}
