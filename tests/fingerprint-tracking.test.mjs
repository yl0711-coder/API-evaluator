import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractTokenizerSignature,
  extractProbeSignature,
  buildFingerprintSnapshot,
  compareTokenizerSignatures,
  detectDrift,
  assessCrossChannel,
  FIXED_TOKENIZER_PROBE_IDS,
} from "../server/fingerprint-tracking.mjs";

// 一组"基准 tokenizer"信号（固定探针的 prompt_tokens）。
const SIG_A = {
  fingerprint_instruction_lock: 40,
  fingerprint_logic_anchor: 30,
  fingerprint_code_reasoning: 120,
  fingerprint_context_recall: 70,
};
// 同一 tokenizer、不同端：每条加了固定 chat-template 开销 +6 → 差分应抵消 → 判一致。
const SIG_A_SAME_TOKENIZER = {
  fingerprint_instruction_lock: 46,
  fingerprint_logic_anchor: 36,
  fingerprint_code_reasoning: 126,
  fingerprint_context_recall: 76,
};
// 明显不同的 tokenizer：长文本 token 数差异很大 → 差分发散 → 判不一致。
const SIG_B_OTHER_TOKENIZER = {
  fingerprint_instruction_lock: 55,
  fingerprint_logic_anchor: 33,
  fingerprint_code_reasoning: 240,
  fingerprint_context_recall: 95,
};

test("extractTokenizerSignature 只取固定探针且 token>0", () => {
  const records = [
    { caseId: "fingerprint_instruction_lock", inputTokens: 40 },
    { caseId: "fingerprint_code_reasoning", inputTokens: 120 },
    { caseId: "fingerprint_logic_anchor", inputTokens: 0 }, // 0 token → 丢弃
    { caseId: "json_structure", inputTokens: 99 }, // 非指纹探针 → 丢弃
    { caseId: "fingerprint_context_recall", inputTokens: null }, // 无 usage → 丢弃
  ];
  const sig = extractTokenizerSignature(records);
  assert.deepEqual(sig, { fingerprint_instruction_lock: 40, fingerprint_code_reasoning: 120 });
  for (const k of Object.keys(sig)) assert.ok(FIXED_TOKENIZER_PROBE_IDS.includes(k));
});

test("extractProbeSignature 优先用 fingerprintSummary.probes", () => {
  const summary = { probes: [{ id: "p1", passed: true }, { id: "p2", passed: false }] };
  assert.deepEqual(extractProbeSignature([], summary), { p1: true, p2: false });
  const records = [{ caseId: "px", admission: { probe: true, passed: true } }];
  assert.deepEqual(extractProbeSignature(records, null), { px: true });
});

test("compareTokenizerSignatures：同 tokenizer（仅固定开销差）判一致", () => {
  const r = compareTokenizerSignatures(SIG_A, SIG_A_SAME_TOKENIZER);
  assert.equal(r.comparable, true);
  assert.equal(r.divergent.length, 0);
  assert.match(r.verdict, /一致/);
});

test("compareTokenizerSignatures：不同 tokenizer 判不一致", () => {
  const r = compareTokenizerSignatures(SIG_A, SIG_B_OTHER_TOKENIZER);
  assert.equal(r.comparable, true);
  assert.ok(r.divergent.length > 0);
  assert.ok(r.maxRelDivergence > 0.2);
  assert.match(r.verdict, /不一致/);
});

test("compareTokenizerSignatures：信号不足时 comparable=false", () => {
  assert.equal(compareTokenizerSignatures({}, {}).comparable, false);
  assert.equal(compareTokenizerSignatures({ fingerprint_logic_anchor: 30 }, {}).comparable, false);
});

test("detectDrift：无上次 → 建立基线", () => {
  const current = buildFingerprintSnapshot({ profileId: "c1", model: "claude-x", runId: "r1" });
  const d = detectDrift({ current, previous: null });
  assert.equal(d.status, "baseline");
});

test("detectDrift：自述家族变化 → 疑似偷换(high)", () => {
  const current = { reportedFamily: "openai", identityStatus: "conflict", tokenizerSignature: SIG_A, probeSignature: {} };
  const previous = { reportedFamily: "claude", identityStatus: "aligned", tokenizerSignature: SIG_A, probeSignature: {}, runId: "r0" };
  const d = detectDrift({ current, previous });
  assert.equal(d.status, "suspected_swap");
  assert.match(d.verdict, /疑似/);
  assert.ok(d.divergences.some((x) => x.code === "reported_family_changed"));
  assert.equal(d.comparedRunId, "r0");
});

