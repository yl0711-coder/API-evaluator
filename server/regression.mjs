// server/regression.mjs
//
// 基线 + 回归告警 + 趋势序列。
// 思路：同一渠道(profile)同一类型(type)的历次 run 已落 test_runs；取历史中位数当"基线",
//   新一次 run 与基线比——成功率明显下跌 / P95 明显变差 / 准入等级下滑 → 判"疑似退化"并告警。
//   纯函数，便于测试；判定保持克制（"疑似退化，建议复核"，非铁证）。

const isNum = (v) => Number.isFinite(Number(v));

function median(values) {
  const a = (values || []).filter(isNum).map(Number).sort((x, y) => x - y);
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
  return {
    runId: summary.runId || null,
    type: summary.type || "",
    at: summary.endedAt || summary.startedAt || null,
    successRate: isNum(summary.successRate) ? Number(summary.successRate) : null,
    p95Ms: isNum(summary.p95TotalMs) ? Number(summary.p95TotalMs) : null,
    score: isNum(summary.score) ? Number(summary.score) : null,
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
  if (isNum(cur.p95Ms) && isNum(baseline.p95Ms) && baseline.p95Ms > 0 && cur.p95Ms >= baseline.p95Ms * P95_WORSEN) {
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
