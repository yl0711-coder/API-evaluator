import assert from "node:assert/strict";
import test from "node:test";

import { assessTokenHonesty } from "../server/fingerprint-tracking.mjs";
import { auditBillingDimensions, auditRunTokenUsage } from "../server/token-auditor.mjs";

// 同模型多渠道的"诚实"基线（固定探针 prompt_tokens；带不同固定模板开销）。
const PEER_A = { tokenizerSignature: { fingerprint_instruction_lock: 40, fingerprint_logic_anchor: 30, fingerprint_code_reasoning: 120, fingerprint_context_recall: 70 } };
const PEER_B = { tokenizerSignature: { fingerprint_instruction_lock: 44, fingerprint_logic_anchor: 34, fingerprint_code_reasoning: 124, fingerprint_context_recall: 74 } };
const PEER_C = { tokenizerSignature: { fingerprint_instruction_lock: 38, fingerprint_logic_anchor: 28, fingerprint_code_reasoning: 118, fingerprint_context_recall: 68 } };

test("assessTokenHonesty：与同模型基线一致 → consistent", () => {
  const current = { tokenizerSignature: { fingerprint_instruction_lock: 41, fingerprint_logic_anchor: 31, fingerprint_code_reasoning: 121, fingerprint_context_recall: 71 } };
  const r = assessTokenHonesty({ current, peers: [PEER_A, PEER_B, PEER_C] });
  assert.equal(r.status, "consistent_with_baseline");
  assert.ok(r.overReportRatio > 0.9 && r.overReportRatio < 1.1);
});

test("assessTokenHonesty：proportional 灌水 → 量化虚报率", () => {
  // current 的 token 差分约为基线的 1.3 倍（按 ×1.3 计费），抵消固定开销后仍现形。
  const base = PEER_A.tokenizerSignature;
  const current = {
    tokenizerSignature: {
      fingerprint_instruction_lock: Math.round(base.fingerprint_instruction_lock * 1.3) + 5,
      fingerprint_logic_anchor: Math.round(base.fingerprint_logic_anchor * 1.3) + 5,
      fingerprint_code_reasoning: Math.round(base.fingerprint_code_reasoning * 1.3) + 5,
      fingerprint_context_recall: Math.round(base.fingerprint_context_recall * 1.3) + 5,
    },
  };
  const r = assessTokenHonesty({ current, peers: [PEER_A, PEER_B, PEER_C] });
  assert.equal(r.status, "suspected_inflation");
  assert.ok(r.overReportRatio >= 1.2, `ratio=${r.overReportRatio}`);
  assert.ok(r.estimatedInflationPct >= 20);
  assert.ok(r.flags.some((f) => f.code === "token_inflation_vs_peers"));
});

test("assessTokenHonesty：同模型渠道不足 → insufficient_baseline", () => {
  const current = { tokenizerSignature: PEER_A.tokenizerSignature };
  assert.equal(assessTokenHonesty({ current, peers: [PEER_A] }).status, "insufficient_baseline");
  assert.equal(assessTokenHonesty({ current, peers: [] }).status, "insufficient_baseline");
});

test("auditBillingDimensions：非推理模型却计推理 token → 标记", () => {
  const records = [
    { reasoningTokens: 500, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 },
    { reasoningTokens: 400, outputTokens: 120, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ];
  const r = auditBillingDimensions(records, { model: "gpt-4o-mini" });
  assert.equal(r.looksLikeReasoningModel, false);
  assert.ok(r.flags.some((f) => f.code === "reasoning_billed_nonreasoning_model"));
  assert.ok(r.flags.some((f) => f.code === "reasoning_disproportionate_agg"));
  assert.equal(r.reasoningTokens, 900);
});

test("auditBillingDimensions：推理模型计推理 token 属正常", () => {
  const records = [{ reasoningTokens: 800, outputTokens: 900, cacheCreationTokens: 0, cacheReadTokens: 0 }];
  const r = auditBillingDimensions(records, { model: "o3-mini" });
  assert.equal(r.looksLikeReasoningModel, true);
  assert.ok(!r.flags.some((f) => f.code === "reasoning_billed_nonreasoning_model"));
});

test("auditBillingDimensions：缓存只写不读 → 提示", () => {
  const records = [{ cacheCreationTokens: 2000, cacheReadTokens: 0, outputTokens: 50, reasoningTokens: 0 }];
  const r = auditBillingDimensions(records, { model: "claude-sonnet-x" });
  assert.ok(r.flags.some((f) => f.code === "cache_write_no_read"));
});

test("auditRunTokenUsage：自适应置信随样本量提升", () => {
  const sample = { estimatedOutputTokens: 100, reportedOutputTokens: 100, estimatedInputTokens: 50, reportedInputTokens: 50 };
  const small = auditRunTokenUsage(Array.from({ length: 5 }, () => sample));
  const big = auditRunTokenUsage(Array.from({ length: 60 }, () => sample));
  assert.equal(small.confidence, "low");
  assert.equal(big.confidence, "high");
});

test("auditRunTokenUsage：样本少且临界 → 给出补测建议", () => {
  // 输出比值约 1.5（介于 0.85*1.6=1.36 与 1.6 之间）→ borderline，且样本少
  const sample = { estimatedOutputTokens: 100, reportedOutputTokens: 150, estimatedInputTokens: 50, reportedInputTokens: 50 };
  const r = auditRunTokenUsage(Array.from({ length: 6 }, () => sample));
  assert.ok(r.recommendation && /建议/.test(r.recommendation), r.recommendation);
});
