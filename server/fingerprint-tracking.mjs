// server/fingerprint-tracking.mjs
//
// 模型指纹追踪：把"模型类型识别 & 标称一致性"从一次性检测升级为
//   ① tokenizer 差分信号 ② 横向指纹库（同模型多渠道对照，数据驱动标定）
//   ③ 持续复测（本次 vs 上次，疑似中途偷换）。
//
// 零依赖、零额外请求：tokenizer 信号直接复用准入里**固定文本指纹探针**回报的
//   prompt_tokens——同一段固定文本，不同 tokenizer 切出的 token 数不同，是天然差分探针。
//   取探针两两之差以抵消各家固定的 chat-template 开销，得到对底层 tokenizer 较稳健的信号。
//
// 诚实边界（红线）：所有判定只写"疑似 / 需上游解释 / 不等于证明同一模型"，绝不写"确定"。
//   黑盒探测只给概率判断；量化/微调降级几乎测不出，属盲区。

import { inferModelFamily } from "./model-fingerprint.mjs";
import { recordModelFingerprint, queryLatestFingerprint, queryFingerprintsByModel } from "./db.mjs";

export const FINGERPRINT_TRACKING_VERSION = "2026.06.09";

// 仅这 4 个**基础指纹探针**对所有模型文本固定 → token 数可跨渠道/跨时间对照。
// 家族特化探针文本随家族变化，不纳入 tokenizer 信号。
export const FIXED_TOKENIZER_PROBE_IDS = [
  "fingerprint_instruction_lock",
  "fingerprint_logic_anchor",
  "fingerprint_code_reasoning",
  "fingerprint_context_recall",
];

const REL_DIVERGENCE_THRESHOLD = 0.2; // 差分相对偏离 > 20% 视为 tokenizer 不一致
const MIN_DELTA_MAGNITUDE = 5; // 只比较量级足够（≥5 token）的探针对，避免短文本噪声

const round = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// —— 从准入记录提取信号 ——

export function extractTokenizerSignature(records = []) {
  const sig = {};
  for (const r of records || []) {
    if (FIXED_TOKENIZER_PROBE_IDS.includes(r?.caseId)) {
      const t = Number(r.inputTokens);
      if (Number.isFinite(t) && t > 0) sig[r.caseId] = t;
    }
  }
  return sig;
}

export function extractProbeSignature(records = [], fingerprintSummary = null) {
  const sig = {};
  if (fingerprintSummary?.probes?.length) {
    for (const p of fingerprintSummary.probes) sig[p.id] = Boolean(p.passed);
    return sig;
  }
  for (const r of records || []) {
    if (r?.admission?.probe) sig[r.caseId] = Boolean(r.admission.passed);
  }
  return sig;
}

export function buildFingerprintSnapshot({
  profileId,
  model,
  runId,
  identityCheck,
  records = [],
  fingerprintSummary = null,
  protocol,
  createdAt,
} = {}) {
  return {
    profileId: String(profileId || ""),
    model: String(model || ""),
    runId: String(runId || ""),
    declaredFamily: inferModelFamily(model) || "",
    reportedFamily: identityCheck?.reportedFamily || "",
    identityStatus: identityCheck?.status || "",
    protocol: protocol || "",
    tokenizerSignature: extractTokenizerSignature(records),
    probeSignature: extractProbeSignature(records, fingerprintSummary),
    createdAt: createdAt || null,
  };
}

// —— tokenizer 差分对比 ——

// 探针两两之差（抵消各端固定的 chat-template 开销），只保留共有键。
function deltaPairs(sig = {}) {
  const ids = Object.keys(sig)
    .filter((k) => Number.isFinite(Number(sig[k])))
    .sort();
  const pairs = {};
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pairs[`${ids[i]}__${ids[j]}`] = Number(sig[ids[i]]) - Number(sig[ids[j]]);
    }
  }
  return pairs;
}

export function compareTokenizerSignatures(a = {}, b = {}) {
  const da = deltaPairs(a);
  const db = deltaPairs(b);
  const shared = Object.keys(da).filter((k) => k in db && Math.max(Math.abs(da[k]), Math.abs(db[k])) >= MIN_DELTA_MAGNITUDE);
  if (shared.length === 0) {
    return { comparable: false, sharedPairs: 0, maxRelDivergence: null, divergent: [], verdict: "无足够 token 信号可比" };
  }
  let maxRel = 0;
  const divergent = [];
  for (const k of shared) {
    const x = da[k];
    const y = db[k];
    const denom = Math.max(1, Math.abs(x), Math.abs(y));
    const rel = Math.abs(x - y) / denom;
    if (rel > maxRel) maxRel = rel;
    if (rel > REL_DIVERGENCE_THRESHOLD) divergent.push({ pair: k, a: x, b: y, rel: round(rel) });
  }
  const inconsistent = maxRel > REL_DIVERGENCE_THRESHOLD;
  return {
    comparable: true,
    sharedPairs: shared.length,
    maxRelDivergence: round(maxRel),
    divergent,
    verdict: inconsistent
      ? "tokenizer 切分明显不一致（疑似不同底层模型/tokenizer，需上游解释）"
      : "tokenizer 切分一致",
  };
}

