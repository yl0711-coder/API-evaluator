// server/alert-rule-state.mjs
// 报警规则的冷却状态：记录「规则 id × 目标 key」上次触发时间，评估器据此判断是否还在冷却期内。
// 与规则定义（alert-rules-store.mjs）分离——触发状态频繁写入，分开存避免污染规则配置文件。
// 持久层仿 high-risk-store：writeJsonAtomic 原子写 + 一把锁串行化。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ALERT_RULE_STATE_FILE } from "./paths.mjs";
import { writeJsonAtomic } from "./utils.mjs";

// targetKey："all" 或具体 targetId；与 ruleId 拼接成状态表的 key。
function stateKey(ruleId, targetKey) {
  return `${ruleId}::${targetKey || "all"}`;
}

let stateFile = ALERT_RULE_STATE_FILE;
let writeChain = Promise.resolve();

async function loadAll() {
  try {
    if (!existsSync(stateFile)) return {};
    const raw = JSON.parse((await readFile(stateFile, "utf8")) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

// 串行化读改写：load → mutator(原地改对象) → 原子写。多条规则并发触发时不互相覆盖。
function update(mutator) {
  const runOnce = async () => {
    const state = await loadAll();
    const value = await mutator(state);
    await writeJsonAtomic(stateFile, state);
    return value;
  };
  const next = writeChain.then(runOnce, runOnce);
  writeChain = next.then(
    () => {},
    () => {},
  );
  return next;
}

// 上次触发时间（ISO 字符串），无记录返回 null。
export async function getLastFiredAt(ruleId, targetKey) {
  const state = await loadAll();
  return state[stateKey(ruleId, targetKey)] || null;
}

// 记录本次触发时间为当前时刻。
export async function markFired(ruleId, targetKey) {
  const key = stateKey(ruleId, targetKey);
  await update((state) => {
    state[key] = new Date().toISOString();
    return null;
  });
}

// —— 测试钩子 ——
export function __setRuleStateFileForTest(file) {
  stateFile = file || ALERT_RULE_STATE_FILE;
}
export function __resetRuleStateWriteChainForTest() {
  writeChain = Promise.resolve();
}
