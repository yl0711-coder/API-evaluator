// server/alert-rules-store.mjs
// 报警规则存储（纯 JSON，仿 auto-test-store）：任意登录管理员在「报警规则」页配置的自定义阈值报警规则，
// 按 id 存进持久卷 /data 下的 ALERT_RULES_FILE。规则只是纯数据（阈值/范围/冷却），不含任何密钥。
// load/save 用 writeJsonAtomic 原子写，防写一半崩溃损坏 JSON。
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ALERT_RULES_FILE } from "./paths.mjs";
import { writeJsonAtomic } from "./utils.mjs";

// 支持的指标：均可从 alert-rules-evaluator 归一化出的运行结果条目里取到。
export const ALERT_METRICS = [
  "successRate",
  "p95TotalMs",
  "avgTotalMs",
  "score",
  "grade",
  "avgQualityScore",
  "recommendationLevel",
  "verdictLevel",
];
// grade/level 型指标：threshold 是字符串（等级名），比较走序数表，不走数值比较。
export const LEVEL_METRICS = ["grade", "recommendationLevel", "verdictLevel"];
export const ALERT_COMPARATORS = ["lt", "lte", "gt", "gte", "eq"];

let rulesFile = ALERT_RULES_FILE;

export function __setRulesFileForTest(file) {
  rulesFile = file || ALERT_RULES_FILE;
}

export async function loadRules() {
  try {
    if (!existsSync(rulesFile)) return [];
    const raw = JSON.parse((await readFile(rulesFile, "utf8")) || "[]");
    if (!Array.isArray(raw)) return [];
    // 已知问题（暂不修）：normalizeRule 每次都会盖一个新的 updatedAt（见下方函数），而这里是【读取】
    // 路径、不落盘——纯读取（如两次 GET /api/alert-rules）之间 updatedAt 会跳动，前端显示的
    // 「更新时间」因此失真；编辑某一条规则时，同批 loadRules() 读出的其它未改动规则也会被
    // 连带刷出相同的 updatedAt（updateRules 的 mutator 只改了目标那条，但 saveRules 落盘的是
    // 这次 loadRules() 归一化后的整个数组）。只是显示层的时间戳失真，不影响规则本身的匹配/冷却逻辑。
    return raw.map((rule) => normalizeRule(rule, rule)).filter(Boolean);
  } catch {
    return [];
  }
}

export async function saveRules(rules) {
  await writeJsonAtomic(rulesFile, Array.isArray(rules) ? rules : []);
}

// 抛出此错误的 updateRules mutator 表示"校验失败、勿保存"，端点据此回 400。
export class RuleValidationError extends Error {}

// 串行化的读改写：load → mutator(rules)（原地改数组）→ save，全程一把锁排队。
// 消除并发写竞争——多个管理员同时增删改规则也不会互相覆盖。
let writeChain = Promise.resolve();
export function updateRules(mutator) {
  const runOnce = async () => {
    const rules = await loadRules();
    const value = await mutator(rules); // 原地改 rules；抛错 → 下面 saveRules 不执行
    await saveRules(rules);
    return value;
  };
  const next = writeChain.then(runOnce, runOnce); // 无论前一次成败都接着排队
  writeChain = next.then(
    () => {},
    () => {},
  ); // 链本身吞掉结果/错误，各调用方只看自己的 next
  return next;
}

export function __resetWriteChainForTest() {
  writeChain = Promise.resolve();
}

// 供评估器同步读取：评估器不关心并发写入的极端时序，一次 loadRules() 足够新鲜。
export async function getRules() {
  return loadRules();
}

// 规范化：只认已知字段 + 类型强制，杜绝脏数据。existing 用于保留 id/createdAt。
export function normalizeRule(raw, existing = null) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? existing?.id ?? "").trim() || `alr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const metric = ALERT_METRICS.includes(raw.metric) ? raw.metric : String(existing?.metric || "successRate");
  const comparator = ALERT_COMPARATORS.includes(raw.comparator) ? raw.comparator : String(existing?.comparator || "lt");
  const isLevelMetric = LEVEL_METRICS.includes(metric);
  const rawThreshold = raw.threshold ?? existing?.threshold;
  const threshold = isLevelMetric ? String(rawThreshold ?? "").trim() : Number(rawThreshold);
  // 冷却时长：允许小数、最短 0.1 小时（6 分钟）；无效/非正 → 默认 1。
  const rawCooldown = Number(raw.cooldownHours ?? existing?.cooldownHours);
  const cooldownHours = Number.isFinite(rawCooldown) && rawCooldown > 0 ? Math.max(0.1, Math.round(rawCooldown * 100) / 100) : 1;
  const scope = normalizeScope(raw.scope ?? existing?.scope);
  return {
    id,
    name: String(raw.name ?? existing?.name ?? "")
      .trim()
      .slice(0, 120),
    enabled: raw.enabled === undefined ? existing?.enabled !== false : Boolean(raw.enabled),
    scope,
    metric,
    comparator,
    threshold,
    cooldownHours,
    createdAt: existing?.createdAt || raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeScope(raw) {
  if (raw && typeof raw === "object" && raw.type === "target") {
    const targetId = String(raw.targetId ?? "").trim();
    if (targetId) return { type: "target", targetId };
  }
  return { type: "all" };
}

// 校验：返回可读错误串，null 表示通过。referential 校验（targetId 是否可运行）在端点层做。
export function validateRule(rule) {
  if (!rule || typeof rule !== "object") return "规则必须是对象。";
  if (!rule.name) return "请填写规则名称。";
  if (!ALERT_METRICS.includes(rule.metric)) return "指标不合法。";
  if (!ALERT_COMPARATORS.includes(rule.comparator)) return "比较符不合法。";
  if (rule.scope?.type === "target" && !rule.scope.targetId) return "指定范围时必须选择渠道与模型。";
  if (LEVEL_METRICS.includes(rule.metric)) {
    if (!rule.threshold) return "请选择等级阈值。";
  } else if (!Number.isFinite(rule.threshold)) {
    return "阈值必须是数值。";
  }
  if (!(Number.isFinite(rule.cooldownHours) && rule.cooldownHours >= 0.1)) return "冷却时长必须是不小于 0.1 的数（小时）。";
  return null;
}
