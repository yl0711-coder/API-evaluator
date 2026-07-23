// server/alert-rules-evaluator.mjs
// 报警规则评估：运行完成后（onRunComplete 钩子），把结果归一化成逐目标指标条目，
// 对每条启用规则做范围匹配 + 阈值比较 + 冷却检查，命中则发邮件。
// best-effort：全程 try/catch 吞错，绝不影响测试/调度主流程（与 high-risk-store 的 noteRunIfEnabled 同惯例）。
import { getRules, LEVEL_METRICS } from "./alert-rules-store.mjs";
import { getLastFiredAt, markFired } from "./alert-rule-state.mjs";
import { getNotifyConfig } from "./notify-config.mjs";
import { readSecret } from "./secret-store.mjs";
import { sendMail } from "./mailer.mjs";

const SMTP_PASSWORD_REF = "notify:smtp-password";

// 等级序数表：数值越大越差。grade 复用 regression.mjs 的既定顺序；
// recommendation.level / verdict.level 目前无导出常量，这里各自定义本地序数表。
const GRADE_ORDER = ["A", "B", "C", "D", "E", "X", "F"];
const RECOMMENDATION_ORDER = ["pass", "watch", "fail"];
const VERDICT_ORDER = ["ok", "watch", "suspect"];
const LEVEL_ORDERS = {
  grade: GRADE_ORDER,
  recommendationLevel: RECOMMENDATION_ORDER,
  verdictLevel: VERDICT_ORDER,
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// result 无统一 type 字段：admission/scenario/batch-admission/quick-verify 有 type；
// 批量稳定性只有 batchId；单渠道稳定性两者皆无。（与 high-risk-store.testTypeOf 同一判定）
function testTypeOf(result) {
  if (result.type) return result.type;
  if (result.batchId) return "batch-stability";
  return "stability";
}

// 从单个结果对象（admission/stability/quick-verify 的 result 本身，或 batch-*/scenario 的 results[] 单项）
// 里取出评估器认得的指标集合。
function metricsOf(item) {
  return {
    successRate: num(item.successRate),
    p95TotalMs: num(item.p95TotalMs),
    avgTotalMs: num(item.avgTotalMs),
    score: num(item.score),
    grade: item.grade || null,
    avgQualityScore: num(item.avgQualityScore),
    recommendationLevel: item.recommendation?.level || null,
    verdictLevel: item.verdict?.level || null,
  };
}

// 把六种运行结果形状统一展开成条目数组：{ targetId, profileName, model, metrics }。
// batch-admission/batch-stability 用 results[]（含完整数值字段）；scenario 用 results[]（即 profileResults，
// 同样含完整数值字段，profileDigest 的 successRateText 是格式化字符串无法数值比较，故不用它）。
function collectEntries(result) {
  const type = testTypeOf(result);
  if (type === "batch-admission" || type === "batch-stability" || type === "scenario") {
    const items = Array.isArray(result.results) ? result.results : [];
    return items
      .filter((item) => item && item.profileId)
      .map((item) => ({
        targetId: item.profileId,
        profileName: item.profileName || "",
        model: item.model || "",
        metrics: metricsOf(item),
      }));
  }
  // 单结果类型：admission / stability / quick-verify
  if (!result.profileId) return [];
  return [
    {
      targetId: result.profileId,
      profileName: result.profileName || "",
      model: result.model || "",
      metrics: metricsOf(result),
    },
  ];
}

function ruleMatchesScope(rule, targetId) {
  if (rule.scope?.type === "all") return true;
  return rule.scope?.type === "target" && rule.scope.targetId === targetId;
}

// 数值比较 / 等级序数比较，统一走这里。metric 不存在于该条目（null）时视为不满足，不误报。
function ruleHits(rule) {
  return (metrics) => {
    const value = metrics[rule.metric];
    if (value === null || value === undefined) return false;
    if (LEVEL_METRICS.includes(rule.metric)) {
      const order = LEVEL_ORDERS[rule.metric] || [];
      const valueRank = order.indexOf(value);
      const thresholdRank = order.indexOf(rule.threshold);
      if (valueRank < 0 || thresholdRank < 0) return false;
      return compare(valueRank, rule.comparator, thresholdRank);
    }
    return compare(value, rule.comparator, rule.threshold);
  };
}

function compare(value, comparator, threshold) {
  switch (comparator) {
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "eq":
      return value === threshold;
    default:
      return false;
  }
}

function describeHit(rule, entry) {
  const who = entry.model || entry.profileName || entry.targetId;
  return `规则「${rule.name}」命中：${who} 的 ${rule.metric} = ${entry.metrics[rule.metric]}（阈值 ${rule.comparator} ${rule.threshold}）`;
}

async function sendAlertMail(rule, entry, reason) {
  const cfg = getNotifyConfig();
  if (!cfg.smtpHost || !cfg.recipients) return; // 未配置 SMTP：静默跳过，不影响主流程
  const smtpPassword = await readSecret(SMTP_PASSWORD_REF);
  const subject = `【API-evaluator 报警】${rule.name}`;
  const body = `${reason}\n\n触发时间：${new Date().toISOString()}`;
  await sendMail({ ...cfg, smtpPassword }, subject, body);
}

// 运行完成钩子：对该次结果的每个目标条目 × 每条启用规则做匹配/阈值/冷却判断，命中则发信。
// best-effort：任何异常吞掉并记日志，绝不向上抛出。
export async function evaluateAlertRules(result) {
  try {
    if (!result || typeof result !== "object") return;
    const entries = collectEntries(result);
    if (!entries.length) return;
    const rules = (await getRules()).filter((rule) => rule.enabled);
    if (!rules.length) return;

    for (const entry of entries) {
      for (const rule of rules) {
        if (!ruleMatchesScope(rule, entry.targetId)) continue;
        if (!ruleHits(rule)(entry.metrics)) continue;

        const targetKey = rule.scope?.type === "all" ? "all" : entry.targetId;
        const lastFiredAt = await getLastFiredAt(rule.id, targetKey);
        if (lastFiredAt) {
          const elapsedHours = (Date.now() - new Date(lastFiredAt).getTime()) / 3_600_000;
          if (elapsedHours < rule.cooldownHours) continue; // 冷却期内，跳过不发信
        }

        try {
          await sendAlertMail(rule, entry, describeHit(rule, entry));
        } catch (error) {
          console.error("[alert-rules] 发信失败：", error?.message || error);
        }
        await markFired(rule.id, targetKey);
      }
    }
  } catch (error) {
    console.error("[alert-rules] 评估失败：", error?.message || error);
  }
}
