// server/regression.mjs
//
// 基线 + 回归告警 + 趋势序列。
// 思路：同一渠道(profile)同一类型(type)的历次 run 已落 test_runs；取历史中位数当"基线",
//   新一次 run 与基线比——成功率明显下跌 / P95 明显变差 / 准入等级下滑 → 判"疑似退化"并告警。
//   纯函数，便于测试；判定保持克制（"疑似退化，建议复核"，非铁证）。

import { percentile } from "./utils.mjs";

// 判「确实报出了数值」：null/undefined/"" 都算没报出，0 与 0% 是真实数值。
// 【为什么全文只有这一个数值判别】曾经并存一个 isNum = Number.isFinite(Number(v))，
// 而 Number(null)===0、Number("")===0 都是有限值 —— 于是「没报出来」被当成「报出了 0」。
// 它造成过三种真实故障（见 tests/regression.test.mjs 末尾三个回归用例）：
//   ① 跑了 0 条记录的空运行（test-runner.mjs:229 显式写 successRate: null）被读成 0%，
//      对着 100% 的基线误报「↓100pp，明显退化，high」，且专为此加的 incomparable 兜底
//      被假 0 绕过（hasComparableMetric 看到 0 认为报出了指标）；
//   ② 全失败运行的 p95TotalMs 本是 null（无成功请求可统计），被读成 0ms —— 全挂的一次
//      在趋势图上显示为「延迟 0ms」，即最快的一次；
//   ③ median 的过滤同样漏 null，null 占多数时 P95 基线中位数变成 0，
//      于后续 `baseline.p95Ms > 0` 不成立 → P95 维静默，×4 的真实劣化判成 stable（假阴性）。
const hasNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

// 该趋势点是否报出了至少一个可与基线比对的指标。两处共用：
//   detectRegression 用它拦「无指标却判 stable」的虚假保证；
//   trend-service 用它挑「最近一个可判定的点」，避免无指标的运行挤掉既有结论。
export function hasComparableMetric(point) {
  return hasNum(point?.successRate) || hasNum(point?.p95Ms) || Boolean(point?.grade);
}

// 场景测试的「基础」分组名（= DEFAULT_SCENARIO_GROUPS[0]，见 server/settings-store.mjs）。
export const BASIC_SCENARIO_GROUP = "基础";

// 从若干运行 summary 里，挑出 type==="scenario" 且其 scenarios[] 属于目标分组的 case id 集合。
// 返回 Map(runId -> Set(caseId))；无该分组场景 / 无 scenarios 的运行不入表（非场景运行忽略）。
export function collectBasicScenarioCaseIds(summaries, group = BASIC_SCENARIO_GROUP) {
  const out = new Map();
  for (const s of summaries || []) {
    if (!s || s.type !== "scenario" || !Array.isArray(s.scenarios) || !s.runId) continue;
    const ids = s.scenarios.filter((sc) => sc && sc.group === group && sc.id).map((sc) => sc.id);
    if (ids.length) out.set(s.runId, new Set(ids));
  }
  return out;
}

// 逐轮明细 → { successRate, p95Ms }。空集合 → { successRate: null, p95Ms: null }。
// 复用 server/utils.mjs 的 percentile(values, ratio)。round 形状：{ totalMs, success }。
export function summarizeRoundStats(rounds) {
  const rs = (rounds || []).filter((r) => r && r.totalMs != null && Number.isFinite(Number(r.totalMs)));
  if (!rs.length) return { successRate: null, p95Ms: null };
  const ok = rs.filter((r) => r.success).length;
  return {
    successRate: ok / rs.length,
    p95Ms: percentile(
      rs.map((r) => Number(r.totalMs)),
      0.95,
    ),
  };
}

