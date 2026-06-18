// server/tokenizer-fingerprint-audit.mjs
//
// 分词器指纹核验(Claude 身份):把被测渠道对固定探针返回的输入 token 数,与本地基线
// (scripts/claude-token-baseline.json,由 scripts/claude-token-baseline.mjs 生成)做线性拟合:
//     reported ≈ slope·base + intercept
//   - 同一代分词器:slope≈1、R²≈1(模板固定开销只改 intercept,不改 slope)。
//   - 换了分词器(挂羊头/换代):slope 偏离 1 或 R² 掉下来。
//
// 这是 token-auditor.mjs 里 auditAbsoluteTokens(OpenAI 系离线分词)的 Claude 侧姊妹:
// Claude 无官方离线分词器,故改用「可信源建立的基线」当对照。
//
// 诚实边界:
//   - 基线不保证是官方分词的绝对值(可能建在可信中转上),判定依赖的是「线性关系」而非绝对相等。
//   - 只能判「代/家族」,判不了同代内的具体型号(同代 token 数相同)。
//   - 仅在「声称是 Claude」且「本地有该代基线」时适用;否则 applicable:false,绝不硬判。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TOKENIZER_FINGERPRINT_VERSION = "2026.06.17";

const BASELINE_PATH = fileURLToPath(new URL("../scripts/claude-token-baseline.json", import.meta.url));

let baselineCache; // undefined=未读;null=不可用;object=已读
function loadBaseline() {
  if (baselineCache !== undefined) return baselineCache;
  try {
    baselineCache = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    baselineCache = null;
  }
  return baselineCache;
}

// 仅供测试:重置缓存(注入自定义基线)。
export function __setBaselineForTest(doc) {
  baselineCache = doc === undefined ? undefined : doc;
}

// 分词器「代」键:同键 = 同分词器(官方文档 + 实测确认)。无法确信的归 null(不强行映射)。
function generationKey(model) {
  const m = String(model || "").toLowerCase();
  if (/opus-4-7|opus-4-8|fable-5|mythos/.test(m)) return "g-opus47"; // 4.7/4.8/Fable5/Mythos 同一代
  if (/opus-4-6|sonnet-4-6/.test(m)) return "g-46"; // 实测 opus-4-6 与 sonnet-4-6 向量一致
  return null;
}

// 给被测型号挑一份基线:先精确同名,再按代匹配;都没有则 null(此型号无可信基线)。
export function resolveBaselineModel(model, doc = loadBaseline()) {
  if (!doc || !Array.isArray(doc.baselines)) return null;
  const entries = doc.baselines.filter((b) => b && !b.error && Array.isArray(b.probes) && b.probes.length);
  const lower = String(model || "").toLowerCase();
  const exact = entries.find((b) => String(b.model).toLowerCase() === lower);
  if (exact) return exact.model;
  const gk = generationKey(model);
  if (!gk) return null;
  const byGen = entries.find((b) => generationKey(b.model) === gk);
  return byGen ? byGen.model : null;
}

function baselineEntry(model, doc) {
  const target = resolveBaselineModel(model, doc);
  if (!target) return null;
  return doc.baselines.find((b) => b.model === target) || null;
}

// 最小二乘:reported ≈ slope·base + intercept,附 R²。
function linfit(points) {
  const n = points.length;
  const sx = points.reduce((a, p) => a + p.base, 0);
  const sy = points.reduce((a, p) => a + p.rep, 0);
  const sxx = points.reduce((a, p) => a + p.base * p.base, 0);
  const sxy = points.reduce((a, p) => a + p.base * p.rep, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  const ssTot = points.reduce((a, p) => a + (p.rep - meanY) ** 2, 0);
  const ssRes = points.reduce((a, p) => a + (p.rep - (slope * p.base + intercept)) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
  return { slope, intercept, r2 };
}

const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function notApplicable(model, reason) {
  return { applicable: false, version: TOKENIZER_FINGERPRINT_VERSION, claimedModel: model || "", reason };
}

// 核验入口。points: [{ id, reportedTokens }] —— 被测渠道对各探针返回的输入 token 数。
// 返回 applicable:false(不适用,附 reason)或 applicable:true(含 slope/r2/status/verdict)。
export function auditTokenizerFingerprint({ model, points } = {}) {
  const doc = loadBaseline();
  if (!doc) return notApplicable(model, "未找到本地分词基线(先跑 pnpm fingerprint:baseline)。");

  const entry = baselineEntry(model, doc);
  if (!entry) return notApplicable(model, `本地无「${model}」所属代的分词基线,无法核验。`);

  const baseById = new Map(entry.probes.map((p) => [p.id, Number(p.inputTokens)]));
  const used = [];
  for (const pt of points || []) {
    const base = baseById.get(pt.id);
    const rep = Number(pt.reportedTokens);
    if (Number.isFinite(base) && base > 0 && Number.isFinite(rep) && rep > 0) used.push({ id: pt.id, base, rep });
  }
  if (used.length < 3) return notApplicable(model, `有效探针不足(${used.length}<3),多为请求失败/无 usage。`);

  const fit = linfit(used);
  if (!fit) return notApplicable(model, "探针 token 数无区分度,无法拟合。");
  const { slope, intercept, r2 } = fit;

  // 判据:以 |slope−1| 为主信号(分词比率),R² 为辅(线性程度)。
  const slopeDev = Math.abs(slope - 1);
  // 退化拟合:对长度各异的探针返回几乎相同的 reported(R² 无定义,或 slope≈0),
  // 说明渠道未按输入长度真实分词 —— 是「常数应答/占位 usage」的指纹,不是有效拟合。
  const degenerate = r2 == null || Math.abs(slope) < 0.01;
  let status;
  let verdict;
  if (degenerate) {
    status = "mismatch";
    verdict = `与「${entry.model}」核验未通过:渠道对 ${used.length} 个不同长度探针返回几乎相同的 input_tokens(slope≈0、R² 无定义),并非按输入真实分词,疑似伪造/占位 usage。`;
  } else if (slopeDev <= 0.05 && r2 >= 0.995) {
    status = "consistent";
    verdict = `与「${entry.model}」分词高度线性一致(slope≈1, R²≈1),符合该代 Claude。`;
  } else if (slopeDev >= 0.15 || r2 < 0.95) {
    status = "mismatch";
    verdict = `与「${entry.model}」分词不一致(slope=${round(slope)}, R²=${round(r2, 4)}),疑似非该代 Claude(挂羊头/换代)。`;
  } else {
    status = "borderline";
    verdict = `与「${entry.model}」基本线性但偏差略大(slope=${round(slope)}, R²=${round(r2, 4)}),建议复核或增加样本。`;
  }
  // 置信度以样本数为基,但退化拟合无区分度 —— 样本再多也不构成有效证据,最高只给 low。
  let confidence = used.length >= 10 ? "high" : used.length >= 6 ? "medium" : "low";
  if (degenerate) confidence = "low";

  return {
    applicable: true,
    version: TOKENIZER_FINGERPRINT_VERSION,
    method: "固定探针输入 token 线性拟合(reported≈slope·base+intercept),对照本地基线",
    claimedModel: model || "",
    baselineModel: entry.model,
    baselineMode: doc.mode || "",
    baselineOfficial: Boolean(doc.sourceOfficial),
    n: used.length,
    slope: round(slope),
    intercept: round(intercept, 1),
    r2: round(r2, 5),
    status,
    degenerate,
    suspicious: status === "mismatch",
    confidence,
    verdict,
    points: used.map((p) => ({ id: p.id, base: p.base, reported: p.rep })),
  };
}
