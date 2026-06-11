// server/token-auditor.mjs
//
// token 灌水审计（本地估算对照）。两条上游欺诈防线之一（计费灌水）。
//
// 思路：从输入/输出文本用本地估算得到"应有 token 数"，对照上游 usage 报告的
//   token 数。比值显著偏高 → 疑似多计/灌水（尤其输出 token，计费更贵）；显著偏低
//   → 疑似少计/缓存命中/裁剪。
//
// 诚实边界（红线）：
//   - 本地估算是**近似**（tokenizer 家族不同 chars/token 差异大），单请求噪声大，
//     容差放宽，只抓离谱比值；聚合整轮后噪声平均，容差才收紧——聚合才是这套审计的
//     真信号（系统性灌水），单请求只作参考。
//   - 结论一律"疑似 / 需上游解释"，绝不写"确定灌水"（软件黑盒 + 商业诋毁法律边界）。
//   - 与 model-fingerprint 的 buildTokenAudit（usage 覆盖率/零输出）互补，不重复。

import { estimateTokens } from "./tokenizer-fingerprint.mjs";
import { countExactTokens, resolveOpenAiEncoding } from "./tokenizer-official.mjs";

export const TOKEN_AUDIT_VERSION = "2026.06.02";

// 单请求容差（估算噪声大）
const SINGLE_HIGH = 2.5;
const SINGLE_LOW = 0.4;
const SINGLE_EGREGIOUS = 4;
// 聚合容差（噪声平均后收紧）
const AGG_HIGH = 1.6;
const AGG_LOW = 0.6;

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ratio(reported, estimated) {
  if (reported === null || !Number.isFinite(estimated) || estimated <= 0) return null;
  return reported / estimated;
}

function round3(value) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

// 单请求审计。inputText/outputText 是实际收发文本，usage 是 extractUsage 结果。
export function auditTokenUsage({ inputText = "", outputText = "", usage = {} } = {}) {
  const estimatedInput = estimateTokens(inputText);
  const estimatedOutput = estimateTokens(outputText);
  const reportedInput = numberOrNull(usage.inputTokens);
  const reportedOutput = numberOrNull(usage.outputTokens);
  const reasoning = numberOrNull(usage.reasoningTokens);

  const inputRatio = ratio(reportedInput, estimatedInput);
  const outputRatio = ratio(reportedOutput, estimatedOutput);
  const flags = [];

  if (outputRatio !== null && outputRatio > SINGLE_HIGH) {
    flags.push({
      code: "output_inflated",
      level: outputRatio > SINGLE_EGREGIOUS ? "high" : "medium",
      note: "上游报告的输出 token 远超本地估算，疑似输出 token 灌水（输出计费更贵），需上游解释。",
    });
  }
  if (inputRatio !== null && inputRatio > SINGLE_HIGH) {
    flags.push({
      code: "input_inflated",
      level: "medium",
      note: "输入 token 远超本地估算，疑似多计/重复计费，需上游解释。",
    });
  }
  if (outputRatio !== null && outputRatio < SINGLE_LOW) {
    flags.push({
      code: "output_undercount",
      level: "low",
      note: "输出 token 远低于估算，疑似少计/缓存命中/裁剪。",
    });
  }
  if (reasoning !== null && reportedOutput && reasoning > reportedOutput * 5) {
    flags.push({
      code: "reasoning_disproportionate",
      level: "medium",
      note: "推理 token 占比异常高，需确认是否合理计费。",
    });
  }

  return {
    version: TOKEN_AUDIT_VERSION,
    method: "本地估算对照（单请求，粗筛；需上游解释，非铁证）",
    estimatedInput,
    estimatedOutput,
    reportedInput,
    reportedOutput,
    inputRatio: round3(inputRatio),
    outputRatio: round3(outputRatio),
    flags,
    suspicious: flags.some((f) => f.level === "high" || f.level === "medium"),
    confidence: "low",
  };
}

