// server/llm-judge.mjs
//
// LLM-as-Judge 体系的纯逻辑核心。
//
// 现状：原来根本没有评分裁判，质量分是关键词规则。本模块从零建裁判
// 体系里**可独立测试的纯逻辑**部分：多裁判一致性（Krippendorff α）、人工复核阈值、
// 答案位置随机化（偏见缓解）、同家族裁判规避、多裁判分数聚合。
//
// 实际的裁判 API 调用 + rubric prompt 走后续 ai-report-analysis 扩展，这里不含网络。
//
// 红线/方法学：
//   - 没有裁判全场景可靠（前沿模型偏见错误率 >50%）。多裁判测一致性，α<0.8 标
//     "需人工复核"，不当作可信结论。
//   - 评分主 API 不评同家族被测模型（防自我偏好/偏好泄漏）。
//   - 偏见缓解：位置随机化 + 隐藏来源 + 一致性过滤（本模块覆盖位置随机 + 一致性 +
//     同家族规避；长度归一/盲测属 prompt 层，后续 rubric 实现）。

import { inferModelFamily } from "./model-fingerprint.mjs";
import { mulberry32 } from "./utils.mjs";

export const JUDGE_CONSISTENCY_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// Krippendorff's α：多裁判一致性
// ---------------------------------------------------------------------------
//
// units：每项是"同一被测对象被多个裁判打的分数数组"，缺评用 null/undefined 跳过。
// level："interval"（连续分，默认）或 "nominal"（类别判定）。
// 公式：α = 1 - (n-1) * Σ o·δ² / Σ n_c·n_k·δ²（重合矩阵法）。
export function krippendorffAlpha(units, { level = "interval" } = {}) {
  const delta2 =
    level === "nominal" ? (a, b) => (a === b ? 0 : 1) : (a, b) => (a - b) * (a - b);

  const coincidence = new Map(); // value -> Map(value -> weight)
  const addCoin = (c, k, w) => {
    if (!coincidence.has(c)) coincidence.set(c, new Map());
    const row = coincidence.get(c);
    row.set(k, (row.get(k) || 0) + w);
  };

  for (const unit of units || []) {
    const vals = (unit || [])
      .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
      .map(Number);
    const m = vals.length;
    if (m < 2) continue; // 单评无法贡献一致性
    const w = 1 / (m - 1);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        if (i !== j) addCoin(vals[i], vals[j], w);
      }
    }
  }

  const values = [...coincidence.keys()];
  const nc = new Map();
  let n = 0;
  for (const c of values) {
    let sum = 0;
    for (const w of coincidence.get(c).values()) sum += w;
    nc.set(c, sum);
    n += sum;
  }
  if (n <= 1) return { alpha: null, n, note: "可配对数据不足，无法计算一致性" };

  let doSum = 0;
  let deSum = 0;
  for (const c of values) {
    for (const k of values) {
      const o = coincidence.get(c).get(k) || 0;
      const d2 = delta2(c, k);
      doSum += o * d2;
      deSum += nc.get(c) * nc.get(k) * d2;
    }
  }
  if (deSum === 0) return { alpha: 1, n, note: "无变异（完全一致）" };
  return { alpha: 1 - ((n - 1) * doSum) / deSum, n };
}

// 一致性判定 + 人工复核标记。α < 阈值（默认 0.8）→ 需人工复核，不当可信结论。
export function judgeConsistency(units, { level = "interval", threshold = JUDGE_CONSISTENCY_THRESHOLD } = {}) {
  const { alpha, n, note } = krippendorffAlpha(units, { level });
  const reliable = alpha !== null && alpha >= threshold;
  return {
    alpha: alpha === null ? null : Math.round(alpha * 1000) / 1000,
    n,
    threshold,
    level,
    reliable,
    needsHumanReview: !reliable,
    note: note || (reliable ? "裁判一致性达标" : "裁判一致性不足，需人工复核"),
    method: "krippendorff-alpha",
  };
}

// ---------------------------------------------------------------------------
// 偏见缓解：答案位置随机化（确定性，可复现）
// ---------------------------------------------------------------------------

// 把候选答案随机排位后交给裁判（消除位置偏好），并返回还原映射。
// 确定性（同 seed 同结果），便于复现与回溯。
export function randomizeAnswerPositions(items, seed = 0x9e3779b9) {
  const arr = (items || []).map((value, originalIndex) => ({ value, originalIndex }));
  const rng = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return {
    shuffled: arr.map((e) => e.value),
    // presentedPosition -> originalIndex，裁判按 shuffled 顺序打分后用它还原归属
    revealMap: arr.map((e) => e.originalIndex),
  };
}

// ---------------------------------------------------------------------------
// 同家族裁判规避（防自我偏好 / 偏好泄漏）
// ---------------------------------------------------------------------------

export function sameFamilyConflict(judgeModel, targetModel) {
  const jf = inferModelFamily(judgeModel);
  const tf = inferModelFamily(targetModel);
  return Boolean(jf) && Boolean(tf) && jf === tf;
}

// 从一组裁判里筛掉与被测同家族的（返回可用裁判 + 被排除的）。
export function selectEligibleJudges(judgeModels, targetModel) {
  const eligible = [];
  const excluded = [];
  for (const judge of judgeModels || []) {
    if (sameFamilyConflict(judge, targetModel)) excluded.push(judge);
    else eligible.push(judge);
  }
  return { eligible, excluded };
}

// ---------------------------------------------------------------------------
// 多裁判分数聚合
// ---------------------------------------------------------------------------

// scores：[{ judge, score, weight? }]。默认等权；可传 logprob 派生权重（G-Eval 思路）。
export function aggregateJudgeScores(scores) {
  const clean = (scores || []).filter((s) => s && Number.isFinite(Number(s.score)));
  const judgeCount = clean.length;
  if (judgeCount === 0) {
    return { consensus: null, mean: null, stdev: null, min: null, max: null, judgeCount: 0, weighted: false };
  }
  const values = clean.map((s) => Number(s.score));
  const mean = values.reduce((a, b) => a + b, 0) / judgeCount;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / judgeCount;
  const stdev = Math.sqrt(variance);

  const hasWeights = clean.some((s) => Number.isFinite(Number(s.weight)));
  let consensus = mean;
  if (hasWeights) {
    let wsum = 0;
    let acc = 0;
    for (const s of clean) {
      const w = Number.isFinite(Number(s.weight)) ? Number(s.weight) : 0;
      wsum += w;
      acc += w * Number(s.score);
    }
    if (wsum > 0) consensus = acc / wsum;
  }

  return {
    consensus: Math.round(consensus * 1000) / 1000,
    mean: Math.round(mean * 1000) / 1000,
    stdev: Math.round(stdev * 1000) / 1000,
    min: Math.min(...values),
    max: Math.max(...values),
    judgeCount,
    weighted: hasWeights,
  };
}