function compareProbeSignatures(a = {}, b = {}) {
  const shared = Object.keys(a || {}).filter((k) => k in (b || {}));
  let flipped = 0;
  for (const k of shared) if (Boolean(a[k]) !== Boolean(b[k])) flipped += 1;
  return { shared: shared.length, flipped };
}

// —— 持续复测：本次 vs 上次（防中途偷换/降级）——

export function detectDrift({ current, previous } = {}) {
  if (!previous) {
    return { status: "baseline", verdict: "已建立指纹基线，后续复测将与此对照。", divergences: [], comparedRunId: null };
  }
  const divergences = [];
  if (current.reportedFamily && previous.reportedFamily && current.reportedFamily !== previous.reportedFamily) {
    divergences.push({
      code: "reported_family_changed",
      detail: `模型自述家族从 ${previous.reportedFamily} 变为 ${current.reportedFamily}`,
      severity: "high",
    });
  }
  if (previous.identityStatus && previous.identityStatus !== "conflict" && current.identityStatus === "conflict") {
    divergences.push({ code: "identity_became_conflict", detail: "标称一致性从非冲突变为冲突", severity: "high" });
  }
  const tokenizer = compareTokenizerSignatures(current.tokenizerSignature, previous.tokenizerSignature);
  if (tokenizer.comparable && tokenizer.divergent.length > 0) {
    divergences.push({
      code: "tokenizer_drift",
      detail: `${tokenizer.verdict}（最大相对偏离 ${tokenizer.maxRelDivergence}）`,
      severity: "high",
    });
  }
  const probes = compareProbeSignatures(current.probeSignature, previous.probeSignature);
  if (probes.flipped >= 2) {
    divergences.push({ code: "probe_behavior_drift", detail: `${probes.flipped} 个指纹探针通过状态翻转`, severity: "medium" });
  }
  const high = divergences.some((d) => d.severity === "high");
  return {
    status: high ? "suspected_swap" : divergences.length ? "minor_drift" : "stable",
    verdict: high
      ? "疑似上游中途更换/降级模型（需上游解释，非铁证）"
      : divergences.length
        ? "出现轻微指纹漂移，建议复测确认。"
        : "与上次指纹一致，未见替换证据（不等于证明同一模型）。",
    comparedRunId: previous.runId || null,
    tokenizer,
    divergences,
  };
}

// —— 横向对照：同模型多渠道（多数派=数据驱动标定）——

export function assessCrossChannel({ current, peers } = {}) {
  const valid = (peers || []).filter((p) => p && p.model);
  if (valid.length === 0) {
    return { status: "insufficient_peers", peerCount: 0, consensusFamily: "", divergences: [], verdict: "暂无同模型其它渠道可横向对照。" };
  }
  const famCounts = {};
  for (const p of valid) if (p.reportedFamily) famCounts[p.reportedFamily] = (famCounts[p.reportedFamily] || 0) + 1;
  const consensusFamily = Object.keys(famCounts).sort((x, y) => famCounts[y] - famCounts[x])[0] || "";

  const divergences = [];
  if (consensusFamily && current.reportedFamily && current.reportedFamily !== consensusFamily) {
    divergences.push({
      code: "family_outlier",
      detail: `本渠道自述 ${current.reportedFamily}，但同模型多数渠道自述 ${consensusFamily}`,
      severity: "high",
    });
  }
  let tokenizerComparedPeers = 0;
  let tokenizerInconsistentPeers = 0;
  for (const p of valid) {
    const t = compareTokenizerSignatures(current.tokenizerSignature, p.tokenizerSignature);
    if (t.comparable) {
      tokenizerComparedPeers += 1;
      if (t.divergent.length > 0) tokenizerInconsistentPeers += 1;
    }
  }
  if (tokenizerComparedPeers >= 1 && tokenizerInconsistentPeers === tokenizerComparedPeers) {
    divergences.push({
      code: "tokenizer_outlier",
      detail: `token 切分与全部 ${tokenizerComparedPeers} 个同模型渠道都不一致，疑似不同底层模型`,
      severity: "high",
    });
  }
  const high = divergences.some((d) => d.severity === "high");
  return {
    status: high ? "outlier" : "consistent_with_peers",
    peerCount: valid.length,
    consensusFamily,
    tokenizerComparedPeers,
    tokenizerInconsistentPeers,
    divergences,
    verdict: high
      ? "本渠道与同模型其它渠道存在显著差异，疑似挂羊头卖狗肉（需上游解释）。"
      : "与同模型其它渠道基本一致，未见明显异常。",
  };
}

// —— 横向 token 诚实度：量化虚报率 ——
// 以"同模型多渠道固定探针 prompt_tokens 的中位数"为数据驱动 ground-truth；
// 用探针两两之差的比值（抵消各端固定模板开销）估出本渠道相对中位基线的**计费倍率**。
// 倍率 ~1.3 → 疑似虚报 ~30%。需 ≥2 个同模型渠道 + 本次 ≥2 个可比探针，否则判基线不足。