// 整轮聚合审计（聚合真信号）：把多条样本的估算与报告分别求和再比，系统性灌水
// 才会在聚合比值上稳定显现。samples 每项可给 {inputText,outputText,usage} 或预估值。
export function auditRunTokenUsage(samples) {
  let estIn = 0;
  let estOut = 0;
  let repIn = 0;
  let repOut = 0;
  let n = 0;
  let nIn = 0;
  let nOut = 0;

  for (const s of samples || []) {
    const ro = numberOrNull(s.reportedOutputTokens ?? s.usage?.outputTokens);
    const ri = numberOrNull(s.reportedInputTokens ?? s.usage?.inputTokens);
    if (ro === null && ri === null) continue;
    n += 1;
    // 分端累加：缺哪一端就不计入哪一端的估算/求和，否则会用整段估算 vs 0 报告
    // 拉低该端比值，反向误报 systematic_*_undercount。
    if (ro !== null) {
      estOut += s.estimatedOutputTokens ?? estimateTokens(s.outputText || "");
      repOut += ro;
      nOut += 1;
    }
    if (ri !== null) {
      estIn += s.estimatedInputTokens ?? estimateTokens(s.inputText || "");
      repIn += ri;
      nIn += 1;
    }
  }

  if (n === 0) {
    return { n: 0, verdict: "样本不足", suspicious: false, flags: [], confidence: "low", method: "整轮聚合对照" };
  }

  const outputRatio = estOut > 0 ? repOut / estOut : null;
  const inputRatio = estIn > 0 ? repIn / estIn : null;
  const flags = [];

  if (outputRatio !== null && outputRatio > AGG_HIGH) {
    flags.push({
      code: "systematic_output_inflation",
      level: outputRatio > SINGLE_EGREGIOUS ? "high" : "medium",
      note: `整轮输出 token 比估算系统性偏高（×${round3(outputRatio)}），疑似计费灌水，需上游解释。`,
    });
  }
  if (inputRatio !== null && inputRatio > AGG_HIGH) {
    flags.push({
      code: "systematic_input_inflation",
      level: "medium",
      note: `整轮输入 token 系统性偏高（×${round3(inputRatio)}），疑似多计/重复计费，需上游解释。`,
    });
  }
  if (outputRatio !== null && outputRatio < AGG_LOW) {
    flags.push({
      code: "systematic_output_undercount",
      level: "low",
      note: `整轮输出 token 系统性偏低（×${round3(outputRatio)}），疑似少计/缓存。`,
    });
  }

  const suspicious = flags.some((f) => f.level === "high" || f.level === "medium");
  // 自适应置信（gap：多测收敛噪声）：聚合样本越多，估算噪声平均越充分，结论越可信。
  const confidence = n >= 50 ? "high" : n >= 15 ? "medium" : "low";
  const borderline = outputRatio !== null && outputRatio > AGG_HIGH * 0.85 && outputRatio <= AGG_HIGH;
  const recommendation =
    n < 15 && (suspicious || borderline)
      ? `样本偏少（${n} 条）${borderline ? "且比值接近阈值" : ""}，建议增加轮数/样本以收敛估算噪声后再定论。`
      : "";
  return {
    n,
    inputSamples: nIn,
    outputSamples: nOut,
    estimatedInputTokens: estIn,
    estimatedOutputTokens: estOut,
    reportedInputTokens: repIn,
    reportedOutputTokens: repOut,
    inputRatio: round3(inputRatio),
    outputRatio: round3(outputRatio),
    flags,
    suspicious,
    verdict: suspicious ? "疑似计费异常，需上游解释" : "估算与报告差异在合理范围（粗筛）",
    confidence,
    recommendation,
    method: "整轮聚合对照（整轮，需上游解释，非铁证）",
  };
}

