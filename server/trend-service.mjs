// server/trend-service.mjs
// 组装单个 profile（渠道·模型）的稳定性趋势：series（含「基础」场景成功率回填）+ 基线回归 +
// 逐轮 rounds（稳定性运行全轮 + 基础场景运行仅基础轮，融合、按时间升序）。
// 供 /api/trend 端点与「自动测试巡检报告」共用，避免两处拼装逻辑漂移。
import { queryProfileRunSummaries, queryRoundSeriesByRunIds } from "./db.mjs";
import { buildTrendSeries, collectBasicScenarioCaseIds, detectRegression, summarizeRoundStats } from "./regression.mjs";

export async function buildProfileTrend(profileId, { limit = 200 } = {}) {
  const history = await queryProfileRunSummaries(profileId, { limit });
  const series = buildTrendSeries(history);
  // 稳定性类点：非场景、且有成功率（现有语义）。
  const stabilityRateByRun = new Map(
    series.filter((p) => p.runId && p.type !== "scenario" && p.successRate !== null).map((p) => [p.runId, p.successRate]),
  );
  // 基础场景运行 → 其「基础」组 case id 集合。
  const basicIdsByRun = collectBasicScenarioCaseIds(history);
  // 一次查询取回两类运行的逐轮明细（含 caseId）。
  const allRunIds = [...new Set([...stabilityRateByRun.keys(), ...basicIdsByRun.keys()])];
  const rawRounds = allRunIds.length ? await queryRoundSeriesByRunIds(allRunIds) : [];
  // 基础场景轮次：按 case 过滤到「基础」组并分运行归拢，现算成功率/P95 回填 series 点。
  const basicRoundsByRun = new Map();
  for (const r of rawRounds) {
    const ids = basicIdsByRun.get(r.runId);
    if (ids && r.caseId && ids.has(r.caseId)) {
      if (!basicRoundsByRun.has(r.runId)) basicRoundsByRun.set(r.runId, []);
      basicRoundsByRun.get(r.runId).push(r);
    }
  }
  const basicRateByRun = new Map();
  for (const [runId, rs] of basicRoundsByRun) {
    const { successRate, p95Ms } = summarizeRoundStats(rs);
    basicRateByRun.set(runId, successRate);
    const pt = series.find((p) => p.runId === runId);
    if (pt) {
      pt.successRate = successRate;
      pt.p95Ms = p95Ms;
    }
  }
  // 回归判定：此刻 series 里的基础场景点已带 successRate（按 type 分组自成基线，不碰稳定性）。
  const latest = series[series.length - 1] || null;
  const regression = latest ? detectRegression({ current: latest, history: series }) : null;
  // 图表逐轮数据：稳定性运行（全轮）+ 基础场景运行（仅基础轮），融合、按时间排序。
  const rounds = [];
  for (const r of rawRounds) {
    if (!r.startedAt) continue;
    const base = { at: r.startedAt, ms: r.totalMs, ok: r.success, err: r.normalizedError || "" };
    if (basicIdsByRun.has(r.runId)) {
      const ids = basicIdsByRun.get(r.runId);
      if (!(r.caseId && ids.has(r.caseId))) continue; // 丢弃非基础组的场景轮次
      rounds.push({ ...base, runRate: basicRateByRun.get(r.runId) ?? null });
    } else if (stabilityRateByRun.has(r.runId)) {
      rounds.push({ ...base, runRate: stabilityRateByRun.get(r.runId) ?? null });
    }
  }
  rounds.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { series, rounds, regression };
}