function median(nums) {
  const a = nums.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

function consensusTokenizerSignature(peers) {
  const byProbe = {};
  for (const p of peers || []) {
    const sig = p?.tokenizerSignature || {};
    for (const k of FIXED_TOKENIZER_PROBE_IDS) {
      const v = Number(sig[k]);
      if (Number.isFinite(v) && v > 0) (byProbe[k] ||= []).push(v);
    }
  }
  const med = {};
  for (const k of Object.keys(byProbe)) med[k] = median(byProbe[k]);
  return med;
}

export function assessTokenHonesty({ current, peers } = {}) {
  const valid = (peers || []).filter((p) => p && p.tokenizerSignature && Object.keys(p.tokenizerSignature).length);
  const cur = current?.tokenizerSignature || {};
  if (valid.length < 2 || Object.keys(cur).length < 2) {
    return {
      status: "insufficient_baseline",
      peerCount: valid.length,
      verdict: "同模型横向基线不足（需 ≥2 个同模型渠道且本次 ≥2 个 token 探针），暂无法量化虚报率。",
    };
  }
  const med = consensusTokenizerSignature(valid);
  const probes = FIXED_TOKENIZER_PROBE_IDS.filter(
    (k) => Number(cur[k]) > 0 && Number(med[k]) > 0,
  );
  const ratios = [];
  for (let i = 0; i < probes.length; i++) {
    for (let j = i + 1; j < probes.length; j++) {
      const cd = cur[probes[i]] - cur[probes[j]];
      const md = med[probes[i]] - med[probes[j]];
      if (Math.abs(md) >= MIN_DELTA_MAGNITUDE) ratios.push(cd / md);
    }
  }
  if (ratios.length === 0) {
    return { status: "insufficient_baseline", peerCount: valid.length, verdict: "与共识可比的 token 探针差分不足，暂无法量化。" };
  }
  const overReportRatio = median(ratios);
  const sorted = ratios.slice().sort((a, b) => a - b);
  const spread = sorted[sorted.length - 1] - sorted[0];
  const inflationPct = Math.round((overReportRatio - 1) * 100);
  const confidence = valid.length >= 4 && spread < 0.15 ? "high" : valid.length >= 2 && spread < 0.3 ? "medium" : "low";

  const flags = [];
  let status = "consistent_with_baseline";
  let verdict = `token 计费与同模型 ${valid.length} 个渠道中位基线一致（×${round(overReportRatio, 2)}）。`;
  if (overReportRatio > 1.15) {
    status = "suspected_inflation";
    verdict = `疑似按约 ×${round(overReportRatio, 2)} 计费，相对同模型 ${valid.length} 个渠道中位基线虚报约 ${inflationPct}%（需上游解释，非铁证）。`;
    flags.push({ code: "token_inflation_vs_peers", severity: overReportRatio > 1.4 ? "high" : "medium", detail: verdict });
  } else if (overReportRatio < 0.85) {
    status = "below_baseline";
    verdict = `token 计费低于同模型基线（×${round(overReportRatio, 2)}），疑似少计/缓存，需确认。`;
  }
  const recommendation =
    confidence === "low" && status !== "consistent_with_baseline"
      ? "横向样本/一致性不足，结论置信度低，建议增加同模型渠道或多测几次再定。"
      : "";
  return {
    status,
    peerCount: valid.length,
    overReportRatio: round(overReportRatio, 3),
    estimatedInflationPct: inflationPct,
    comparedProbePairs: ratios.length,
    spread: round(spread, 3),
    confidence,
    flags,
    verdict,
    recommendation,
  };
}

// —— 编排：记录快照 + 本次 vs 上次 + 横向对照（best-effort，sqlite 不可用则降级为基线态）——

export async function trackModelFingerprint(snapshot, { path } = {}) {
  let previous = null;
  let peers = [];
  try {
    previous = await queryLatestFingerprint(snapshot.profileId, { excludeRunId: snapshot.runId, path });
  } catch {
    previous = null;
  }
  try {
    peers = await queryFingerprintsByModel(snapshot.model, { excludeProfileId: snapshot.profileId, path });
  } catch {
    peers = [];
  }
  const drift = detectDrift({ current: snapshot, previous });
  const crossChannel = assessCrossChannel({ current: snapshot, peers });
  const tokenHonesty = assessTokenHonesty({ current: snapshot, peers });
  try {
    await recordModelFingerprint(snapshot, { path });
  } catch {
    // best-effort：记录失败不影响本次判定
  }
  return {
    version: FINGERPRINT_TRACKING_VERSION,
    declaredFamily: snapshot.declaredFamily,
    reportedFamily: snapshot.reportedFamily,
    identityStatus: snapshot.identityStatus,
    tokenizerProbeCount: Object.keys(snapshot.tokenizerSignature || {}).length,
    drift,
    crossChannel,
    tokenHonesty,
  };
}
