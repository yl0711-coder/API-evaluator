import { BASIC_SCENARIOS } from "./basic.mjs";
import { CHINESE_SCENARIOS } from "./chinese.mjs";
import { CODING_SCENARIOS } from "./coding.mjs";
import { LONG_CONTEXT_SCENARIOS } from "./long-context.mjs";
import { SAFETY_SCENARIOS } from "./safety.mjs";
import { LIVEBENCH_SCENARIOS } from "./livebench.mjs";
import { HLE_SCENARIOS } from "./hle.mjs";
import { HARDCORE_LOGIC_SCENARIOS } from "./hardcore-logic.mjs";
import { getSettings } from "../settings-store.mjs";

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
  // HLE 全为 category=hle，跨学科：理工科按推理归类，其余按知识事实归类（依原始 hleCategory）。
  if (scenario.category === "hle") {
    const reasoningCats = ["Math", "Physics", "Engineering", "Computer Science/AI"];
    return reasoningCats.includes(scenario.hleCategory) ? "逻辑推理" : "知识事实";
  }
  // HardcoreLogic 全为 category=hardcore-logic：10 类逻辑谜题的长尾变体/无解题，统归逻辑推理。
  if (scenario.category === "hardcore-logic") return "逻辑推理";
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

// 运行时场景列表（数据驱动「设置」，完全脱离环境变量）：
//   - LiveBench 抗污染难题、安全红线红队题默认【关闭】，仅当「设置」开启时纳入。
//   - 同步读 settings 缓存，便于 /api/scenarios、runScenarioTest 等同步消费。
export function getTestScenarios() {
  const settings = getSettings();
  return [
    ...ABILITY_SCENARIOS,
    ...(settings.enableSafety ? SAFETY_SCENARIOS.map(withTag) : []),
    ...(settings.enableLivebench ? LIVEBENCH_SCENARIOS.map(withTag) : []),
    ...(settings.enableHle ? HLE_SCENARIOS.map(withTag) : []),
    ...(settings.enableHardcoreLogic ? HARDCORE_LOGIC_SCENARIOS.map(withTag) : []),
  ];
}

// 向后兼容快照（import 期、设置缓存未加载 → 只含 ABILITY）。运行时一律调 getTestScenarios()。
export const TEST_SCENARIOS = getTestScenarios();
