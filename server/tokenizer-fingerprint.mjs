// server/tokenizer-fingerprint.mjs
//
// 零成本 tokenizer 粗筛。
//
// 定位与诚实边界：
//   - 本模块**不发请求、不依赖任何 tokenizer 库**，复用已捕获的 usage.prompt_tokens
//     做"计数合理性检查"，是零额外成本的家族粗筛。
//   - 它能做的：发现 token 计数与任何合理 tokenizer 都对不上的**毛刺**（计数异常 →
//     可能少计/缓存/灌水，喂给 Step5 PALACE 审计），以及给一个**低置信**的家族提示。
//   - 它不能做的：仅凭 chars-per-token 精确区分 GPT / Claude / Qwen 等家族——
//     精确区分需要官方 tokenizer 标定（calibrateFamilyCpt）或 RUT 统计检验。
//   - 因此所有判定只输出"疑似 / 粗筛 / 需标定确认"，绝不写"确定是 X 家族"。
//
// 与 model-fingerprint 行为探针互补：那个问"你是谁"，这个看"token 怎么切"。

import { inferModelFamily } from "./model-fingerprint.mjs";

export const TOKENIZER_FINGERPRINT_VERSION = "2026.06.02";

// 局部启发式估算的经验常数。**粗略值**，用官方 tokenizer 标定后可替换。
// CJK 在不同 tokenizer 里差异很大（cl100k ~1.5-2.5 token/字，o200k ~0.6-1），
// 取中点 1.0 作家族无关基线；ASCII 英文约 4 字符/token。
const ASCII_CHARS_PER_TOKEN = 4;
const CJK_TOKENS_PER_CHAR = 1.0;
const WHITESPACE_CHARS_PER_TOKEN = 12; // 空白多被并入相邻 token
const PUNCT_TOKENS_PER_CHAR = 0.5;

// 家族 chars-per-token 的**粗略**经验区间（同等文本构成下）。仅作低置信提示，需标定。
// 留空/宽区间是诚实的：没有标定数据就不假装能精确区分。
const FAMILY_CPT_HINTS = [
  { family: "openai", min: 3.0, max: 5.0, note: "o200k 对英文/CJK 都较省，需标定" },
  { family: "claude", min: 2.5, max: 4.5, note: "需官方 tokenizer 标定" },
];

const CJK_PATTERN =
  /[㐀-䶿一-鿿豈-﫿぀-ヿ㄰-㆏가-힯]/u;

export function countCharClasses(text) {
  const raw = String(text || "");
  let cjk = 0;
  let ascii = 0;
  let whitespace = 0;
  let punct = 0;
  for (const ch of raw) {
    if (/\s/.test(ch)) whitespace += 1;
    else if (CJK_PATTERN.test(ch)) cjk += 1;
    else if (/[A-Za-z0-9]/.test(ch)) ascii += 1;
    else punct += 1;
  }
  return { total: [...raw].length, cjk, ascii, whitespace, punct };
}

// 局部、无依赖的**近似** token 估算。明确是近似，不是精确 tokenization。
export function estimateTokens(text) {
  const { cjk, ascii, whitespace, punct } = countCharClasses(text);
  const estimate =
    cjk * CJK_TOKENS_PER_CHAR +
    ascii / ASCII_CHARS_PER_TOKEN +
    whitespace / WHITESPACE_CHARS_PER_TOKEN +
    punct * PUNCT_TOKENS_PER_CHAR;
  return Math.max(0, Math.round(estimate));
}

export function charsPerToken(text, reportedTokens) {
  const tokens = Number(reportedTokens);
  const length = [...String(text || "")].length;
  if (!Number.isFinite(tokens) || tokens <= 0 || length === 0) return null;
  return length / tokens;
}

// 计数合理性区间（实测 token / 局部估算）故意放宽：家族间 CPT 差异本就大，
// 只有"任何 tokenizer 都解释不了"的离谱比值才判异常，避免把家族差异误报成欺诈。
const PLAUSIBLE_RATIO_LOW = 0.4; // ratio < LOW → 实测远少于估算 → 疑似偏低
const PLAUSIBLE_RATIO_HIGH = 2.5; // ratio > HIGH → 实测远多于估算 → 疑似偏高

// 用一条文本 + 上游报告的 prompt_tokens 做零成本指纹。
//   text：发送给上游、被计入 prompt_tokens 的输入文本。
//   reportedTokens：上游 usage 里报告的对应 token 数。
//   declaredModel：标称模型名（用于和家族提示对照）。
export function fingerprintTokenizer({ text, reportedTokens, declaredModel = "" } = {}) {
  const estimated = estimateTokens(text);
  const measured = Number(reportedTokens);
  const cpt = charsPerToken(text, reportedTokens);
  const declaredFamily = inferModelFamily(declaredModel) || "";

  const base = {
    version: TOKENIZER_FINGERPRINT_VERSION,
    method: "chars-per-token 粗筛（零成本，需标定/RUT 确认）",
    estimatedTokens: estimated,
    measuredTokens: Number.isFinite(measured) ? measured : null,
    charsPerToken: cpt,
    declaredFamily,
    confidence: "low",
  };

  if (!Number.isFinite(measured) || measured <= 0 || estimated <= 0) {
    return { ...base, ratio: null, plausibility: "无法判断", suspectedFamilies: [], note: "缺少有效 token 计数或文本，无法粗筛。" };
  }

  const ratio = measured / estimated;
  let plausibility = "计数合理范围（粗筛）";
  let note = "实测 token 数与局部估算量级一致，未见明显异常。";
  if (ratio > PLAUSIBLE_RATIO_HIGH) {
    plausibility = "疑似计数偏高";
    note = "实测 token 数远超局部估算，疑似多计/重复计费/灌水，建议交 token 审计核对（需上游解释）。";
  } else if (ratio < PLAUSIBLE_RATIO_LOW) {
    plausibility = "疑似计数偏低";
    note = "实测 token 数远低于局部估算，疑似少计/缓存命中/裁剪，需上游解释。";
  }

  const suspectedFamilies = cpt == null
    ? []
    : FAMILY_CPT_HINTS.filter((hint) => cpt >= hint.min && cpt <= hint.max).map((hint) => ({
        family: hint.family,
        note: hint.note,
      }));

  return { ...base, ratio: Math.round(ratio * 1000) / 1000, plausibility, suspectedFamilies, note };
}

// 标定钩子：用官方 tokenizer 对固定探针实测得到的 (text, tokens) 校准家族 CPT。
// 返回可写回 FAMILY_CPT_HINTS 的观测值；真实标定数据由线上/离线步骤产出，
// 这里只做计算，不臆造数字。
export function observeFamilyCpt({ family, text, tokens }) {
  const cpt = charsPerToken(text, tokens);
  return { family: inferModelFamily(family) || family, charsPerToken: cpt, observedAt: null };
}
