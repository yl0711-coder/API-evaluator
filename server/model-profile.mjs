// server/model-profile.mjs
// 「模型档案」页的数据装配（纯函数，无 IO）。
//
// 与 report-compare.mjs 的关系：那边是「两个对象相互比较」，本页是「一个对象的自我画像」。
// 画像的**当前值**全部来自 aggregateSubject()（复用，不另写一套口径），
// 本模块只做它给不了的三件事：
//   1. buildUptimeDays      —— 趋势序列 → 按天可用性（90 天条带用）
//   2. buildMetricHistories —— 趋势序列 → 每个指标各自的历史数组（sparkline 用）
//   3. buildModelProfileView—— 汇总成给浏览器的稳定契约
//
// buildModelProfileView 的定位与 buildComparisonView 相同：**刻意与报告内部结构解耦**，
// 前端消费一个有意设计过的契约，而不是报告解析的内部形状。
import { simpleKnee } from "./report-compare.mjs";

// 硬门槛三项（server/admission-policy.mjs 的 HARD_GATE_CASE_IDS）在**报告 markdown 里是中文测试项名**，
// 因为 aggregateSubject().admission.items 是从「## 4. 分项结果」表格反解析出来的，键为中文名。
// 中文名的出处是 server/test-runner.mjs 的用例定义（:595 结构化输出 / :614 工具调用结构 / :619 流式响应结构）。
//
// 映射放在服务端而不是前端：报告文案若改动，只需改这一处，不必去前端找散落的中文字面量。
const HARD_GATE_ITEM_NAMES = {
  json: ["结构化输出"],
  tool: ["工具调用结构"],
  stream: ["流式响应结构"],
};

// 报告表格里「结果」列的取值（server/reporting.mjs:770 只写「通过」/「未通过」）。
// 用三态而非布尔：没跑过的项必须是 null（「这次没测」），不能当成失败——
// 与 admission-policy.mjs 里 resolveItemStatus 的三态语义一致。
function resolveGateFromItems(items, names) {
  if (!items || typeof items !== "object") return null;
  for (const name of names) {
    const raw = items[name];
    if (typeof raw !== "string" || !raw.trim()) continue;
    return /通过/.test(raw) && !/未通过|不通过/.test(raw);
  }
  return null;
}

const DAY_MS = 86_400_000;

// 本地日期键（YYYY-MM-DD）。刻意用本地时区而非 UTC：条带是给运营者看「哪天出问题」的，
// 北京时间凌晨 1 点的失败属于当天，用 UTC 会归到前一天，与用户的心智对不上。
function localDateKey(ms) {
  const d = new Date(ms);
  const p2 = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * 趋势序列 → 按天可用性数组（供 shared/uptime-strip.mjs 渲染）。
 *
 * @param {Array<{at:string, successRate:number|null, type?:string}>} series buildProfileTrend 的 series
 * @param {object} [opts]
 * @param {number} [opts.days=90] 窗口天数
 * @param {number} [opts.now=Date.now()] 窗口右端（测试可注入）
 * @returns {Array<{date:string, successRate:number|null, rounds:number}>} 时间升序，长度恒为 days
 *
 * 关键：**每一天都出现在结果里**，没测过的天 rounds=0 / successRate=null。
 * 不能只返回有数据的天——条带靠固定长度表达「时间轴」，缺天会让 90 天悄悄缩成 55 天，
 * 用户会以为这个渠道天天都测。
 */
export function buildUptimeDays(series, { days = 90, now = Date.now() } = {}) {
  const bucket = new Map(); // dateKey -> { succ, total }
  for (const point of series || []) {
    const t = Date.parse(point?.at);
    if (!Number.isFinite(t)) continue;
    if (!Number.isFinite(point?.successRate)) continue;
    // 窗口外的点直接丢（含未来时间：时钟回拨/脏数据不该把条带撑歪）
    if (t > now || t < now - days * DAY_MS) continue;
    const key = localDateKey(t);
    let b = bucket.get(key);
    if (!b) {
      b = { succ: 0, total: 0 };
      bucket.set(key, b);
    }
    // series 点没带轮数（toTrendPoint 不出 sampleSize），按「一个运行算一轮」加权。
    // 这让同一天跑了 3 次的日子比只跑 1 次的更有分量，虽然不如真实轮数精确。
    b.succ += point.successRate;
    b.total += 1;
  }

  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = localDateKey(now - i * DAY_MS);
    const b = bucket.get(key);
    out.push(
      b && b.total > 0 ? { date: key, successRate: b.succ / b.total, rounds: b.total } : { date: key, successRate: null, rounds: 0 },
    );
  }
  return out;
}

