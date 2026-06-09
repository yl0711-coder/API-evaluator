// server/rut-auditor.mjs
//
// RUT（Rank Uniformity Test）排序均匀性检验的统计核心。
// 防换模型的核心方法学之一（替换检测 AUC 0.99+）。
//
// 原理：H0 = 被测渠道就是它标称的官方模型。在 H0 下，把目标渠道对每个 prompt 的
//   采样值，放进"官方基线 API"对同一 prompt 的采样分布里求秩百分位——这些百分位应
//   服从 Uniform(0,1)。若秩百分位显著偏离均匀，则拒绝 H0 → **疑似**被替换/降级。
//
// 统计选择：tech plan 写 Cramér-von Mises；但 CvM 的渐近 p 值实现易错，KS 检验的
//   渐近 p 值（Numerical Recipes ksone）成熟可验证。故**用 KS p 值驱动判定**，
//   同时报告 CvM W² 统计量作参考；精确 CvM p 值留作后续精修。
//
// 喂什么标量由采样层决定：OpenAI 有 logprobs 可用 log-rank；Anthropic 无 logprobs
//   → 纯文本评分函数降级。本核心只处理"标量值"，对降级方案透明。
//
// 诚实边界（红线）：结论只写"疑似/需上游解释"，绝不写"确定是假"。未拒绝 H0 ≠ 证明
//   同一模型，只是"未见替换证据"。量化降级（8-bit）几乎测不出，须标盲区。

const isNum = (v) => Number.isFinite(Number(v));

// 目标值在基线样本分布里的秩百分位（中位秩，落在 (0,1)，避免 0/1 极端塌缩）。
export function empiricalRankPercentile(value, baseline) {
  const b = (baseline || []).filter(isNum).map(Number);
  const n = b.length;
  if (n === 0 || !isNum(value)) return null;
  const v = Number(value);
  let less = 0;
  let equal = 0;
  for (const x of b) {
    if (x < v) less += 1;
    else if (x === v) equal += 1;
  }
  return (less + 0.5 * equal) / n;
}

// Kolmogorov 渐近上尾概率 Q_KS(λ) = 2 Σ(-1)^{k-1} e^{-2k²λ²}（NR 实现）。
function ksProb(lambda) {
  if (lambda <= 0) return 1;
  const EPS1 = 1e-6;
  const EPS2 = 1e-10;
  const a2 = -2 * lambda * lambda;
  let sum = 0;
  let termbf = 0;
  let fac = 2;
  for (let j = 1; j <= 100; j++) {
    const term = fac * Math.exp(a2 * j * j);
    sum += term;
    if (Math.abs(term) <= EPS1 * termbf || Math.abs(term) <= EPS2 * sum) return Math.min(1, Math.max(0, sum));
    fac = -fac;
    termbf = Math.abs(term);
  }
  return Math.min(1, Math.max(0, sum));
}

// 单样本 KS 检验：检验一组值是否服从 Uniform(0,1)。
export function ksTestUniform(values) {
  const u = (values || []).filter(isNum).map(Number).sort((a, b) => a - b);
  const n = u.length;
  if (n < 3) return { n, statistic: null, pValue: null, note: "样本不足（n<3）" };
  let d = 0;
  for (let i = 0; i < n; i++) {
    const cdfBelow = i / n;
    const cdfAbove = (i + 1) / n;
    const f = Math.min(1, Math.max(0, u[i])); // Uniform(0,1) CDF
    d = Math.max(d, Math.abs(f - cdfBelow), Math.abs(cdfAbove - f));
  }
  const en = Math.sqrt(n);
  const pValue = ksProb((en + 0.12 + 0.11 / en) * d);
  return { n, statistic: d, pValue };
}

// Cramér-von Mises W² 统计量（对 Uniform(0,1)）——作参考报告，不出 p 值。
export function cramerVonMisesW2(values) {
  const u = (values || []).filter(isNum).map(Number).sort((a, b) => a - b);
  const n = u.length;
  if (n < 3) return null;
  let s = 1 / (12 * n);
  for (let i = 0; i < n; i++) {
    const expected = (2 * (i + 1) - 1) / (2 * n);
    s += (u[i] - expected) * (u[i] - expected);
  }
  return s;
}

const round = (v, d = 5) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

// 对一组秩百分位做均匀性检验并判定。p<alpha → 拒绝均匀 → 疑似替换。
export function rutUniformityTest(rankPercentiles, { alpha = 0.05 } = {}) {
  const ks = ksTestUniform(rankPercentiles);
  const w2 = cramerVonMisesW2(rankPercentiles);
  if (ks.pValue === null) {
    return {
      method: "rank-uniformity (KS p 值；CvM W² 参考)",
      n: ks.n,
      suspected: false,
      verdict: "样本不足，无法判定",
      confidence: "low",
      note: ks.note,
    };
  }
  const suspected = ks.pValue < alpha;
  return {
    method: "rank-uniformity (KS p 值驱动；CvM W² 参考)",
    n: ks.n,
    ksStatistic: round(ks.statistic),
    cvmW2: round(w2),
    pValue: round(ks.pValue),
    alpha,
    suspected,
    verdict: suspected
      ? "疑似被替换/降级：秩分布显著偏离均匀（需上游解释，非铁证）"
      : "未见替换证据：秩分布未显著偏离均匀（不等于证明同一模型）",
    confidence: "low",
    caveat: "软件黑盒只给概率判断；量化降级（如 8-bit）几乎测不出，属盲区。",
  };
}

// 编排：目标对每个 prompt 各 1 个采样值，基线对每个 prompt 一组采样值 → 秩百分位 → 检验。
export function auditModelSubstitution({ targetValues = [], baselineSamplesPerPrompt = [], alpha = 0.05 } = {}) {
  const percentiles = [];
  for (let i = 0; i < targetValues.length; i++) {
    const p = empiricalRankPercentile(targetValues[i], baselineSamplesPerPrompt[i] || []);
    if (p !== null) percentiles.push(p);
  }
  return { ...rutUniformityTest(percentiles, { alpha }), promptsUsed: percentiles.length };
}

// ---------------------------------------------------------------------------
// 预算守卫：RUT 单次上万调用，仅高价档放行
// ---------------------------------------------------------------------------

export function estimateRutCallBudget(nPrompts, mBaselineSamples) {
  const n = Math.max(0, Math.floor(nPrompts) || 0);
  const m = Math.max(0, Math.floor(mBaselineSamples) || 0);
  const targetCalls = n; // 目标各采 1 次
  const baselineCalls = n * m; // 基线各采 m 次
  return { targetCalls, baselineCalls, totalCalls: targetCalls + baselineCalls };
}

export function rutBudgetGuard(nPrompts, mBaselineSamples, { maxCalls = 2000, allowHighTier = false } = {}) {
  const budget = estimateRutCallBudget(nPrompts, mBaselineSamples);
  const withinBudget = budget.totalCalls <= maxCalls;
  return {
    ...budget,
    maxCalls,
    withinBudget,
    allowed: withinBudget || allowHighTier,
    note: withinBudget
      ? "在预算内"
      : allowHighTier
        ? `超默认预算（${budget.totalCalls}>${maxCalls}），高价档显式放行`
        : `超预算（${budget.totalCalls}>${maxCalls}），需显式高价档授权（RUT 单次可上万调用）`,
  };
}
