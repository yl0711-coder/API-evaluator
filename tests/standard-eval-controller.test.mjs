import assert from "node:assert/strict";
import test from "node:test";

import { normalizeQuickVerifyResult, nextSubmitNonce } from "../src/standard-eval-controller.js";

// 标准评测第①步"快速测试"改调 /api/tests/quick-verify（与高级测试里的"快速测试"页同一个接口）后，
// 返回形状从旧版 /api/tests/quick 的单请求 {success,statusCode,totalMs,responseSummary} 变成了一整套
// 快检汇总（cases[]/verdict/successRate...）。这里锁定 normalizeQuickVerifyResult 的映射规则，防止
// 以后改字段名却没同步这层适配，导致标准评测把「指纹探针小问题」误判成「连不通」。
test("normalizeQuickVerifyResult：连通探针通过 → success=true，不因标称冲突之类的次要异常拦截", () => {
  const result = {
    successRate: 0.8,
    avgTotalMs: 120,
    verdict: { title: "观察：有需留意项", reasons: ["模型未能明确自述身份"] },
    cases: [{ id: "connectivity", passed: true, statusCode: 200, totalMs: 90, issue: "连通正常。" }],
  };
  const quick = normalizeQuickVerifyResult(result);
  assert.equal(quick.success, true);
  assert.equal(quick.statusCode, 200);
  assert.equal(quick.totalMs, 90);
  assert.equal(quick.normalizedError, null);
});

test("normalizeQuickVerifyResult：连通探针失败 → success=false，带上失败原因", () => {
  const result = {
    successRate: 0,
    verdict: { title: "可疑：建议人工复核", reasons: ["连通失败：auth_failed"] },
    cases: [{ id: "connectivity", passed: false, statusCode: 401, totalMs: 50, issue: "认证失败。" }],
  };
  const quick = normalizeQuickVerifyResult(result);
  assert.equal(quick.success, false);
  assert.equal(quick.statusCode, 401);
  assert.equal(quick.normalizedError, "认证失败。");
});

test("normalizeQuickVerifyResult：没有 connectivity 分项时按 successRate 兜底判定", () => {
  assert.equal(normalizeQuickVerifyResult({ successRate: 1, cases: [] }).success, true);
  assert.equal(normalizeQuickVerifyResult({ successRate: 0, cases: [] }).success, false);
  assert.equal(normalizeQuickVerifyResult(null).success, false);
});

// 一键标准准入是最贵的流程。若 POST /api/tasks 已到达后端、任务建好并开始真实计费，但响应在回程
// 丢了，前端会报「失败」诱使用户再点一次 → 双花。对策是同一次提交沿用同一个 idempotencyKey，
// 让服务端把重试认成重试（server/task-manager.mjs 的 taskDedupKey）。这里锁住 nonce 的取舍规则。
test("nextSubmitNonce：同一次提交的重试沿用同一个 key（防重复计费）", () => {
  const signature = JSON.stringify([["p1"], ["claude-sonnet-5"], true, ""]);
  const first = nextSubmitNonce(null, signature);
  assert.ok(first.key.startsWith("standard-eval:"), `key 应带业务前缀，实际 ${first.key}`);
  // 创建请求失败后用户再点一次：签名没变 → 必须是同一个 key，否则服务端认不出是重试。
  const retry = nextSubmitNonce(first, signature);
  assert.equal(retry.key, first.key, "同一次提交的重试不应换 key");
});

test("nextSubmitNonce：改了要测什么就换新 key（否则会拿回上一次的旧任务）", () => {
  const signature = JSON.stringify([["p1"], ["claude-sonnet-5"], true, ""]);
  const first = nextSubmitNonce(null, signature);
  // 用户换了被测模型后重新提交——这是一次全新的提交，绝不能被服务端当成重试而返回旧任务。
  const changed = nextSubmitNonce(first, JSON.stringify([["p2"], ["claude-opus-4-8"], true, ""]));
  assert.notEqual(changed.key, first.key, "签名变了必须换新 key");
  assert.notEqual(changed.signature, first.signature);
});

test("nextSubmitNonce：每次全新提交的 key 互不相同", () => {
  const signature = JSON.stringify([["p1"], ["claude-sonnet-5"], true, ""]);
  // 任务建好后前端会把 pending 清成 null（重试窗口关闭），此后再提交属于用户主动重跑。
  const keys = new Set([nextSubmitNonce(null, signature).key, nextSubmitNonce(null, signature).key]);
  assert.equal(keys.size, 2, "主动重跑应拿到不同的 key，才能真正建出新任务");
});
