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

// 规则形态：
//   threshold        = 「一个指标 + 一个比较符 + 一个阈值」（本页原始形态，缺省即此值，
//                      老规则 JSON 不带 kind 也能正常加载）；
//   stability-jitter = 复合规则，看【单次运行内部】的离散度，多个子阈值任一越界即不合格；
//   stability-decline= 复合规则，看【与自身历史比】——最近 N 次的中位数 vs 之前 M 次的中位数。
// 后两者都是「一条规则挂多项、任一越界即判不合格、发一封邮件列出全部越界项」。
export const RULE_KINDS = ["threshold", "stability-jitter", "stability-decline"];
export const JITTER_KIND = "stability-jitter";
// 命名用 decline 而非 regression：本仓库 regression 已专指内建基线回归
// （regression.mjs 的 detectRegression / regression_alerts 表 / 趋势页横幅），复用该词会歧义。
export const DECLINE_KIND = "stability-decline";

// 稳定性抖动的三个子阈值。各自可选（null = 不检查该项），但至少要配一项，
// 否则这条规则永远不可能命中——那是配置错误，validateRule 会拦。
// 方向写死在字段名里（Max = 高于即越界，Min = 低于即越界），故不需要 comparator。
export const JITTER_PARAM_KEYS = ["jitterRatioMax", "firstAttemptSuccessRateMin", "retryOverheadP95MsMax"];

// 稳定性退化的参数分两类，校验口径不同：
//   窗口尺寸（recentRuns/baselineRuns）：必填，缺失/非法兜默认值并钳到合理区间；
//   判定阈值（successRateDropPp/p95WorsenRatio）：各自可选（null = 不查该维），但至少配一项。
export const DECLINE_WINDOW_KEYS = ["recentRuns", "baselineRuns"];
export const DECLINE_THRESHOLD_KEYS = ["successRateDropPp", "p95WorsenRatio"];

// 基线样本下限，也是 baselineRuns 的钳制下界。评估器（splitWindows）拿它当"低于此值不判定"的门槛。
// 【必须单一事实来源】：这个数曾在 store 与 evaluator 各写一份（store 下界 2、evaluator 门槛 5），
// 于是 baselineRuns 填 2~4 时——UI 允许、校验通过、保存成功、卡片正常显示——规则却永远不命中，
// 用户完全无从察觉。两处各写一个常量就是这种静默失效的根源，故从这里导出、评估器 import。
export const MIN_BASELINE_SAMPLES = 5;

// 窗口尺寸默认值与钳制区间。baseline 上界 200 对齐 queryProfileRunSummaries 的默认 limit；
// 下界即 MIN_BASELINE_SAMPLES——填更小的值会被钳上来，而不是存下一条永不生效的规则。
const DECLINE_WINDOW_SPEC = {
  recentRuns: { def: 3, min: 1, max: 20 },
  baselineRuns: { def: 20, min: MIN_BASELINE_SAMPLES, max: 200 },
};

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

// 子阈值取值：null/undefined/"" 一律视为「不检查该项」，落 null。
// 不能用 Number.isFinite(Number(v)) 直接判——Number(null) 和 Number("") 都是 0（有限数），
// 会把「没配」当成「阈值 0」，进而让 firstAttemptSuccessRateMin 恒不越界、
// 让 jitterRatioMax 恒越界（任何倍数都 > 0），两头都是错的。
// 非正数同样落 null：比值/毫秒/成功率的阈值取 0 或负数无实际意义。
function normalizeJitterParam(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10000) / 10000;
}

function normalizeJitterParams(raw, existing) {
  const src = raw && typeof raw === "object" ? raw : {};
  const prev = existing && typeof existing === "object" ? existing : {};
  const out = {};
  for (const key of JITTER_PARAM_KEYS) {
    // 显式传了该键（含 null / "" 表示「清空这一项」）就以本次为准，否则沿用 existing。
    out[key] = normalizeJitterParam(key in src ? src[key] : prev[key]);
  }
  return out;
}

// 窗口尺寸：必须是正整数，缺失/非法 → 兜默认值；超出区间 → 钳住（而非兜默认，
// 用户填 999 的意图明显是「尽量多」，钳到上界比悄悄回落成 20 更符合预期）。
function normalizeWindowSize(v, spec) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, Math.floor(n)));
}

function normalizeDeclineParams(raw, existing) {
  const src = raw && typeof raw === "object" ? raw : {};
  const prev = existing && typeof existing === "object" ? existing : {};
  const out = {};
  const pick = (key) => (key in src ? src[key] : prev[key]);
  for (const key of DECLINE_WINDOW_KEYS) {
    out[key] = normalizeWindowSize(pick(key), DECLINE_WINDOW_SPEC[key]);
  }
  for (const key of DECLINE_THRESHOLD_KEYS) {
    // 判定阈值与 jitter 同口径：null/""/非数/非正 → null（= 不查该维）。
    out[key] = normalizeJitterParam(pick(key));
  }
  return out;
}

