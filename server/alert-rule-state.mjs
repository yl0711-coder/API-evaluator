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

// 清掉某条规则的全部冷却记录（该规则 × 所有 targetKey）。规则被删除时调用。
// 不清的话，键会永久留在状态文件里：每删一条触发过的规则就多一条孤儿键，长期只增不减。
// 更实际的风险是【id 复用】——虽然当前 id 是随机 UUID 前 16 位、复用概率极低，
// 但一旦复用，新规则会继承前任的冷却时间，可能一上线就处于沉默期。
// best-effort：失败不影响删除本身（规则已经删了，残留几条键无害）。
export async function clearRuleState(ruleId) {
  const prefix = `${ruleId}::`;
  try {
    await update((state) => {
      for (const key of Object.keys(state)) {
        if (key.startsWith(prefix)) delete state[key];
      }
      return null;
    });
  } catch (error) {
    console.error("[alert-rules] 清理冷却状态失败：", error?.message || error);
  }
}

// —— 测试钩子 ——
export function __setRuleStateFileForTest(file) {
  stateFile = file || ALERT_RULE_STATE_FILE;
}
// 直接写整份状态：供测试构造 markFired 无法产生的异常值（如落在未来的时间戳、坏字符串），
// 用来验证时钟回拨/状态文件被外部写坏时冷却不会永久卡死。
export function __writeStateForTest(state) {
  return update((s) => {
    for (const key of Object.keys(s)) delete s[key];
    Object.assign(s, state);
    return null;
  });
}
export function __resetRuleStateWriteChainForTest() {
  writeChain = Promise.resolve();
}