test("detectDrift：tokenizer 漂移 → 疑似偷换", () => {
  const current = { reportedFamily: "claude", identityStatus: "aligned", tokenizerSignature: SIG_B_OTHER_TOKENIZER, probeSignature: {} };
  const previous = { reportedFamily: "claude", identityStatus: "aligned", tokenizerSignature: SIG_A, probeSignature: {}, runId: "r0" };
  const d = detectDrift({ current, previous });
  assert.equal(d.status, "suspected_swap");
  assert.ok(d.divergences.some((x) => x.code === "tokenizer_drift"));
});

test("detectDrift：一切稳定 → stable", () => {
  const snap = { reportedFamily: "claude", identityStatus: "aligned", tokenizerSignature: SIG_A, probeSignature: { p1: true } };
  const d = detectDrift({ current: snap, previous: { ...snap, runId: "r0" } });
  assert.equal(d.status, "stable");
  assert.match(d.verdict, /未见替换证据/);
});

test("assessCrossChannel：与同模型多渠道一致", () => {
  const current = { model: "gpt-x", reportedFamily: "openai", tokenizerSignature: SIG_A };
  const peers = [
    { model: "gpt-x", reportedFamily: "openai", tokenizerSignature: SIG_A_SAME_TOKENIZER },
    { model: "gpt-x", reportedFamily: "openai", tokenizerSignature: SIG_A },
  ];
  const r = assessCrossChannel({ current, peers });
  assert.equal(r.status, "consistent_with_peers");
  assert.equal(r.consensusFamily, "openai");
});

test("assessCrossChannel：自述家族与多数渠道不符 → outlier", () => {
  const current = { model: "gpt-x", reportedFamily: "claude", tokenizerSignature: SIG_A };
  const peers = [
    { model: "gpt-x", reportedFamily: "openai", tokenizerSignature: SIG_A },
    { model: "gpt-x", reportedFamily: "openai", tokenizerSignature: SIG_A },
  ];
  const r = assessCrossChannel({ current, peers });
  assert.equal(r.status, "outlier");
  assert.ok(r.divergences.some((x) => x.code === "family_outlier"));
});

test("assessCrossChannel：token 切分与全部同模型渠道都不一致 → outlier", () => {
  const current = { model: "gpt-x", reportedFamily: "openai", tokenizerSignature: SIG_B_OTHER_TOKENIZER };
  const peers = [
    { model: "gpt-x", reportedFamily: "openai", tokenizerSignature: SIG_A },
    { model: "gpt-x", reportedFamily: "openai", tokenizerSignature: SIG_A_SAME_TOKENIZER },
  ];
  const r = assessCrossChannel({ current, peers });
  assert.equal(r.status, "outlier");
  assert.ok(r.divergences.some((x) => x.code === "tokenizer_outlier"));
});

test("assessCrossChannel：无同模型渠道 → insufficient_peers", () => {
  const r = assessCrossChannel({ current: { model: "x", tokenizerSignature: {} }, peers: [] });
  assert.equal(r.status, "insufficient_peers");
});

test("DB 往返 + trackModelFingerprint 端到端：基线→偷换", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "fp-track-test-"));
  process.env.EVALUATOR_DATA_DIR = dataDir;
  try {
    const db = await import(`../server/db.mjs?case=${Date.now()}`);
    if (!(await db.isSqliteAvailable())) return; // 环境无 node:sqlite 则跳过 DB 部分
    const tracking = await import(`../server/fingerprint-tracking.mjs?case=${Date.now()}`);

    const base = {
      profileId: "chan-1",
      model: "claude-sonnet-x",
      reportedFamily: "claude",
      identityStatus: "aligned",
      protocol: "claude_messages",
      tokenizerSignature: SIG_A,
      probeSignature: { p1: true },
    };
    const first = await tracking.trackModelFingerprint({ ...base, runId: "run-1", createdAt: new Date().toISOString() });
    assert.equal(first.drift.status, "baseline"); // 首次无上次

    // 同渠道第二次，tokenizer 大变 → 疑似偷换
    const second = await tracking.trackModelFingerprint({
      ...base,
      runId: "run-2",
      tokenizerSignature: SIG_B_OTHER_TOKENIZER,
      reportedFamily: "openai",
      createdAt: new Date().toISOString(),
    });
    assert.equal(second.drift.status, "suspected_swap");

    // 另一渠道也挂同 model 但 token 切分与本渠道不同 → 对 run-1 风格的新渠道做横向判定
    const peerRows = await db.queryFingerprintsByModel("claude-sonnet-x", { excludeProfileId: "chan-1" });
    assert.equal(peerRows.length, 0); // 目前只有 chan-1 的数据
  } finally {
    delete process.env.EVALUATOR_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});
