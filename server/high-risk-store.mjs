// server/high-risk-store.mjs
// 「高危报告提示」：运行完成时按「结论等级 或 分数阈值」判危，把高危报告记入未读集合（持久卷 /data 下
// HIGH_RISK_ALERTS_FILE），前端顶部红底横幅逐条列出、点掉即移除。仅在设置开启时记录，只覆盖开启后新产生的运行。
// 判危信号只在 runner 返回的 result 上（reports 表/ test_runs 列都不含 grade/score/level）。持久层仿 auto-test-store：
// writeJsonAtomic 原子写 + 一把锁串行化，与端点 ack 互不覆盖。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { HIGH_RISK_ALERTS_FILE } from "./paths.mjs";
import { writeJsonAtomic } from "./utils.mjs";
import { getSettings } from "./settings-store.mjs";
import { reportIdFromHtmlPath } from "./report-files.mjs";

// —— 判危口径：结论等级 或 分数阈值，任一命中即高危 ——
const SCORE_MIN = 60; // 准入综合分 / 场景质量分低于此判高危
const SUCCESS_MIN = 0.8; // 稳定性成功率低于此判高危
const BAD_GRADES = new Set(["D", "E", "F", "X"]);
const TYPE_LABEL = {
  admission: "准入",
  "batch-admission": "准入",
  scenario: "场景",
  stability: "稳定性",
  "batch-stability": "稳定性",
  "quick-verify": "快速验证",
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pct = (v) => `${Math.round(Number(v) * 100)}%`;

// result 无统一 type 字段：admission/scenario/batch-admission/quick-verify 有 type；
// 批量稳定性只有 batchId（批量准入既有 type 又有 batchId，故先看 type）；单渠道稳定性两者皆无。
function testTypeOf(result) {
  if (result.type) return result.type;
  if (result.batchId) return "batch-stability";
  return "stability";
}

// 单篇报告（admission/stability/quickverify）的高危原因，非高危返回 null。
function riskReasonSingle(result, type) {
  if (type === "quick-verify") return result.verdict?.level === "suspect" ? "快速验证：疑似可疑" : null;
  if (type === "admission") {
    if (result.grade && BAD_GRADES.has(result.grade)) return `准入 ${result.grade} 级`;
    if (result.recommendation?.level === "fail") return "结论：不推荐";
    if (num(result.score) !== null && num(result.score) < SCORE_MIN) return `综合分 ${result.score}`;
    return null;
  }
  // stability
  if (result.recommendation?.level === "fail") return "结论：不推荐";
  if (num(result.successRate) !== null && num(result.successRate) < SUCCESS_MIN) return `成功率 ${pct(result.successRate)}`;
  return null;
}

// 逐模型报告（scenario / batch-admission 的 reports[] 项）的高危原因。
function riskReasonReport(rep, type, digestByProfile) {
  if (type === "batch-admission") {
    if (rep.grade && BAD_GRADES.has(rep.grade)) return `准入 ${rep.grade} 级`;
    if (num(rep.score) !== null && num(rep.score) < SCORE_MIN) return `综合分 ${rep.score}`;
    return null;
  }
  // scenario：等级从 profileDigest 按 profileId 取，分数用该模型 avgQualityScore
  if (digestByProfile.get(rep.profileId)?.recommendation?.level === "fail") return "结论：不推荐";
  if (num(rep.avgQualityScore) !== null && num(rep.avgQualityScore) < SCORE_MIN) return `质量分 ${rep.avgQualityScore}`;
  return null;
}

// 从一次运行结果枚举出所有高危报告 { reportId, testType, label, reason }。
// scenario / batch-admission 逐模型判（每模型一篇报告）；其余整篇判。空 reportId / 非高危跳过。
export function collectHighRiskReports(result) {
  if (!result || typeof result !== "object") return [];
  const type = testTypeOf(result);
  const typeName = TYPE_LABEL[type] || "报告";
  const out = [];
  const push = (reportHtmlPath, who, reason) => {
    if (!reason) return;
    const reportId = reportIdFromHtmlPath(reportHtmlPath || "");
    if (!reportId) return;
    out.push({ reportId, testType: type, label: `${typeName}${who ? " · " + who : ""}`, reason });
  };

  if (Array.isArray(result.reports) && result.reports.length) {
    const digestByProfile = new Map((result.profileDigest || []).map((d) => [d.profileId, d]));
    for (const rep of result.reports) {
      push(rep.reportHtmlPath, rep.model || rep.profileName || "", riskReasonReport(rep, type, digestByProfile));
    }
    return out;
  }

  let reason;
  if (type === "batch-stability") {
    const bad = (result.results || []).some(
      (r) => r?.recommendation?.level === "fail" || (num(r?.successRate) !== null && num(r.successRate) < SUCCESS_MIN),
    );
    reason = bad ? "批量稳定性存在不推荐/低成功率渠道" : null;
  } else {
    reason = riskReasonSingle(result, type);
  }
  push(result.reportHtmlPath, result.model || result.profileName || "", reason);
  return out;
}

// —— 未读集合持久化（原子写 + 串行写链）——
const MAX_ALERTS = 200; // 上限，超出丢最旧，避免无限增长
let alertsFile = HIGH_RISK_ALERTS_FILE;
let writeChain = Promise.resolve();

async function loadAll() {
  try {
    if (!existsSync(alertsFile)) return [];
    const raw = JSON.parse((await readFile(alertsFile, "utf8")) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
// 串行化读改写：load → mutator(原地改数组) → 原子写。与端点 ack 共用一条链，绝不互相覆盖。
function update(mutator) {
  const runOnce = async () => {
    const alerts = await loadAll();
    const value = await mutator(alerts);
    await writeJsonAtomic(alertsFile, alerts);
    return value;
  };
  const next = writeChain.then(runOnce, runOnce);
  writeChain = next.then(
    () => {},
    () => {},
  );
  return next;
}

// 未读列表（新→旧；内部按加入顺序 push 到尾）。
export async function listAlerts() {
  const all = await loadAll();
  return [...all].reverse();
}

// 并入新高危报告（按 reportId 去重，超上限丢最旧）。
export async function addAlerts(items) {
  if (!Array.isArray(items) || !items.length) return;
  await update((alerts) => {
    const seen = new Set(alerts.map((a) => a.reportId));
    for (const it of items) {
      if (!it?.reportId || seen.has(it.reportId)) continue;
      seen.add(it.reportId);
      alerts.push({
        reportId: it.reportId,
        testType: it.testType || "",
        label: it.label || "报告",
        reason: it.reason || "",
        createdAt: new Date().toISOString(),
      });
    }
    if (alerts.length > MAX_ALERTS) alerts.splice(0, alerts.length - MAX_ALERTS);
    return null;
  });
}

export async function ackAlert(reportId) {
  const key = String(reportId || "");
  if (!key) return;
  await update((alerts) => {
    const i = alerts.findIndex((a) => a.reportId === key);
    if (i >= 0) alerts.splice(i, 1);
    return null;
  });
}

export async function ackAll() {
  await update((alerts) => {
    alerts.length = 0;
    return null;
  });
}

// 运行完成钩子：仅当设置开启时判危记录。best-effort，绝不影响测试主流程。
export async function noteRunIfEnabled(result) {
  try {
    if (!getSettings().enableHighRiskAlert) return;
    const items = collectHighRiskReports(result);
    if (items.length) await addAlerts(items);
  } catch {
    /* 记录失败不影响测试与调度 */
  }
}

// —— 测试钩子 ——
export function __setHighRiskFileForTest(file) {
  alertsFile = file || HIGH_RISK_ALERTS_FILE;
}
export function __resetHighRiskWriteChainForTest() {
  writeChain = Promise.resolve();
}
