import { BASIC_SCENARIOS } from "./basic.mjs";
import { CHINESE_SCENARIOS } from "./chinese.mjs";
import { CODING_SCENARIOS } from "./coding.mjs";
import { LONG_CONTEXT_SCENARIOS } from "./long-context.mjs";
import { SAFETY_SCENARIOS } from "./safety.mjs";
import { envCompat } from "../env-compat.mjs";

export const ABILITY_SCENARIOS = [
  ...BASIC_SCENARIOS,
  ...CODING_SCENARIOS,
  ...LONG_CONTEXT_SCENARIOS,
  ...CHINESE_SCENARIOS,
];

export const TEST_SCENARIOS = [
  ...ABILITY_SCENARIOS,
  ...enabledSafetyScenarios(),
];

// 内容安全场景默认【关闭】，需显式开启（EVALUATOR_ENABLE_SAFETY_SCENARIOS=1）。
// 理由：这些是对你自己模型的"拒绝行为"红队测试（见 safety.mjs 文件头），提示词原文含
// 敏感类别字面；开源仓库默认关闭可避免被误解，需要做安全测试的人显式打开即可。
function enabledSafetyScenarios() {
  const flag = String(envCompat("ENABLE_SAFETY_SCENARIOS") || "").toLowerCase();
  return flag === "1" || flag === "true" ? SAFETY_SCENARIOS : [];
}
