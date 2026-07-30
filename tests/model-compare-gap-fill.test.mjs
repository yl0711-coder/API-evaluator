import assert from "node:assert/strict";
import test from "node:test";
import { buildGapFillTaskPayload, normalizeGapFillOptions, summarizeGapFillEstimates } from "../src/model-compare-gap-fill.js";

const scenarios = [
  { id: "code", category: "coding" },
  { id: "long", category: "long_context" },
];

test("补齐高级设置：默认值与场景测试一致，留空覆盖不写入 payload", () => {
  const payload = buildGapFillTaskPayload({ targetId: "target-a", scenarioId: "code", rawOptions: {}, scenarios });
  assert.deepEqual(payload.profileIds, ["target-a"]);
  assert.deepEqual(payload.scenarioIds, ["code"]);
  assert.equal(payload.repeats, 1);
  assert.equal(payload.requestConcurrency, 1);
  assert.equal(payload.fullResponseInReport, false);
  assert.equal(payload.streamRequest, false);
  assert.equal("maxTokens" in payload, false);
  assert.equal("timeoutMs" in payload, false);
  assert.equal(payload.predicted.requests, 1);
  assert.equal(payload.predicted.highTokens, 3000);
});

test("补齐高级设置：覆盖值、布尔选项和预测消耗会传给单项任务", () => {
  const payload = buildGapFillTaskPayload({
    targetId: "target-a",
    scenarioId: "long",
    rawOptions: {
      maxTokens: "8192",
      timeoutMs: "90000",
      repeats: "3",
      requestConcurrency: "2",
      fullResponseInReport: true,
      streamRequest: "1",
    },
    scenarios,
  });
  assert.equal(payload.maxTokens, 8192);
  assert.equal(payload.timeoutMs, 90000);
  assert.equal(payload.repeats, 3);
  assert.equal(payload.requestConcurrency, 2);
  assert.equal(payload.fullResponseInReport, true);
  assert.equal(payload.streamRequest, true);
  assert.equal(payload.predicted.requests, 3);
  assert.equal(payload.predicted.highTokens, 30000);
});

test("补齐高级设置：非法输入回落默认值，数值覆盖与场景测试后端按同一规则取整夹限", () => {
  const fallback = normalizeGapFillOptions({ maxTokens: "0", timeoutMs: "invalid", repeats: "9", requestConcurrency: "3" });
  assert.deepEqual(fallback, {
    maxTokens: undefined,
    timeoutMs: undefined,
    repeats: 1,
    requestConcurrency: 1,
    fullResponseInReport: false,
    streamRequest: false,
  });
  assert.deepEqual(normalizeGapFillOptions({ maxTokens: "1e3", timeoutMs: "600000.9" }), {
    maxTokens: 1000,
    timeoutMs: 600000,
    repeats: 1,
    requestConcurrency: 1,
    fullResponseInReport: false,
    streamRequest: false,
  });
});

test("补齐高级设置：任一生效设置变化都会生成新幂等键，等价的夹限值复用同一键", () => {
  const defaultPayload = buildGapFillTaskPayload({ targetId: "target-a", scenarioId: "code", rawOptions: {}, scenarios });
  const variations = [
    { maxTokens: 2048 },
    { timeoutMs: 60000 },
    { repeats: 2 },
    { requestConcurrency: 2 },
    { fullResponseInReport: true },
    { streamRequest: true },
  ];
  for (const rawOptions of variations) {
    const payload = buildGapFillTaskPayload({ targetId: "target-a", scenarioId: "code", rawOptions, scenarios });
    assert.notEqual(payload.idempotencyKey, defaultPayload.idempotencyKey);
  }
  const clamped = buildGapFillTaskPayload({ targetId: "target-a", scenarioId: "code", rawOptions: { maxTokens: 999999 }, scenarios });
  const maximum = buildGapFillTaskPayload({ targetId: "target-a", scenarioId: "code", rawOptions: { maxTokens: 32768 }, scenarios });
  assert.equal(clamped.idempotencyKey, maximum.idempotencyKey);
});

test("补齐高级设置：多项任务的确认预估按重复次数汇总", () => {
  const first = buildGapFillTaskPayload({ targetId: "target-a", scenarioId: "code", rawOptions: { repeats: 2 }, scenarios });
  const second = buildGapFillTaskPayload({ targetId: "target-b", scenarioId: "long", rawOptions: { repeats: 2 }, scenarios });
  const total = summarizeGapFillEstimates([first, second]);
  assert.deepEqual(total, { requests: 4, lowTokens: 10000, highTokens: 26000, risk: "中高" });
});
