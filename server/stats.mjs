// server/stats.mjs
//
// 统计严谨地基。纯函数，无外部依赖。
//
// 红线约束：
//   1. 比例指标必带样本数 + 95% 置信区间。
//   2. 小样本（测试包几十个 prompt）禁用普通 CLT 正态近似，用 Wilson / bootstrap。
//   3. 渠道对比必须做显著性检验；置信区间重叠 / p≥α 不下"A 优于 B"。
//
// bootstrap 用可种子化 PRNG，保证报告可复现（同输入同种子同区间）。

import { isFiniteNumber, mulberry32 } from "./utils.mjs";

const DEFAULT_Z_95 = 1.959963984540054; // 标准正态 0.975 分位

// ---------------------------------------------------------------------------
// 基础数学（自实现，避免引入统计库）
// ---------------------------------------------------------------------------

// Abramowitz & Stegun 7.1.26，|误差| <= 1.5e-7
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Lanczos 近似的 ln Γ(x)
function gammaln(x) {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function logChoose(n, k) {
  return gammaln(n + 1) - gammaln(k + 1) - gammaln(n - k + 1);
}

function binomPmf(n, k, p) {
  if (k < 0 || k > n) return 0;
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

// 正则化不完全 Beta 函数 I_x(a,b)（Numerical Recipes 连分式）
function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = gammaln(a) + gammaln(b) - gammaln(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

// Student-t 双侧 p 值：两侧 p = I_{df/(df+t^2)}(df/2, 1/2)
export function studentTwoSidedP(t, df) {
  if (!isFiniteNumber(t) || !isFiniteNumber(df) || df <= 0) return 1;
  if (!Number.isFinite(t)) return 0;
  const x = df / (df + t * t);
  return Math.min(1, Math.max(0, betai(df / 2, 0.5, x)));
}

// 卡方(df=1) 上尾概率
function chiSquare1SurvivalP(x) {
  if (x <= 0) return 1;
  return Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.sqrt(x)))));
}

function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function cleanNumbers(values) {
  return (values || []).filter(isFiniteNumber).map(Number);
}

// ---------------------------------------------------------------------------
// 比例置信区间
// ---------------------------------------------------------------------------

// Wilson score interval：小样本安全，不退化（不像 Wald 在 p=0/1 时区间塌缩）。
export function wilsonInterval(successes, total, { z = DEFAULT_Z_95 } = {}) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  if (n === 0) {
    return { point: null, lower: null, upper: null, n: 0, successes: 0, z, method: "wilson", note: "无样本" };
  }
  const k = Math.min(n, Math.max(0, Math.floor(Number(successes) || 0)));
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    point: p,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    n,
    successes: k,
    z,
    method: "wilson",
  };
}

// 报告便捷封装：直接给出渲染所需字段（样本数 + 比例 + 95% CI 文案）。
export function proportionReport(successes, total, { digits = 1 } = {}) {
  const ci = wilsonInterval(successes, total);
  const pct = (value) => (value == null ? "-" : `${(value * 100).toFixed(digits)}%`);
  return {
    n: ci.n,
    successes: ci.successes,
    rate: ci.point,
    ratePercent: pct(ci.point),
    ci95Lower: ci.lower,
    ci95Upper: ci.upper,
    ci95Text: ci.n === 0 ? "样本不足" : `[${pct(ci.lower)}, ${pct(ci.upper)}]`,
    method: ci.method,
  };
}

// ---------------------------------------------------------------------------
// bootstrap 置信区间（连续指标 / 任意统计量）
// ---------------------------------------------------------------------------

export function bootstrapCI(
  values,
  { statistic, resamples = 2000, alpha = 0.05, seed = 1469598103 } = {},
) {
  const clean = cleanNumbers(values);
  const n = clean.length;
  const stat =
    typeof statistic === "function" ? statistic : (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  if (n === 0) {
    return { point: null, lower: null, upper: null, n: 0, resamples: 0, method: "bootstrap", note: "无样本" };
  }
  const point = stat(clean);
  if (n === 1) {
    return { point, lower: point, upper: point, n, resamples: 0, method: "bootstrap", note: "样本量=1，无法估计区间" };
  }
  const rng = mulberry32(seed);
  const stats = new Array(resamples);
  const sample = new Array(n);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) {
      sample[i] = clean[Math.floor(rng() * n)];
    }
    stats[r] = stat(sample);
  }
  stats.sort((a, b) => a - b);
  return {
    point,
    lower: quantileSorted(stats, alpha / 2),
    upper: quantileSorted(stats, 1 - alpha / 2),
    n,
    resamples,
    alpha,
    seed,
    method: "bootstrap-percentile",
  };
}

// ---------------------------------------------------------------------------
// 显著性检验
// ---------------------------------------------------------------------------