// 规范化：只认已知字段 + 类型强制，杜绝脏数据。existing 用于保留 id/createdAt。
export function normalizeRule(raw, existing = null) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? existing?.id ?? "").trim() || `alr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const kind = RULE_KINDS.includes(raw.kind) ? raw.kind : RULE_KINDS.includes(existing?.kind) ? existing.kind : "threshold";
  const metric = ALERT_METRICS.includes(raw.metric) ? raw.metric : String(existing?.metric || "successRate");
  const comparator = ALERT_COMPARATORS.includes(raw.comparator) ? raw.comparator : String(existing?.comparator || "lt");
  const isLevelMetric = LEVEL_METRICS.includes(metric);
  const rawThreshold = raw.threshold ?? existing?.threshold;
  const threshold = isLevelMetric ? String(rawThreshold ?? "").trim() : Number(rawThreshold);
  // 冷却时长：允许小数、最短 0.1 小时（6 分钟）；无效/非正 → 默认 1。
  const rawCooldown = Number(raw.cooldownHours ?? existing?.cooldownHours);
  const cooldownHours = Number.isFinite(rawCooldown) && rawCooldown > 0 ? Math.max(0.1, Math.round(rawCooldown * 100) / 100) : 1;
  const scope = normalizeScope(raw.scope ?? existing?.scope);
  const base = {
    id,
    kind,
    name: String(raw.name ?? existing?.name ?? "")
      .trim()
      .slice(0, 120),
    enabled: raw.enabled === undefined ? existing?.enabled !== false : Boolean(raw.enabled),
    scope,
    cooldownHours,
    createdAt: existing?.createdAt || raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // 三种形态各存各自的判定字段，互不掺杂：复合规则（jitter/decline）不带
  // metric/comparator/threshold（带了也是死字段，只会让人误以为它在参与判定），
  // threshold 规则不带 params。
  if (kind === JITTER_KIND) {
    return { ...base, params: normalizeJitterParams(raw.params, existing?.params) };
  }
  if (kind === DECLINE_KIND) {
    return { ...base, params: normalizeDeclineParams(raw.params, existing?.params) };
  }
  return { ...base, metric, comparator, threshold };
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
  if (rule.kind && !RULE_KINDS.includes(rule.kind)) return "规则类型不合法。";
  if (rule.scope?.type === "target" && !rule.scope.targetId) return "指定范围时必须选择渠道与模型。";
  if (!(Number.isFinite(rule.cooldownHours) && rule.cooldownHours >= 0.1)) return "冷却时长必须是不小于 0.1 的数（小时）。";
  // 稳定性抖动：走子阈值校验，不碰 metric/comparator/threshold（这类规则不存这三个字段）。
  if (rule.kind === JITTER_KIND) {
    const configured = JITTER_PARAM_KEYS.filter((key) => Number.isFinite(rule.params?.[key]));
    if (!configured.length) return "稳定性抖动规则至少要配一项子阈值（抖动倍数 / 首次成功率 / 重试额外等待）。";
    const srMin = rule.params.firstAttemptSuccessRateMin;
    if (Number.isFinite(srMin) && srMin > 1) return "首次成功率阈值是 0～1 的小数（如 0.9 表示 90%）。";
    return null;
  }
  // 稳定性退化：窗口尺寸由 normalizeRule 保证合法（兜默认+钳制），这里只校验判定阈值。
  if (rule.kind === DECLINE_KIND) {
    const configured = DECLINE_THRESHOLD_KEYS.filter((key) => Number.isFinite(rule.params?.[key]));
    if (!configured.length) return "稳定性退化规则至少要配一项判定阈值（成功率跌幅 / P95 恶化倍数）。";
    const dropPp = rule.params.successRateDropPp;
    if (Number.isFinite(dropPp) && dropPp > 1) return "成功率跌幅是 0～1 的小数（如 0.1 表示 10 个百分点）。";
    for (const key of DECLINE_WINDOW_KEYS) {
      if (!(Number.isFinite(rule.params?.[key]) && rule.params[key] >= 1)) return "窗口大小必须是不小于 1 的整数。";
    }
    return null;
  }
  if (!ALERT_METRICS.includes(rule.metric)) return "指标不合法。";
  if (!ALERT_COMPARATORS.includes(rule.comparator)) return "比较符不合法。";
  if (LEVEL_METRICS.includes(rule.metric)) {
    if (!rule.threshold) return "请选择等级阈值。";
  } else if (!Number.isFinite(rule.threshold)) {
    return "阈值必须是数值。";
  }
  return null;
}
