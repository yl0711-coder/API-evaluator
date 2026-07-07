// server/tier-discrimination.mjs
//
// 档位似然比分类器：用校准好的「各题各档通过率」参考分布（claude-tier-calibrate 产出），
//   对被测渠道的电池作答（每题 pass/total）算各档对数似然 → 最像档 + 后验 + margin，
//   判定「声称档 vs 行为最像档」，专抓"声称 Sonnet 行为像 Haiku"这类档位降级。
//
// 方法：对每道判别题，参考给出 p_{档}=该档通过率（Jeffreys 平滑避免 0/1）。被测渠道该题
//   N 次中过 k 次，则各档对数似然累加 k·ln p + (N−k)·ln(1−p)。各档求和后比大小=最像档；
//   softmax 得后验；声称档若比最像档明显低、且最像档更廉价 → 疑似降级。
//
// 自动滤题：剔除「档位非单调(噪声/反向)」与「判别度过低(各档分不开)」的题——这俩只会添乱。
//
// 诚实红线：参考非官方=ground-truth 时自动降一档置信；锚点塌缩则判不可靠；量化/蒸馏高仿与
//   探针规避属盲区。结论一律"疑似降级/需上游解释"，绝不写"确定"。

import { readFileSync } from "node:fs";

export const TIER_DISCRIMINATION_VERSION = "2026.06.17";

// 档位由强到弱的"价位/能力"序。rank 越大越贵越强；用于判"最像档是否比声称档更廉价"。
const DEFAULT_TIER_RANK = { opus: 3, sonnet: 2, haiku: 1 };

// Jeffreys 平滑：rate×attempts 还原成 k，再 (k+0.5)/(n+1)。把 0/1 拉离边界，避免 ln(0)。
function jeffreys(rate, attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  const k = Math.round((Number(rate) || 0) * n);
  return (k + 0.5) / (n + 1);
}

function isMonotonic(ref, strongToWeak, tol = 0.001) {
  let prev = Infinity;
  for (const t of strongToWeak) {
    const v = ref[t];
    if (v === null || v === undefined) continue;
    if (v > prev + tol) return false; // 弱档不该高于强档
    prev = v;
  }
  return true;
}

function separation(ref, tiers) {
  const vals = tiers.map((t) => ref[t]).filter((v) => v !== null && v !== undefined);
  return vals.length < 2 ? 0 : Math.max(...vals) - Math.min(...vals);
}

const downgradeConf = (c) => (c === "high" ? "medium" : "low");
const pctOf = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const round = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? v : Math.round(v * 10 ** d) / 10 ** d);

// 聚合在线探针记录 → 每题 {item, pass, total}。records: [{itemId, level, passed}]（同 tier-probes-claude 的产物）。
export function aggregateObserved(records = []) {
  const map = new Map();
  for (const r of records || []) {
    const key = `${r.itemId}@L${r.level}`;
    const cur = map.get(key) || { item: key, pass: 0, total: 0 };
    cur.total += 1;
    if (r.passed) cur.pass += 1;
    map.set(key, cur);
  }
  return [...map.values()];
}