// McNemar：配对二分类（同一组 prompt 上两渠道的通过/失败）。
//   b = A 通过且 B 失败的对数；c = A 失败且 B 通过的对数。
//   小样本（不一致对 < 阈值）用精确二项检验；否则连续性校正卡方。
export function mcnemarTest(b, c, { exactThreshold = 25 } = {}) {
  const nb = Math.max(0, Math.floor(Number(b) || 0));
  const nc = Math.max(0, Math.floor(Number(c) || 0));
  const n = nb + nc;
  if (n === 0) {
    return { pValue: 1, statistic: 0, discordant: 0, b: nb, c: nc, method: "none", note: "无不一致对" };
  }
  if (n < exactThreshold) {
    const lo = Math.min(nb, nc);
    let tail = 0;
    for (let i = 0; i <= lo; i++) tail += binomPmf(n, i, 0.5);
    return {
      pValue: Math.min(1, 2 * tail),
      statistic: lo,
      discordant: n,
      b: nb,
      c: nc,
      method: "exact-binomial",
    };
  }
  const chi2 = Math.pow(Math.abs(nb - nc) - 1, 2) / n;
  return {
    pValue: chiSquare1SurvivalP(chi2),
    statistic: chi2,
    discordant: n,
    b: nb,
    c: nc,
    method: "chi-square-continuity",
  };
}

// Wilcoxon 符号秩检验：配对连续/评分，非正态。
//   入参可为 (paired a, paired b) 或 (diffs)。
//   正态近似 + 连续性校正 + 并列校正；n<10 标注建议精确检验。
export function wilcoxonSignedRank(a, b, { correction = true } = {}) {
  let diffs;
  if (Array.isArray(b)) {
    const m = Math.min(a.length, b.length);
    diffs = [];
    for (let i = 0; i < m; i++) {
      const d = Number(a[i]) - Number(b[i]);
      if (isFiniteNumber(d)) diffs.push(d);
    }
  } else {
    diffs = cleanNumbers(a);
  }
  const nonzero = diffs.filter((d) => d !== 0);
  const n = nonzero.length;
  if (n === 0) {
    return { pValue: 1, wPlus: 0, wMinus: 0, statistic: 0, n: 0, method: "none", note: "全部差值为 0" };
  }
  const entries = nonzero
    .map((d) => ({ d, abs: Math.abs(d) }))
    .sort((x, y) => x.abs - y.abs);
  const ranks = new Array(n);
  let tieTerm = 0; // Σ(t^3 - t)
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && entries[j + 1].abs === entries[i].abs) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based 秩
    const t = j - i + 1;
    if (t > 1) tieTerm += t * t * t - t;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let wPlus = 0;
  let wMinus = 0;
  for (let k = 0; k < n; k++) {
    if (entries[k].d > 0) wPlus += ranks[k];
    else wMinus += ranks[k];
  }
  const w = Math.min(wPlus, wMinus);
  const meanW = (n * (n + 1)) / 4;
  const varW = (n * (n + 1) * (2 * n + 1)) / 24 - tieTerm / 48;
  if (varW <= 0) {
    return { pValue: 1, wPlus, wMinus, statistic: w, n, method: "normal-approx", note: "方差为 0" };
  }
  const cc = correction ? 0.5 : 0;
  const z = (Math.abs(w - meanW) - cc) / Math.sqrt(varW);
  return {
    pValue: Math.min(1, Math.max(0, 2 * (1 - normalCdf(z)))),
    wPlus,
    wMinus,
    statistic: w,
    z,
    n,
    method: n < 10 ? "normal-approx(小样本，建议精确检验)" : "normal-approx",
  };
}

// 配对 t 检验：配对差值正态时使用。
export function pairedTTest(a, b) {
  const m = Math.min((a || []).length, (b || []).length);
  const diffs = [];
  for (let i = 0; i < m; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (isFiniteNumber(d)) diffs.push(d);
  }
  const n = diffs.length;
  if (n < 2) {
    return { pValue: 1, t: 0, df: Math.max(0, n - 1), meanDiff: n ? diffs[0] : 0, n, method: "none", note: "样本不足" };
  }
  const meanDiff = diffs.reduce((s, v) => s + v, 0) / n;
  const variance = diffs.reduce((s, v) => s + (v - meanDiff) * (v - meanDiff), 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) {
    return {
      pValue: meanDiff === 0 ? 1 : 0,
      t: meanDiff === 0 ? 0 : Infinity,
      df: n - 1,
      meanDiff,
      sd: 0,
      n,
      method: "paired-t",
      note: "差值无方差",
    };
  }
  const se = sd / Math.sqrt(n);
  const t = meanDiff / se;
  const df = n - 1;
  return { pValue: studentTwoSidedP(t, df), t, df, meanDiff, sd, n, method: "paired-t" };
}

// ---------------------------------------------------------------------------
// 渠道对比判定（红线门槛）
// ---------------------------------------------------------------------------

// 独立两渠道的比例对比：用 Wilson CI 是否重叠作为保守判定（小样本安全，不用 CLT）。
//   CI 重叠 → "差异不显著"，不下 A 优于 B。
//   配对场景（同一批 prompt）应改用 mcnemarTest。
export function compareProportions(
  aSuccesses,
  aTotal,
  bSuccesses,
  bTotal,
  { labelA = "A", labelB = "B" } = {},
) {
  const a = wilsonInterval(aSuccesses, aTotal);
  const b = wilsonInterval(bSuccesses, bTotal);
  if (a.n === 0 || b.n === 0) {
    return { significant: false, verdict: "样本不足", a, b, overlap: null, method: "wilson-ci-overlap" };
  }
  const overlap = !(a.lower > b.upper || b.lower > a.upper);
  let verdict = "差异不显著";
  if (!overlap) {
    verdict = a.point > b.point ? `${labelA} 优于 ${labelB}` : `${labelB} 优于 ${labelA}`;
  }
  return { significant: !overlap, verdict, a, b, overlap, method: "wilson-ci-overlap" };
}
