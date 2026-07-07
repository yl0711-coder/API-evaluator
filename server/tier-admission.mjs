// server/tier-admission.mjs
//
// 档位降级判别「接入准入」的薄封装：把档位电池当成"多跑几次的判别 case"塞进准入流程，
//   从校准参考派生在线判别题（只取判别度达标的）、归并作答、调似然比分类器，
//   给出"声称档 vs 行为最像档"。仅 Claude 家族 + 能定档 + 有匹配档位参考时才启用，否则整套跳过。
//
// 设计：在线电池**数据驱动**——只跑参考里 keep=true 的题，自动跟随离线校准结果（校准换了题，
//   线上自动跟着换）。在线用与离线不同的 seed，避免和参考用同一批实例自我印证。

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildClaudeTierProbes, gradeTierProbe, TIER_PROBE_RUNTIME } from "./tier-probes-claude.mjs";
import { aggregateObserved, classifyChannelTier, loadTierReference, summarizeTierForPurity } from "./tier-discrimination.mjs";
import { inferModelFamily } from "./model-fingerprint.mjs";
import { isTruncatedFinish } from "./protocols.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REFERENCE_PATH = resolve(HERE, "../scripts/claude-tier-reference.json");
const ONLINE_REPEATS = 3; // 每题在线重复数（多实例求稳；总请求 = keep题数 × 此值）
const ONLINE_SEED = 911; // 与离线校准 seed 不同，避免线上线下用同一批实例

export { summarizeTierForPurity };

// 模型名 → Claude 档位。认不准返回 null。
export function inferClaudeTier(modelName) {
  const m = String(modelName || "").toLowerCase();
  if (!/claude|anthropic/.test(m)) return null;
  if (/opus/.test(m)) return "opus";
  if (/sonnet/.test(m)) return "sonnet";
  if (/haiku/.test(m)) return "haiku";
  return null;
}

// 档位上下文：仅当 Claude + 能定档 + 参考已校准该档，才返回 {reference, claimedTier}；否则 null（跳过）。
export function loadTierContext(modelName, { path = DEFAULT_REFERENCE_PATH } = {}) {
  if (inferModelFamily(modelName) !== "claude") return null;
  const claimedTier = inferClaudeTier(modelName);
  if (!claimedTier) return null;
  let reference;
  try {
    reference = loadTierReference(path);
  } catch {
    return null; // 没有参考文件 → 不跑，避免无谓请求
  }
  if (!Array.isArray(reference?.calibratedTiers) || !reference.calibratedTiers.includes(claimedTier)) return null;
  return { reference, claimedTier };
}

// 从参考的判别度结果派生在线电池：只取 keep=true 的题（"cs_json@L1" → {id,level}）。
function deriveOnlineBattery(reference, repeats) {
  const battery = [];
  for (const d of reference.discrimination || []) {
    if (!d.keep) continue;
    const m = /^(.+)@L(\d+)$/.exec(d.item);
    if (m) battery.push({ id: m[1], level: Number(m[2]), samples: repeats });
  }
  return battery;
}

// 生成在线档位判别 case（接 buildAdmissionCases）。无可用题 → 空数组。
export function buildTierProbeCases(reference, { repeats = ONLINE_REPEATS, seed = ONLINE_SEED } = {}) {
  const battery = deriveOnlineBattery(reference, repeats);
  if (!battery.length) return [];
  return buildClaudeTierProbes(seed, battery).map((p) => ({
    id: `tier_${p.id}`,
    name: `档位判别 ${p.itemId} L${p.level}`,
    prompt: p.prompt,
    // 复现校准运行参数：输出封顶 256 token（与离线参考一致），避免硬推理题在线无限输出
    //   撞穿超时 →（我们记 timeout / 中转记 502/504），并保证在线行为对齐参考分布。
    maxTokens: TIER_PROBE_RUNTIME.maxTokens,
    tier: { itemId: p.itemId, level: p.level, expected: p.expected },
  }));
}

// 判一道在线档位 case（接 evaluateAdmissionCase）。tier:true 是后续归并的标记。
export function evaluateTierCase(testCase, text) {
  const { itemId, level, expected } = testCase.tier;
  const passed = gradeTierProbe(itemId, text, expected);
  return {
    passed,
    probe: true,
    tier: true,
    itemId,
    level,
    issue: passed ? `档位判别题 ${itemId}(L${level}) 通过。` : `档位判别题 ${itemId}(L${level}) 未通过。`,
  };
}

// 从准入记录抓档位 case → 分类（接 buildAdmissionSummary）。无上下文/无记录 → null。
// 混淆项防护：
//   - HTTP 失败的请求不带 tier:true（evaluateAdmissionCase 早退），天然被排除，不计入能力分母。
//   - 输出被截断的请求（max_tokens 过小/推理占满预算）会让真旗舰严格判分失败 → 冤判降级，
//     这里按 finishReason 剔除，不计入分母；全被截断则判"不确定:截断"，提示调大 max_tokens。
export function classifyTierFromRecords(records, tierContext, options = {}) {
  if (!tierContext) return null;
  const all = (records || []).filter((r) => r.admission?.tier);
  if (!all.length) return null;

  const truncated = all.filter((r) => isTruncatedFinish(r.finishReason));
  const valid = all.filter((r) => !isTruncatedFinish(r.finishReason));

  if (!valid.length) {
    return {
      version: "tier-discrimination",
      claimedTier: tierContext.claimedTier,
      likelyTier: null,
      status: "inconclusive_truncated",
      verdict: `全部 ${truncated.length} 道档位判别题输出被截断（max_tokens 过小或推理占满预算），无法判定档位，请调大被测渠道 max_tokens 后重测。`,
      confidence: "low",
      truncatedProbes: truncated.length,
      caveats: ["输出截断导致档位判别无效，未作降级判定。"],
    };
  }

  const observed = aggregateObserved(
    valid.map((r) => ({ itemId: r.admission.itemId, level: r.admission.level, passed: r.admission.passed })),
  );
  const result = classifyChannelTier({ reference: tierContext.reference, observed, claimedTier: tierContext.claimedTier, options });
  if (truncated.length) {
    result.truncatedProbes = truncated.length;
    result.caveats = [
      ...(result.caveats || []),
      `${truncated.length} 道判别题输出被截断已剔除（不计入能力分母）；占比偏高时建议调大 max_tokens 重测。`,
    ];
    if (truncated.length >= valid.length) result.confidence = "low"; // 截断过半，结论存疑
  }
  return result;
}