/**
 * 趋势序列 → 每个指标各自的历史数组（供 shared/sparkline.mjs 渲染）。
 *
 * 能力边界（已核对 server/regression.mjs:61 的 toTrendPoint）：它产出的字段只有
 *   { runId, type, at, successRate, p95Ms, score, grade, totalTokens, cost }
 * 所以**平均质量分（avgQualityScore）与 P50 首 Token 拿不到历史**——两者确实存在于
 * buildScenarioProfileSummary 且已落进 test_runs.raw_json（slimSummaryForStorage 不剥标量），
 * 只是没被 toTrendPoint 提取。补它要改回归判定的共享输入（detectRegression / buildBaseline /
 * 告警链路都吃这个函数），该单独一轮做，不夹在本页里顺手改。
 *
 * 因此这两个指标返回 null + noHistoryReason，前端如实显示「无历史曲线」而不是画一条假的。
 *
 * @param {Array} series buildProfileTrend 的 series
 * @returns {Record<string, {values: number[]|null, reason?: string}>}
 */
export function buildMetricHistories(series) {
  const points = (series || []).filter((p) => p && p.at);
  // 稳定性类点的口径与 buildProfileTrend 内部一致：非 scenario 且有成功率。
  const stabilityPoints = points.filter((p) => p.type !== "scenario" && Number.isFinite(p.successRate));
  const scenarioPoints = points.filter((p) => p.type === "scenario" && Number.isFinite(p.successRate));
  const admissionPoints = points.filter((p) => p.type === "admission" && Number.isFinite(p.score));

  // 累计花费：逐点累加成单调递增序列（cost 是每次运行的花费，不是累计值）。
  let acc = 0;
  const spend = [];
  for (const p of points) {
    if (Number.isFinite(p.cost)) {
      acc += p.cost;
      spend.push(Number(acc.toFixed(6)));
    }
  }

  // 空数组统一收敛成 null + 原因，前端只需判 null 就知道该画占位而不是空图。
  // 「没有历史」和「历史是平的」在评测工具里差别很大，不能画成同一个样子。
  const orNull = (values, reason) => (values.length ? { values } : { values: null, reason });

  return {
    "stability-rate": orNull(
      stabilityPoints.map((p) => p.successRate),
      "还没有稳定性 / 快检测试记录",
    ),
    // 已知能力边界：场景运行在 test_runs 里 profile_id 为 NULL（buildScenarioSummary 顶层
    // 不带 profileId，profileId 只在 results[]/profileDigest[] 里），而 queryProfileRunSummaries
    // 按 profile_id 过滤 —— 所以场景运行进不了趋势序列，这条曲线实际上恒为空。
    // 当前值不受影响（走 aggregateSubject 读报告文件名，与 DB 无关）。
    // 这是既有缺陷，不在本页修（涉及回归判定与告警的共享输入）。
    "scenario-pass": orNull(
      scenarioPoints.map((p) => p.successRate),
      "场景运行未按模型入库，历史曲线暂不可用",
    ),
    "p95-latency": orNull(
      stabilityPoints.filter((p) => Number.isFinite(p.p95Ms)).map((p) => p.p95Ms),
      "还没有带耗时统计的测试记录",
    ),
    "admission-score": orNull(
      admissionPoints.map((p) => p.score),
      "还没有准入评测记录",
    ),
    spend: orNull(spend, "历史记录里没有金额（未配置单价）"),
    quality: { values: null, reason: "趋势序列未记录场景质量分" },
    "first-token": { values: null, reason: "趋势序列未记录首 Token 延迟" },
    load: { values: null, reason: "压测只取最新一份，不跨报告池化" },
  };
}

// 压测拐点 → 推荐容量（有效 QPS = 拐点处 QPS × 成功率）。
// 与 report-compare.mjs 的 comparisonViewGoodput 同口径（那边是私有函数，这里复用 simpleKnee 重算）。
function buildLoadKnee(loadPoints) {
  const { point } = simpleKnee(loadPoints || []);
  if (!point) return null;
  const goodput = Number.isFinite(point.qps) && Number.isFinite(point.successRate) ? point.qps * point.successRate : null;
  return {
    qps: Number.isFinite(point.qps) ? point.qps : null,
    successRate: Number.isFinite(point.successRate) ? point.successRate : null,
    concurrency: Number.isFinite(point.offered) ? point.offered : null,
    goodput,
  };
}

// 逐场景 P50 首 Token 的中位数。aggregateSubject 只在 scenarios[] 上给逐场景的 p50FirstTokenMs，
// 没有汇总值。取中位数而非均值：延迟分布长尾，均值会被个别慢场景拉偏。
function summarizeFirstToken(scenarios) {
  const values = (scenarios || [])
    .map((s) => s?.p50FirstTokenMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!values.length) return { p50Ms: null, scenarioCount: 0 };
  // nearest-rank，与 report-compare.mjs 的 nearestRankPct 同法
  return { p50Ms: values[Math.min(values.length - 1, Math.floor(values.length * 0.5))], scenarioCount: values.length };
}