// 主分类。reference=校准 JSON 对象；observed=[{item,pass,total}]；claimedTier=声称档名。
export function classifyChannelTier({ reference, observed, claimedTier, options = {} }) {
  const tiers = reference.calibratedTiers || Object.keys(reference.tiers || {});
  const tierRank = options.tierRank || DEFAULT_TIER_RANK;
  const strongToWeak = [...tiers].sort((a, b) => (tierRank[b] || 0) - (tierRank[a] || 0));
  const minSeparation = options.minSeparation ?? 0.2;
  const dropNonMonotonic = options.dropNonMonotonic !== false;
  const exclude = new Set(options.excludeItems || []);
  const refs = reference.references || {};

  const usable = [];
  const dropped = [];
  for (const o of observed || []) {
    const ref = refs[o.item];
    if (!ref) {
      dropped.push({ item: o.item, reason: "参考库无此题" });
      continue;
    }
    if (exclude.has(o.item)) {
      dropped.push({ item: o.item, reason: "显式排除" });
      continue;
    }
    if (dropNonMonotonic && !isMonotonic(ref, strongToWeak)) {
      dropped.push({ item: o.item, reason: "档位非单调(噪声/反向，剔除)" });
      continue;
    }
    const sep = separation(ref, tiers);
    if (sep < minSeparation) {
      dropped.push({ item: o.item, reason: `判别度过低(分离 ${Math.round(sep * 100)}%)` });
      continue;
    }
    usable.push(o);
  }

  // 各档对数似然（丢弃 C(N,k) 常数——各档相同，不影响排序/后验/margin）。
  const ll = {};
  for (const t of tiers) ll[t] = 0;
  const perItem = [];
  for (const o of usable) {
    const ref = refs[o.item];
    const rates = {};
    for (const t of tiers) {
      const p = jeffreys(ref[t], ref.attempts?.[t] ?? reference.repeats ?? 8);
      ll[t] += o.pass * Math.log(p) + (o.total - o.pass) * Math.log(1 - p);
      rates[t] = round(p);
    }
    perItem.push({ item: o.item, pass: o.pass, total: o.total, refRates: rates });
  }

  const ranked = tiers.map((t) => ({ tier: t, logL: ll[t] })).sort((a, b) => b.logL - a.logL);
  const maxLL = ranked.length ? ranked[0].logL : 0;
  const exps = ranked.map((r) => Math.exp(r.logL - maxLL));
  const sumExp = exps.reduce((a, b) => a + b, 0) || 1;
  ranked.forEach((r, i) => (r.posterior = exps[i] / sumExp));
  const post = Object.fromEntries(ranked.map((r) => [r.tier, r.posterior]));
  const likelyTier = ranked.length ? ranked[0].tier : null;
  const margin = ranked.length > 1 ? ranked[0].logL - ranked[1].logL : Infinity;

  // —— 判定 ——
  const claimedKnown = tiers.includes(claimedTier);
  let status;
  let verdict;
  if (!usable.length) {
    status = "insufficient_items";
    verdict = "可用判别题不足（参考缺失/被剔除/判别度过低），无法判定档位。";
  } else if (!claimedKnown) {
    status = "claimed_tier_not_calibrated";
    verdict = `声称档「${claimedTier}」未在参考中校准，只能给出最像档：${likelyTier}（无法判降级）。`;
  } else if (likelyTier === claimedTier) {
    status = "consistent";
    verdict = `行为与声称档「${claimedTier}」一致（后验 ${pctOf(post[claimedTier])}），未见降级证据（不等于证明同一模型）。`;
  } else if ((tierRank[likelyTier] || 0) < (tierRank[claimedTier] || 0)) {
    status = "suspected_downgrade";
    verdict = `疑似档位降级：声称「${claimedTier}」，行为最像更低档「${likelyTier}」（后验 ${pctOf(post[likelyTier])} vs 声称档 ${pctOf(post[claimedTier])}），需上游解释（非铁证）。`;
  } else {
    status = "behaves_higher";
    verdict = `行为最像「${likelyTier}」，高于声称档「${claimedTier}」——异常但非降级，可能声称保守或样本噪声。`;
  }

  // —— 置信度（含诚实降档）——
  const minTotal = usable.length ? Math.min(...usable.map((o) => o.total)) : 0;
  let confidence = likelyTier && post[likelyTier] >= 0.9 ? "high" : likelyTier && post[likelyTier] >= 0.7 ? "medium" : "low";
  const caveats = [];
  if (!reference.sourceOfficial) {
    confidence = downgradeConf(confidence);
    caveats.push("参考为中转锚定（非官方 ground-truth），已降一档置信。");
  }
  if (reference.anchorHealth && reference.anchorHealth.healthy === false) {
    confidence = "low";
    caveats.push("参考源锚点塌缩/逆序，结论不可靠，建议换源或重校准。");
  }
  if (usable.length < 3) {
    confidence = downgradeConf(confidence);
    caveats.push(`可用判别题仅 ${usable.length} 道，偏少。`);
  }
  if (minTotal < 3) {
    confidence = downgradeConf(confidence);
    caveats.push(`部分题采样偏少（最少 ${minTotal} 次），噪声大。`);
  }

  return {
    version: TIER_DISCRIMINATION_VERSION,
    claimedTier,
    likelyTier,
    status,
    verdict,
    confidence,
    margin: round(margin),
    posterior: Object.fromEntries(Object.entries(post).map(([k, v]) => [k, round(v)])),
    ranked: ranked.map((r) => ({ tier: r.tier, logL: round(r.logL), posterior: round(r.posterior) })),
    usableItems: usable.map((o) => o.item),
    droppedItems: dropped,
    perItem,
    caveats,
    referenceMeta: {
      sourceOfficial: !!reference.sourceOfficial,
      anchorHealthy: reference.anchorHealth?.healthy ?? null,
      probeVersion: reference.probeVersion,
      repeats: reference.repeats,
    },
  };
}

// 读取校准参考文件。
export function loadTierReference(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// 映射到 buildPurityAssessment 的 riskFlags / evidence 形状，便于接入准入纯度评估。
export function summarizeTierForPurity(result) {
  if (!result || result.status === "consistent") {
    return { riskFlags: [], evidence: [{ code: "tier_consistent", detail: result?.verdict || "档位与声称一致。", severity: "pass" }] };
  }
  if (result.status === "suspected_downgrade") {
    const severity = result.confidence === "high" ? "high" : result.confidence === "medium" ? "medium" : "low";
    return { riskFlags: [{ code: "tier_downgrade", title: "疑似档位降级", detail: result.verdict, severity }], evidence: [] };
  }
  return { riskFlags: [], evidence: [{ code: "tier_inconclusive", detail: result.verdict, severity: "watch" }] };
}