// 绝对 token 审计（OpenAI 系，官方分词器精确判定）。
// 对一组固定文本探针，用官方 tokenizer 算出**精确** token 数，对上游报告的 prompt_tokens
// 做线性拟合 reported ≈ slope·exact + intercept：
//   - slope  = 计费倍率（1.0 诚实；>1 比例性虚报，slope-1 即虚报比例，单渠道绝对可量化）。
//   - intercept = 每条请求的固定模板开销（被拟合吸收，不污染倍率）。
//   - R²    = 线性拟合优度；明显偏低 → 上游计费与该编码不成线性 → 疑似底层 tokenizer 非该家族。
// 仅 OpenAI 系适用；其它家族返回 applicable:false，调用方回退横向/估算法。
export async function auditAbsoluteTokens({ probes = [], model = "" } = {}) {
  const encoding = resolveOpenAiEncoding(model);
  if (!encoding) {
    return {
      applicable: false,
      reason: "no_official_tokenizer",
      note: `模型「${model}」无可用官方离线分词器（目前仅 OpenAI 系支持绝对判定），已回退横向对照/估算法。`,
    };
  }
  const points = [];
  for (const p of probes || []) {
    const reported = numberOrNull(p.reportedTokens);
    if (reported === null || reported <= 0) continue;
    const exact = await countExactTokens(p.text, model);
    if (!Number.isFinite(exact) || exact <= 0) continue;
    points.push({ id: p.id, exact, reported });
  }
  if (points.length < 2) {
    return { applicable: false, reason: "insufficient_points", encoding, note: "可用于绝对对照的固定探针不足 2 个（quick 包不含指纹探针时常见）。" };
  }

  const n = points.length;
  const sx = points.reduce((a, p) => a + p.exact, 0);
  const sy = points.reduce((a, p) => a + p.reported, 0);
  const sxx = points.reduce((a, p) => a + p.exact * p.exact, 0);
  const sxy = points.reduce((a, p) => a + p.exact * p.reported, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) {
    return { applicable: false, reason: "degenerate_points", encoding, note: "固定探针 token 数无区分度，无法拟合。" };
  }
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  const ssTot = points.reduce((a, p) => a + (p.reported - meanY) ** 2, 0);
  const ssRes = points.reduce((a, p) => a + (p.reported - (slope * p.exact + intercept)) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
  const inflationPct = Math.round((slope - 1) * 100);

  const flags = [];
  let status = "consistent";
  let verdict = `按官方 ${encoding} 精确分词，计费倍率 ×${round3(slope)}（每条固定开销约 ${Math.round(intercept)} token），与诚实计费一致。`;
  if (slope > 1.1) {
    status = "inflation";
    verdict = `按官方 ${encoding} 精确分词，上游输入 token 计费倍率约 ×${round3(slope)}，虚报约 ${inflationPct}%（绝对判定：固定文本的精确 token 数已知，非横向估计）。`;
    flags.push({ code: "absolute_token_inflation", level: slope > 1.3 ? "high" : "medium", note: verdict });
  } else if (slope < 0.9) {
    status = "undercount";
    verdict = `计费倍率 ×${round3(slope)}，低于精确分词，疑似少计/缓存命中，需确认。`;
  }
  if (intercept > 40) {
    flags.push({ code: "high_constant_overhead", level: "low", note: `每条请求固定开销约 ${Math.round(intercept)} token，偏高，疑似固定加价，可复核。` });
  }
  if (r2 !== null && r2 < 0.9 && n >= 3) {
    flags.push({
      code: "tokenizer_family_mismatch",
      level: "medium",
      note: `上游计费与官方 ${encoding} 精确分词不成线性（R²=${round3(r2)}），疑似底层 tokenizer 非 ${encoding} 家族（挂羊头），需上游解释。`,
    });
  }

  return {
    applicable: true,
    encoding,
    points: n,
    slope: round3(slope),
    intercept: Math.round(intercept),
    r2: round3(r2),
    estimatedInflationPct: inflationPct,
    status,
    flags,
    suspicious: flags.some((f) => f.level === "high" || f.level === "medium"),
    confidence: n >= 3 ? "high" : "medium",
    verdict,
    method: "官方 tokenizer 精确分词 + 线性拟合（reported≈slope·exact+overhead），单渠道绝对判定",
  };
}

// 新型计费维度审计（gap：reasoning / cache token 未明确覆盖）。
// 2026 计费大头是缓存读写 + 推理 token；本审计核对其**存在性与比例异常**，
// 不做精确重定价（重定价需单独的分维度单价，属成本统计三期）。
const REASONING_MODEL_HINT = /o[134]\b|o[134][-_]|reason|think|deepseek[-_]?r|qwq|gpt-?5/i;

export function auditBillingDimensions(records = [], { model = "" } = {}) {
  let reasoning = 0;
  let cacheCreate = 0;
  let cacheRead = 0;
  let output = 0;
  let requestsWithReasoning = 0;
  let n = 0;
  for (const r of records || []) {
    n += 1;
    const rs = Number(r?.reasoningTokens) || 0;
    reasoning += rs;
    if (rs > 0) requestsWithReasoning += 1;
    cacheCreate += Number(r?.cacheCreationTokens) || 0;
    cacheRead += Number(r?.cacheReadTokens) || 0;
    output += Number(r?.outputTokens) || 0;
  }
  const looksLikeReasoningModel = REASONING_MODEL_HINT.test(String(model || ""));
  const flags = [];
  if (reasoning > 0 && !looksLikeReasoningModel) {
    flags.push({
      code: "reasoning_billed_nonreasoning_model",
      severity: "medium",
      detail: `模型名「${model}」不像推理类，却计了 ${reasoning} 个推理 token，需确认计费是否合理（需上游解释）。`,
    });
  }
  if (reasoning > 0 && output > 0 && reasoning > output * 3) {
    flags.push({
      code: "reasoning_disproportionate_agg",
      severity: "medium",
      detail: `整轮推理 token（${reasoning}）远超输出 token（${output}），疑似推理计费偏高，需上游解释。`,
    });
  }
  if (cacheCreate > 0 && cacheRead === 0) {
    flags.push({
      code: "cache_write_no_read",
      severity: "low",
      detail: `只见缓存写入（${cacheCreate}）无缓存读取，缓存计费未带来节省，多轮测试可复查。`,
    });
  }
  return {
    version: TOKEN_AUDIT_VERSION,
    requestCount: n,
    reasoningTokens: reasoning,
    cacheCreationTokens: cacheCreate,
    cacheReadTokens: cacheRead,
    requestsWithReasoning,
    looksLikeReasoningModel,
    flags,
    suspicious: flags.some((f) => f.severity === "high" || f.severity === "medium"),
    note: "核对 2026 计费大头（缓存读写 / 推理 token）的存在性与比例异常，不做精确重定价。",
  };
}
