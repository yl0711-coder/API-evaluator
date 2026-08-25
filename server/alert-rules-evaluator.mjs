// server/alert-rules-evaluator.mjs
// 报警规则评估：运行完成后（onRunComplete 钩子），把结果归一化成逐目标指标条目，
// 对每条启用规则做范围匹配 + 阈值比较 + 冷却检查，命中则发邮件。
// best-effort：全程 try/catch 吞错，绝不影响测试/调度主流程（与 high-risk-store 的 noteRunIfEnabled 同惯例）。
import { getRules, LEVEL_METRICS, JITTER_KIND, DECLINE_KIND, MIN_BASELINE_SAMPLES } from "./alert-rules-store.mjs";
import { getLastFiredAt, markFired } from "./alert-rule-state.mjs";
import { getNotifyConfig } from "./notify-config.mjs";
import { readSecret } from "./secret-store.mjs";
import { sendMail } from "./mailer.mjs";
import { queryProfileRunSummaries } from "./db.mjs";
import { percentile } from "./utils.mjs";
import { loadDigestConfig, enqueueAlert, enqueueRun, jobInDigestScope } from "./alert-digest-store.mjs";

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

// 取数值，「没报出来」一律落 null。
// null/undefined/"" 必须先挡掉再转数：Number(null) 和 Number("") 都是 0（有限数），
// 只用 Number.isFinite(Number(v)) 会把「缺测」当成「真实测到 0」——
// 于是 firstAttemptSuccessRate: null（历史数据无 attempts）会被读成 0% 首次成功率并触发报警，
// successRate: null 同理会被读成 0% 而误报。这是 regression.mjs 里 hasNum 防的同一个坑。
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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
  const p50 = num(item.p50TotalMs);
  const p95 = num(item.p95TotalMs);
  return {
    successRate: num(item.successRate),
    p95TotalMs: p95,
    avgTotalMs: num(item.avgTotalMs),
    score: num(item.score),
    grade: item.grade || null,
    avgQualityScore: num(item.avgQualityScore),
    recommendationLevel: item.recommendation?.level || null,
    verdictLevel: item.verdict?.level || null,
    // —— 稳定性抖动用的派生量（仅稳定性/批量稳定性汇总里有齐这些字段）——
    p50TotalMs: p50,
    // 尾部延迟离散度：P95÷P50。p50 必须 > 0 才算得出（除以 0 会得 Infinity，
    // 那会让任何阈值都判越界 —— 属于凭空报警）。算不出就是 null，按「该项不检查」处理。
    latencyJitterRatio: p50 !== null && p50 > 0 && p95 !== null ? p95 / p50 : null,
    // 首次成功率（不含重试兜底）。successRate 会被重试洗成 1.0，这个字段才看得见真实抖动。
    firstAttemptSuccessRate: num(item.firstAttemptSuccessRate),
    // 重试额外等待（端到端 P95 − 单次 P95）。历史数据无 endToEndMs 时汇总层给 null。
    retryOverheadP95Ms: num(item.retryOverheadP95Ms),
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

// 两种稳定性复合规则（抖动 / 退化）都只在稳定性类运行上评估。
// p50TotalMs / retryOverheadP95Ms 本就只有稳定性汇总才产出，但 firstAttemptSuccessRate 准入也有——
// 不门禁的话，名为「稳定性…」的规则会在准入运行上悄悄触发，违反直觉且难以解释。
// 门禁让这两条规则的生效边界与它们的名字一致。
const STABILITY_TYPES = new Set(["stability", "batch-stability"]);

// 逐项比较已配置的子阈值，返回越界项的中文描述数组。空数组 = 不命中。
// 未配置（null）或指标算不出（null）的项一律跳过，不误报——与 threshold 形态「指标缺失视为不满足」同口径。
function jitterBreaches(rule, metrics) {
  const p = rule.params || {};
  const out = [];
  const { jitterRatioMax, firstAttemptSuccessRateMin, retryOverheadP95MsMax } = p;

  if (Number.isFinite(jitterRatioMax) && metrics.latencyJitterRatio !== null && metrics.latencyJitterRatio > jitterRatioMax) {
    out.push(
      `耗时抖动 ${metrics.latencyJitterRatio.toFixed(2)}×（P95 ${Math.round(metrics.p95TotalMs)}ms ÷ P50 ${Math.round(metrics.p50TotalMs)}ms），阈值 ${jitterRatioMax}×`,
    );
  }
  if (
    Number.isFinite(firstAttemptSuccessRateMin) &&
    metrics.firstAttemptSuccessRate !== null &&
    metrics.firstAttemptSuccessRate < firstAttemptSuccessRateMin
  ) {
    out.push(
      `首次成功率 ${Math.round(metrics.firstAttemptSuccessRate * 100)}%（不含重试兜底），阈值 ${Math.round(firstAttemptSuccessRateMin * 100)}%`,
    );
  }
  if (Number.isFinite(retryOverheadP95MsMax) && metrics.retryOverheadP95Ms !== null && metrics.retryOverheadP95Ms > retryOverheadP95MsMax) {
    out.push(`重试额外等待 P95 ${Math.round(metrics.retryOverheadP95Ms)}ms，阈值 ${retryOverheadP95MsMax}ms`);
  }
  return out;
}

// 复合规则的邮件正文：一封信列出全部越界项，而不是每项发一封。jitter / decline 共用。
function describeCompositeHit(rule, entry, breaches) {
  const who = entry.model || entry.profileName || entry.targetId;
  return [`规则「${rule.name}」判定不合格：${who}`, ...breaches.map((b) => `  · ${b}`)].join("\n");
}

// —— 稳定性退化：与自身历史比 ——
// 基线样本下限 MIN_BASELINE_SAMPLES 从 store 导入（那里同时是 baselineRuns 的钳制下界）。
// 低于此值不判定：3 个样本的中位数抗不住离群，冷启动阶段会乱报。
// 刻意不做成用户旋钮——这是统计有效性下限，不是口味问题。

// 历史行 → 退化判定用的最小趋势点。
//
// 【为什么自己映射而不用 regression.mjs 的 toTrendPoint】历史原因是那边曾用 isNum
// （Number.isFinite(Number(v))），会把 successRate: null 投影成 0 并算出「跌 100pp」误报。
// 该缺陷已在 ad40d28 修掉（那边现在统一用 hasNum），所以这不再是正确性理由。
// 保留自映射的现实理由：本模块只需要 runId/at/successRate/p95Ms 三个量，
// toTrendPoint 还会产出 score/grade/totalTokens/cost 等本模块用不上的字段，
// 且它按趋势页的需要保留 type、丢掉 batchId —— 而 splitWindows 恰恰要靠 batchId 判别运行类型
// （见下方 splitWindows 的注释）。故维持独立映射，缺测一律保持 null。
// at 的口径与 toTrendPoint 保持一致（endedAt 优先，回落 startedAt）。
function declinePoint(summary) {
  return {
    runId: summary.runId || null,
    at: summary.endedAt || summary.startedAt || null,
    successRate: num(summary.successRate),
    p95Ms: num(summary.p95TotalMs),
  };
}

// 历史 raw summaries → { recent, baseline } 两组趋势点。样本不足返回 null（= 不判定，不误报）。
//
// 为什么在 raw summary 上过滤类型、而不是先映射成趋势点：稳定性运行落库时【不带 type 字段】
// （test-runner 的 persistTestRun 只给 admission/batch-stability/scenario 显式加 type），
// 判「是不是稳定性运行」要靠 testTypeOf 的「无 type 且无 batchId」推断；而趋势点（declinePoint）
// 不保留 type/batchId，先映射就失去了判别依据，批量聚合行会被误当成稳定性点混进基线。
//
// 注意：调用方传进来的 history 末尾就是本次运行（persistTestRun 在 runner 内已 await，
// onRunComplete 在其后才触发），所以最近窗口直接取尾部，不能再把 current 拼一次。
export function splitWindows(summaries, { recentRuns, baselineRuns }) {
  const points = (Array.isArray(summaries) ? summaries : [])
    .filter((s) => s && typeof s === "object" && testTypeOf(s) === "stability")
    .map(declinePoint)
    .filter((p) => p.at); // 无时间戳的行不参与（与 buildTrendSeries 同口径）
  if (points.length < recentRuns + MIN_BASELINE_SAMPLES) return null;
  const recent = points.slice(-recentRuns);
  // 基线取「紧邻最近窗口之前」的那一段，不含最近窗口自身。
  const baselineEnd = points.length - recentRuns;
  const baseline = points.slice(Math.max(0, baselineEnd - baselineRuns), baselineEnd);
  if (recent.length < recentRuns || baseline.length < MIN_BASELINE_SAMPLES) return null;
  return { recent, baseline };
}

// 某一维的中位数：只取「确实报出了该指标」的点（num 已挡掉 null/""，真实的 0 保留）。
// 全窗口都没报出该指标 → null，调用方据此跳过该维而非当成 0。
function medianOf(points, key) {
  const vals = points.map((p) => num(p[key])).filter((v) => v !== null);
  if (!vals.length) return null;
  return percentile(vals, 0.5);
}

// 两窗口中位数对比 → 越界项中文描述数组。空数组 = 不命中。
// 未配置（null）或某一维算不出中位数的项一律跳过，与 jitter 同口径。
export function declineBreaches(rule, windows) {
  const { successRateDropPp, p95WorsenRatio } = rule.params || {};
  const out = [];
  // 用实际窗口长度而非配置值：历史不足时 baseline 可能短于 baselineRuns，
  // 邮件里写实际参与比较的次数才不误导。
  const nRecent = windows.recent.length;
  const nBaseline = windows.baseline.length;

  if (Number.isFinite(successRateDropPp)) {
    const recentSr = medianOf(windows.recent, "successRate");
    const baseSr = medianOf(windows.baseline, "successRate");
    if (recentSr !== null && baseSr !== null) {
      const drop = baseSr - recentSr;
      if (drop >= successRateDropPp) {
        out.push(
          `成功率中位数从 ${Math.round(baseSr * 100)}%（前 ${nBaseline} 次）跌到 ${Math.round(recentSr * 100)}%（最近 ${nRecent} 次），↓${Math.round(drop * 100)}pp，阈值 ${Math.round(successRateDropPp * 100)}pp`,
        );
      }
    }
  }
  if (Number.isFinite(p95WorsenRatio)) {
    const recentP95 = medianOf(windows.recent, "p95Ms");
    const baseP95 = medianOf(windows.baseline, "p95Ms");
    // baseP95 必须 > 0：除以 0 得 Infinity，会让任何倍数阈值都判越界——凭空报警。
    if (recentP95 !== null && baseP95 !== null && baseP95 > 0 && recentP95 / baseP95 >= p95WorsenRatio) {
      out.push(
        `P95 中位数从 ${Math.round(baseP95)}ms（前 ${nBaseline} 次）升到 ${Math.round(recentP95)}ms（最近 ${nRecent} 次），×${(recentP95 / baseP95).toFixed(2)}，阈值 ${p95WorsenRatio}×`,
      );
    }
  }
  return out;
}

async function sendAlertMail(rule, entry, reason) {
  const cfg = getNotifyConfig();
  if (!cfg.smtpHost || !cfg.recipients) return; // 未配置 SMTP：静默跳过，不影响主流程
  const smtpPassword = await readSecret(SMTP_PASSWORD_REF);
  const subject = `【API-evaluator 报警】${rule.name}`;
  const body = `${reason}\n\n触发时间：${new Date().toISOString()}`;
  await sendMail({ ...cfg, smtpPassword }, subject, body);
}

// 调度器的运行上下文 → evaluateAlertRules 的 opts。
//
// 【为什么要有这个函数】这段映射原本内联在 server.mjs 的 createAutoTestScheduler 配置里，
// 那是个顶层对象字面量，测试碰不到 —— 实测把它改坏（source 恒为 "auto"）全套 1649 个用例
// 照旧全绿。抽成纯函数才守得住。
//
// trigger:"manual" 表示有人在页面上点了【立即运行】，正在等结果 ——
// 判据是「此刻有没有人在等」，不是「哪个子系统跑的」。攒到几小时后的汇总里对他没有意义，
// 故与手动测试同样处理：立即发信。
export function alertOptionsFromRunContext(ctx) {
  return {
    source: ctx?.trigger === "manual" ? "manual" : "auto",
    jobId: ctx?.jobId || "",
  };
}

// 运行完成钩子：对该次结果的每个目标条目 × 每条启用规则做匹配/阈值/冷却判断，命中则发信。
// best-effort：任何异常吞掉并记日志，绝不向上抛出。
//
// opts.sendAlertMailFn：仅供测试注入假发信函数（模拟 SMTP 故障），默认走真实 sendAlertMail。
// opts.historyProviderFn：仅供测试注入假历史（避免建库），默认走真实 queryProfileRunSummaries。
// 二者与 mailer.mjs 的 opts.transportFactory / auth.mjs 的 opts.fetchImpl 同一惯例。
//
// opts.source："auto" = 定时自动测试，"manual" = 页面上点的手动测试（默认）。
// 只有 auto 才可能走汇总队列：手动测试时人就在屏幕前，攒到几小时后再发没有意义。
// opts.digestConfigFn：仅供测试注入汇总配置，默认走真实 loadDigestConfig。
export async function evaluateAlertRules(result, opts = {}) {
  const sendAlertMailFn = opts.sendAlertMailFn || sendAlertMail;
  const historyProviderFn = opts.historyProviderFn || queryProfileRunSummaries;
  const digestConfigFn = opts.digestConfigFn || loadDigestConfig;
  const enqueueAlertFn = opts.enqueueAlertFn || enqueueAlert;
  const enqueueRunFn = opts.enqueueRunFn || enqueueRun;
  try {
    if (!result || typeof result !== "object") return;
    const entries = collectEntries(result);
    if (!entries.length) return;

    // 汇总模式判定要在「有没有规则」之前做：即使一条规则都没配，本时段跑了什么也该记进队列，
    // 否则汇总信会说「本时段没有完成任何测试」——那是假话，会让人以为作业停了。
    const runType = testTypeOf(result);
    let digestMode = false;
    if (opts.source === "auto") {
      try {
        // 按作业筛选：jobScope="selected" 时只有被勾选的作业走汇总，其余仍命中即发。
        // 不在汇总范围内【不等于】不报警——见 jobInDigestScope 的注释。
        digestMode = jobInDigestScope(await digestConfigFn(), opts.jobId || "");
      } catch (error) {
        // 读配置失败 → 退回立即发信。宁可多发几封，不可静默丢报警。
        console.error("[alert-rules] 读汇总配置失败（本次退回立即发信）：", error?.message || error);
      }
    }
    if (digestMode) {
      for (const entry of entries) {
        try {
          await enqueueRunFn({
            targetId: entry.targetId,
            targetLabel: entry.model || entry.profileName || entry.targetId,
            testType: runType,
            runId: result.runId || "",
            successRate: entry.metrics.successRate,
            p95TotalMs: entry.metrics.p95TotalMs,
            grade: entry.metrics.grade,
          });
        } catch (error) {
          console.error("[alert-rules] 运行记录入队失败：", error?.message || error);
        }
      }
    }

    const rules = (await getRules()).filter((rule) => rule.enabled);
    if (!rules.length) return;
    const isStabilityRun = STABILITY_TYPES.has(runType);

    // 退化规则要查库，这里做两层节流：
    //   ① 懒查——只有「本次是稳定性类运行」且「确实有启用的退化规则」时才查，
    //      纯阈值/抖动规则的用户一次库都不查（行为与加这个功能之前完全一致）；
    //   ② 每 target 只查一次——批量稳定性一次运行可能有 N 个 target × M 条规则，
    //      不缓存会把同一 target 的历史反复全表扫（test_runs 无 profile_id 索引）。
    const needsHistory = isStabilityRun && rules.some((rule) => rule.kind === DECLINE_KIND);
    const historyCache = new Map();
    // 查库失败【只让退化规则本身跳过】，绝不冒泡到主循环。
    // 若让它冒到最外层 try/catch，整个双层循环会被中断，后面所有规则——包括完全不依赖数据库的
    // 阈值规则——都不再被评估；而"哪些规则受影响"取决于退化规则在数组里的位置（创建顺序），
    // 症状随配置而变、几乎无法复现。SQLITE_BUSY 在并发写时很常见，一次抖动不该让不相关的报警集体失声。
    // 失败缓存 null：本次评估内不重复重试（避免 N 个 target × M 条规则把一次故障放大成 N×M 次查询）。
    const historyOf = async (targetId) => {
      if (!historyCache.has(targetId)) {
        try {
          historyCache.set(targetId, await historyProviderFn(targetId));
        } catch (error) {
          console.error("[alert-rules] 取历史失败（退化规则本次跳过）：", error?.message || error);
          historyCache.set(targetId, null);
        }
      }
      return historyCache.get(targetId);
    };

    for (const entry of entries) {
      for (const rule of rules) {
        if (!ruleMatchesScope(rule, entry.targetId)) continue;

        // 三种规则形态各自判定，命中后共用下面的冷却/发信/记账链路。
        let reason = null;
        if (rule.kind === JITTER_KIND) {
          if (!isStabilityRun) continue; // 非稳定性类运行：这条规则不适用，静默跳过
          const breaches = jitterBreaches(rule, entry.metrics);
          if (!breaches.length) continue;
          reason = describeCompositeHit(rule, entry, breaches);
        } else if (rule.kind === DECLINE_KIND) {
          if (!needsHistory) continue; // 同上门禁（needsHistory 已含 isStabilityRun）
          const history = await historyOf(entry.targetId);
          if (history === null) continue; // 查库失败：本条跳过，不影响其它规则
          const windows = splitWindows(history, {
            recentRuns: rule.params?.recentRuns ?? 3,
            baselineRuns: rule.params?.baselineRuns ?? 20,
          });
          if (!windows) continue; // 历史样本不足 → 不判定（冷启动阶段不乱报）
          const breaches = declineBreaches(rule, windows);
          if (!breaches.length) continue;
          reason = describeCompositeHit(rule, entry, breaches);
        } else {
          if (!ruleHits(rule)(entry.metrics)) continue;
          reason = describeHit(rule, entry);
        }

        // 冷却记账的桶。
        //
        // 立即发信模式：scope=all 的规则共用一个桶（"all"）—— 这是有意的降噪，
        //   否则 20 个渠道同时出问题会一次发出 20 封信。
        //
        // 汇总模式：按渠道各算一个桶。理由是这条取舍的前提变了 ——
        //   共用一个桶的收益是「少发邮件」，而汇总模式下无论几个渠道出问题都只发一封，
        //   压掉其余渠道不再节省任何邮件，只会让报警列表和标题【低报故障范围】：
        //   实测 5 个渠道同时挂，报警列表里只出现 1 条、标题写「1 个目标」。
        //   （runs 表仍列出全部 5 个的实测数字，故信息未丢，但读信人先看到的是报警列表。）
        // 两种模式的桶不互通，这是刻意的：切换汇总开关后各自按自己的口径重新计时，
        // 不会出现「立即模式攒的冷却把汇总模式的首条报警压掉」这种跨口径干扰。
        const targetKey = rule.scope?.type === "all" ? (digestMode ? `all::${entry.targetId}` : "all") : entry.targetId;
        const lastFiredAt = await getLastFiredAt(rule.id, targetKey);
        if (lastFiredAt) {
          const elapsedHours = (Date.now() - new Date(lastFiredAt).getTime()) / 3_600_000;
          // elapsedHours < 0 表示记录的触发时间在“未来”——只可能来自系统时钟被回拨或手改，
          // 以及状态文件被外部写坏。此时【不能】按“还在冷却期内”处理：那会让该规则一直沉默到
          // 那个未来时刻真正到来（实测写入一年后的时间戳 → 整整一年不报警），恰是最危险的失声。
          // 视为冷却已过并放行；随后的 markFired 会把时间戳重新拉回当前，自愈。
          // NaN（坏字符串）的比较恒为 false，天然落到放行分支，与这里的取向一致。
          if (elapsedHours >= 0 && elapsedHours < rule.cooldownHours) continue; // 冷却期内，跳过不发信
        }

        // markFired 只在「已确实交付」后才记——否则 SMTP 故障期间第一次告警的异常被吞掉，
        // 却仍标记为「已触发」，会让整个冷却窗口（可能长达数小时）内即使指标持续恶化也不再重试，
        // 恰好是最该报警却失声的场景。失败就让下一次命中在没有冷却阻挡的情况下立即重试。
        //
        // 汇总模式下「交付」= 成功入队（真正发信由 alert-digest-sender 定时做，失败会回填队列重试），
        // 立即模式下「交付」= 发信成功。两种模式的失败语义一致：不记冷却、下次重来。
        try {
          if (digestMode) {
            await enqueueAlertFn({
              ruleId: rule.id,
              ruleName: rule.name,
              ruleKind: rule.kind || "threshold",
              targetId: entry.targetId,
              targetLabel: entry.model || entry.profileName || entry.targetId,
              reason,
              runId: result.runId || "",
            });
          } else {
            await sendAlertMailFn(rule, entry, reason);
          }
          await markFired(rule.id, targetKey);
        } catch (error) {
          console.error(`[alert-rules] ${digestMode ? "入队" : "发信"}失败：`, error?.message || error);
        }
      }
    }
  } catch (error) {
    console.error("[alert-rules] 评估失败：", error?.message || error);
  }
}