/**
 * 浏览器契约：单模型档案视图。
 *
 * 与 buildComparisonView 同一定位——前端消费这个**有意设计过的稳定结构**，
 * 而不是 aggregateSubject / buildProfileTrend 的内部形状。报告解析改动时，
 * 前端不必跟着改。
 *
 * 刻意【不】在这里合成任何新结论：等级/综合分直接来自最近一份准入报告，
 * 硬门槛逐项如实给三态。聚合判定归服务端 aggregateSuite 独有（与任务中心同规矩）。
 *
 * @param {object} args
 * @param {object} args.agg    aggregateSubject() 的结果
 * @param {object} args.trend  buildProfileTrend() 的结果 { series, rounds, regression }
 * @param {Array}  [args.alerts] queryRegressionAlerts() 的结果
 * @param {object} args.target { id, channel, model, protocol, channelStatus, lastTestedAt }
 * @param {object} [opts] { now, uptimeDays }
 */
export function buildModelProfileView({ agg, trend, alerts = [], target = {} }, { now = Date.now(), uptimeDays = 90 } = {}) {
  const series = trend?.series || [];
  const stability = agg?.stability || null;
  const firstToken = summarizeFirstToken(agg?.scenarios);
  const loadKnee = buildLoadKnee(agg?.loadPoints);
  const histories = buildMetricHistories(series);

  const admission = agg?.admission
    ? {
        grade: agg.admission.grade ?? null,
        composite: Number.isFinite(agg.admission.composite) ? agg.admission.composite : null,
        conclusion: agg.admission.conclusion ?? null,
        // 硬门槛三态：true 通过 / false 未通过 / null 本次没测。
        // A 级除分数外还硬要求这三项全过（评分标准里容易漏看的门槛），前端要能如实显示。
        hardGates: {
          json: resolveGateFromItems(agg.admission.items, HARD_GATE_ITEM_NAMES.json),
          tool: resolveGateFromItems(agg.admission.items, HARD_GATE_ITEM_NAMES.tool),
          stream: resolveGateFromItems(agg.admission.items, HARD_GATE_ITEM_NAMES.stream),
        },
        nominalFamily: agg.admission.nominalFamily ?? null,
        selfFamily: agg.admission.selfFamily ?? null,
        crossChannelMismatch: Boolean(agg.admission.crossChannelMismatch),
        purityScore: Number.isFinite(agg.admission.purityScore) ? agg.admission.purityScore : null,
      }
    : null;

  return {
    target: {
      id: target.id ?? null,
      channel: target.channel ?? agg?.channel ?? null,
      model: target.model ?? agg?.model ?? null,
      label: agg?.label || [target.channel, target.model].filter(Boolean).join(" / ") || "未知对象",
      protocol: target.protocol ?? null,
      channelStatus: target.channelStatus ?? null,
      lastTestedAt: target.lastTestedAt ?? null,
    },
    reportCounts: agg?.reportCounts || { run: 0, scenario: 0, admission: 0, load: 0, total: 0 },
    // 报告收集有限流（server.mjs 的 collectSubjectReportFiles：run/admission 各取最近 6 份、
    // 场景最多 60 份）。这个口径必须传到前端并显示出来，否则用户会把「最近 6 份的池化值」
    // 当成全部历史。
    coverage: { runReportLimit: 6, admissionReportLimit: 6, loadReportLimit: 6, scenarioFileLimit: 60 },
    stability: stability
      ? {
          succ: stability.succ,
          total: stability.total,
          rate: stability.rate,
          avgTotalMs: stability.avgTotalMs,
          p50TotalMs: stability.p50TotalMs,
          p95TotalMs: stability.p95TotalMs,
          p99TotalMs: stability.p99TotalMs,
          roundsTotal: stability.roundsTotal,
        }
      : null,
    scenarioPass: agg?.scenarioPass || null,
    quality: agg?.quality || null,
    firstToken,
    loadKnee,
    admission,
    integrity: agg?.integrity || null,
    tokens: agg?.tokens || null,
    tiers: agg?.tiers || [],
    // 逐场景：只给页面用得到的字段，别把 firstTokenSamples 这种原始样本数组发给浏览器
    // （一个场景可能几十个样本，全发是白费带宽）。
    scenarios: (agg?.scenarios || []).map((s) => ({
      name: s.name,
      tier: s.tier ?? null,
      quality: Number.isFinite(s.quality) ? s.quality : null,
      rate: Number.isFinite(s.rate) ? s.rate : null,
      succ: s.succ ?? null,
      total: s.total ?? null,
      avgMs: Number.isFinite(s.avgMs) ? s.avgMs : null,
      p50FirstTokenMs: Number.isFinite(s.p50FirstTokenMs) ? s.p50FirstTokenMs : null,
      outputTokens: Number.isFinite(s.outputTokens) ? s.outputTokens : null,
      issue: s.issue || "",
      errored: Boolean(s.errored),
    })),
    histories,
    uptime: buildUptimeDays(series, { days: uptimeDays, now }),
    trend: {
      rounds: trend?.rounds || [],
      series: series.map((p) => ({
        at: p.at,
        type: p.type,
        successRate: p.successRate,
        p95Ms: p.p95Ms,
        grade: p.grade ?? null,
        cost: p.cost ?? null,
      })),
      regression: trend?.regression || null,
    },
    alerts: (alerts || []).map((a) => ({
      created_at: a.created_at ?? null,
      severity: a.severity ?? null,
      summary: a.summary ?? null,
    })),
  };
}