function median(values) {
  const a = (values || [])
    .filter(hasNum)
    .map(Number)
    .sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// 准入等级由好到坏（X=稳定性崩，F=最差）。
const GRADE_ORDER = ["A", "B", "C", "D", "E", "X", "F"];

// 阈值（克制，避免噪声误报）
const SR_DROP = 0.1; // 成功率绝对下跌 ≥ 10 个百分点
const P95_WORSEN = 1.5; // P95 恶化 ≥ 1.5×
const GRADE_DROP = 2; // 准入等级下滑 ≥ 2 档

// 把一次 run 的 summary 提成趋势点（图表/基线只需这几个量）。
export function toTrendPoint(summary = {}) {
  // 快检(quick-verify)历史上只记了 successCount/requestCount、没记 successRate，会被趋势与回归漏掉
  // （明明常失败却不进成功率曲线）。这里为它按成败比补出成功率，让既有的快检运行也追溯地进图/进告警。
  const successRate = hasNum(summary.successRate)
    ? Number(summary.successRate)
    : summary.type === "quick-verify" && hasNum(summary.successCount) && hasNum(summary.requestCount) && Number(summary.requestCount) > 0
      ? Number(summary.successCount) / Number(summary.requestCount)
      : null;
  return {
    runId: summary.runId || null,
    type: summary.type || "",
    at: summary.endedAt || summary.startedAt || null,
    successRate,
    p95Ms: hasNum(summary.p95TotalMs) ? Number(summary.p95TotalMs) : null,
    score: hasNum(summary.score) ? Number(summary.score) : null,
    grade: summary.grade || null,
    totalTokens: summary.actualConsumption?.totalTokens ?? null,
    cost: summary.actualConsumption?.estimatedCost ?? null,
  };
}

export function buildTrendSeries(summaries = []) {
  return (summaries || []).map(toTrendPoint).filter((p) => p.at);
}

// 基线 = 同类历史的中位数（需 ≥2 个同类样本）。
export function buildBaseline(history, { type } = {}) {
  const pts = (history || []).filter((p) => (type ? p.type === type : true) && p.successRate !== null);
  if (pts.length < 2) return { n: pts.length, successRate: null, p95Ms: null, insufficient: true };
  return {
    n: pts.length,
    successRate: median(pts.map((p) => p.successRate)),
    p95Ms: median(pts.map((p) => p.p95Ms)),
    insufficient: false,
  };
}

// 当前 run vs 基线 → 退化判定。current 可传 summary 或 trendPoint；history 传趋势点数组。
export function detectRegression({ current, history = [] } = {}) {
  const cur = current && current.successRate !== undefined && current.at !== undefined ? current : toTrendPoint(current || {});
  const prior = (history || []).filter((p) => p.runId !== cur.runId);
  const baseline = buildBaseline(prior, { type: cur.type });

  if (baseline.insufficient) {
    return {
      status: prior.filter((p) => p.type === cur.type).length === 0 ? "baseline" : "insufficient",
      severity: "none",
      baseline,
      changes: [],
      verdict:
        prior.filter((p) => p.type === cur.type).length === 0
          ? "首次记录，已建立趋势基线。"
          : "同类历史样本不足（需 ≥2 次），暂不判定回归。",
    };
  }

  // 本次运行一个可比指标都没报出来（成功率/P95/等级全缺）时，绝不能落到下面的
  // 「changes 为空 → stable」——那会把「无从判断」说成「与基线一致，未见退化」，是虚假保证。
  // 触发场景：场景运行只跑了非「基础」组，trend-service 无逐轮可回填 → 该点两个指标皆 null。
  if (!hasComparableMetric(cur)) {
    return {
      status: "incomparable",
      severity: "none",
      baseline,
      changes: [],
      verdict: "本次运行未报出可比指标（成功率 / P95 / 等级），无法与基线比对。",
    };
  }

  const changes = [];
  if (cur.successRate !== null && baseline.successRate !== null) {
    const drop = baseline.successRate - cur.successRate;
    if (drop >= SR_DROP) {
      changes.push({
        metric: "success_rate",
        severity: drop >= 0.25 ? "high" : "medium",
        detail: `成功率从基线 ${Math.round(baseline.successRate * 100)}% 跌到 ${Math.round(cur.successRate * 100)}%（↓${Math.round(drop * 100)}pp）`,
      });
    }
  }
  if (hasNum(cur.p95Ms) && hasNum(baseline.p95Ms) && baseline.p95Ms > 0 && cur.p95Ms >= baseline.p95Ms * P95_WORSEN) {
    changes.push({
      metric: "p95",
      severity: cur.p95Ms >= baseline.p95Ms * 2 ? "high" : "medium",
      detail: `P95 从基线 ${Math.round(baseline.p95Ms)}ms 升到 ${Math.round(cur.p95Ms)}ms（×${(cur.p95Ms / baseline.p95Ms).toFixed(2)}）`,
    });
  }
  if (cur.grade) {
    const priorGradeIdx = prior
      .filter((p) => p.grade)
      .map((p) => GRADE_ORDER.indexOf(p.grade))
      .filter((i) => i >= 0);
    if (priorGradeIdx.length) {
      const bestPrior = Math.min(...priorGradeIdx);
      const curIdx = GRADE_ORDER.indexOf(cur.grade);
      if (curIdx >= 0 && curIdx - bestPrior >= GRADE_DROP) {
        changes.push({
          metric: "grade",
          severity: "high",
          detail: `准入等级从历史最好 ${GRADE_ORDER[bestPrior]} 跌到 ${cur.grade}`,
        });
      }
    }
  }

  const regressed = changes.length > 0;
  return {
    status: regressed ? "regressed" : "stable",
    severity: changes.some((c) => c.severity === "high") ? "high" : regressed ? "medium" : "none",
    baseline,
    changes,
    verdict: regressed ? "⚠️ 相比基线明显退化，建议复核 / 要求上游解释（非铁证）。" : "与基线一致，未见明显退化。",
  };
}
