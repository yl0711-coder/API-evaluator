import assert from "node:assert/strict";
import test from "node:test";

import { runRutAudit, textLengthScore } from "../server/rut-orchestration.mjs";

test("textLengthScore maps text/response to an estimated token count", () => {
  assert.ok(textLengthScore("一段中文回答用于估算") > 0);
  assert.ok(textLengthScore({ responseText: "hello world foo bar" }) > 0);
  assert.equal(textLengthScore(""), 0);
});

test("runRutAudit calls samplers n + n*m times and returns an audit", async () => {
  let targetCalls = 0;
  let baselineCalls = 0;
  const r = await runRutAudit({
    prompts: ["q1", "q2"],
    baselineSamples: 3,
    scoreResponse: (v) => v,
    sampleTarget: async () => {
      targetCalls += 1;
      return 50;
    },
    sampleBaseline: async () => {
      baselineCalls += 1;
      return 50;
    },
  });
  assert.equal(r.allowed, true);
  assert.equal(targetCalls, 2); // n
  assert.equal(baselineCalls, 6); // n*m
  assert.equal(r.callsUsed, 8);
  assert.ok(r.audit);
});

test("runRutAudit blocks over-budget runs WITHOUT sending any request", async () => {
  let calls = 0;
  const r = await runRutAudit({
    prompts: Array.from({ length: 100 }, (_, i) => `q${i}`),
    baselineSamples: 100, // 100 + 10000 = 10100 > default maxCalls 2000
    sampleTarget: async () => {
      calls += 1;
      return 1;
    },
    sampleBaseline: async () => {
      calls += 1;
      return 1;
    },
  });
  assert.equal(r.allowed, false);
  assert.equal(r.callsUsed, 0);
  assert.equal(calls, 0); // 一个请求都没发
  assert.equal(r.audit, null);
});

test("runRutAudit allows over-budget runs only with explicit high tier", async () => {
  const r = await runRutAudit({
    prompts: ["a", "b", "c"],
    baselineSamples: 1000, // 3 + 3000 > 2000
    allowHighTier: true,
    scoreResponse: (v) => v,
    sampleTarget: async () => 50,
    sampleBaseline: async () => 50,
  });
  assert.equal(r.allowed, true);
  assert.ok(r.callsUsed > 2000);
});

test("runRutAudit flags suspected substitution when target sits far outside baseline", async () => {
  const baseline = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  let i = 0;
  const r = await runRutAudit({
    prompts: ["a", "b", "c", "d", "e"],
    baselineSamples: 10,
    scoreResponse: (v) => v,
    sampleTarget: async () => 9999, // 远超基线 → 秩百分位都贴 1 → 非均匀
    sampleBaseline: async () => baseline[i++ % baseline.length],
    maxCalls: 100000,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.audit.suspected, true);
  assert.match(r.audit.verdict, /疑似/);
});

test("runRutAudit: target spread like baseline → no substitution evidence", async () => {
  const baseline = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const targetSeq = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]; // 秩百分位均匀
  let bi = 0;
  let ti = 0;
  const r = await runRutAudit({
    prompts: targetSeq.map((_, k) => `q${k}`),
    baselineSamples: 10,
    scoreResponse: (v) => v,
    sampleTarget: async () => targetSeq[ti++],
    sampleBaseline: async () => baseline[bi++ % baseline.length],
    maxCalls: 100000,
  });
  assert.equal(r.audit.suspected, false);
  assert.match(r.audit.verdict, /未见替换证据/);
});

test("runRutAudit throws without samplers", async () => {
  await assert.rejects(() => runRutAudit({ prompts: ["a"] }), /sampleTarget/);
});
