import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGapFillTaskPayload,
  normalizeGapFillOptions,
  runGapFillQueue,
  summarizeGapFillEstimates,
} from "../src/model-compare-gap-fill.js";

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
    temperature: undefined,
    repeats: 1,
    requestConcurrency: 1,
    fullResponseInReport: false,
    streamRequest: false,
  });
  assert.deepEqual(normalizeGapFillOptions({ maxTokens: "1e3", timeoutMs: "600000.9" }), {
    maxTokens: 1000,
    timeoutMs: 600000,
    temperature: undefined,
    repeats: 1,
    requestConcurrency: 1,
    fullResponseInReport: false,
    streamRequest: false,
  });
});

test("补齐高级设置：温度接受 0 与小数，超范围/非法值回落默认（由后端做权威校验）", () => {
  // 0 是合法温度（完全确定性输出），不能被当成留空
  assert.equal(normalizeGapFillOptions({ temperature: "0" }).temperature, 0);
  assert.equal(normalizeGapFillOptions({ temperature: "0.7" }).temperature, 0.7);
  assert.equal(normalizeGapFillOptions({ temperature: "1" }).temperature, 1);
  assert.equal(normalizeGapFillOptions({ temperature: "2" }).temperature, 2);
  // 留空 / 超范围 / 非数字 → undefined，不写入 payload，走协议默认
  for (const bad of ["", "  ", "2.5", "-1", "abc", null, undefined]) {
    assert.equal(normalizeGapFillOptions({ temperature: bad }).temperature, undefined, `温度 ${JSON.stringify(bad)} 应回落`);
  }
  // 只有填写时才进 payload
  const withTemp = buildGapFillTaskPayload({
    targetId: "target-a",
    scenarioId: "code",
    rawOptions: { temperature: "1" },
    scenarios,
  });
  assert.equal(withTemp.temperature, 1);
  const zeroTemp = buildGapFillTaskPayload({
    targetId: "target-a",
    scenarioId: "code",
    rawOptions: { temperature: "0" },
    scenarios,
  });
  assert.equal(zeroTemp.temperature, 0, "temperature=0 必须进 payload，不能被 falsy 判断吞掉");
  const noTemp = buildGapFillTaskPayload({ targetId: "target-a", scenarioId: "code", rawOptions: {}, scenarios });
  assert.equal("temperature" in noTemp, false);
});

test("补齐高级设置：任一生效设置变化都会生成新幂等键，等价的夹限值复用同一键", () => {
  const defaultPayload = buildGapFillTaskPayload({ targetId: "target-a", scenarioId: "code", rawOptions: {}, scenarios });
  const variations = [
    { maxTokens: 2048 },
    { timeoutMs: 60000 },
    { temperature: 1 },
    { temperature: 0 },
    { repeats: 2 },
    { requestConcurrency: 2 },
    { fullResponseInReport: true },
    { streamRequest: true },
  ];
  for (const rawOptions of variations) {
    const payload = buildGapFillTaskPayload({ targetId: "target-a", scenarioId: "code", rawOptions, scenarios });
    assert.notEqual(payload.idempotencyKey, defaultPayload.idempotencyKey);
  }
  // 换温度重跑必须是新任务：否则会被幂等键判成同一次而直接复用旧温度的结果
  const tempOne = buildGapFillTaskPayload({ targetId: "target-a", scenarioId: "code", rawOptions: { temperature: 1 }, scenarios });
  const tempZero = buildGapFillTaskPayload({ targetId: "target-a", scenarioId: "code", rawOptions: { temperature: 0 }, scenarios });
  assert.notEqual(tempOne.idempotencyKey, tempZero.idempotencyKey);
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

test("补齐队列：请求取消后停止后续场景，不把被取消的当前任务算作失败", async () => {
  const jobs = [{ id: "first" }, { id: "second" }, { id: "third" }];
  const started = [];
  let cancellationRequested = false;
  const outcome = await runGapFillQueue({
    jobs,
    onJobStart: (job) => started.push(job.id),
    isCancellationRequested: () => cancellationRequested,
    runJob: async () => {
      cancellationRequested = true;
      throw new Error("任务已取消。");
    },
  });

  assert.deepEqual(started, ["first"]);
  assert.deepEqual(outcome, { cancelled: true, completed: 0, failures: [] });
});

test("补齐队列：已完成的场景保留结果，取消前未开始的场景不会提交", async () => {
  const jobs = [{ id: "first" }, { id: "second" }, { id: "third" }];
  const started = [];
  let cancellationRequested = false;
  const outcome = await runGapFillQueue({
    jobs,
    onJobStart: (job) => started.push(job.id),
    isCancellationRequested: () => cancellationRequested,
    runJob: async (job) => {
      if (job.id === "first") return;
      cancellationRequested = true;
    },
  });

  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual(outcome, { cancelled: true, completed: 2, failures: [] });
});
